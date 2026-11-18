from __future__ import annotations

import hashlib
from collections.abc import Iterator, Sequence
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

from . import metadata
from .errors import IntegrityError, SelectionError, WarehouseError
from .filters import expression


class Warehouse:
    """Read published immutable snapshots without a collector service or SQLite connection."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise WarehouseError(f"warehouse directory does not exist: {self.root}")

    def list_tables(self) -> list[str]:
        return sorted(metadata.catalog(self.root))

    def list_repositories(self, table: str) -> list[dict]:
        tables = metadata.catalog(self.root)
        if not isinstance(table, str) or table not in tables:
            raise SelectionError(f"table is not published: {table!r}")
        entry = tables[table]
        return [
            {"repository_id": key, "path": item["path"], "default": key == entry.get("default_repository")}
            for key, item in sorted(entry["repositories"].items())
        ]

    def _snapshot(self, table, repository_id, snapshot_id):
        root, selected = metadata.repository(self.root, table, repository_id)
        manifest, schema = metadata.load_snapshot(root, table, snapshot_id)
        return root, selected, manifest, schema

    def describe(
        self, table: str, *, repository_id: str | None = None, snapshot_id: str | None = None,
    ) -> dict:
        _, selected, manifest, _ = self._snapshot(table, repository_id, snapshot_id)
        return {
            "table": table, "repository_id": selected, "snapshot_id": manifest["snapshot_id"],
            "created_at": manifest.get("created_at"), "schema": manifest["schema"], "rows": manifest["rows"],
            "storage_layout": manifest["storage_layout"],
            "date_column": manifest.get("date_column"), "date_semantics": manifest.get("date_semantics"),
            "field_encodings": manifest.get("field_encodings", {}),
            "coverage": manifest.get("coverage", "not_proven"),
            "variants": metadata.request_variants(manifest),
        }

    def read_batches(
        self, filename: str, cols: Sequence[str] | None = None, filters: Sequence | None = None, *,
        repository_id: str | None = None, snapshot_id: str | None = None, variant_id: str | None = None,
        batch_size: int = 65_536, verify: bool = True,
    ) -> pa.RecordBatchReader:
        """Pin the snapshot now; stream Arrow batches with AND filters on stored field values."""
        if type(batch_size) is not int or batch_size <= 0:
            raise SelectionError("batch_size must be a positive integer")
        if type(verify) is not bool:
            raise SelectionError("verify must be a boolean")
        root, repository, manifest, schema = self._snapshot(filename, repository_id, snapshot_id)
        if cols is None:
            columns = schema.names
        elif (
            not isinstance(cols, (list, tuple)) or not cols
            or any(not isinstance(name, str) or name not in schema.names for name in cols)
            or len(set(cols)) != len(cols)
        ):
            raise SelectionError("cols must be a non-empty list of unique column names from the table")
        else:
            columns = list(cols)
        predicate = expression(schema, filters)
        files, variant = metadata.selected_files(manifest, variant_id)
        lineage = {
            b"warehouse.table": filename.encode(),
            b"warehouse.repository_id": repository.encode(),
            b"warehouse.snapshot_id": manifest["snapshot_id"].encode(),
        }
        if variant is not None:
            lineage[b"warehouse.variant_id"] = variant.encode()
        output_schema = pa.schema([schema.field(name) for name in columns], metadata=lineage)

        def batches() -> Iterator[pa.RecordBatch]:
            for item in files:
                path = metadata.contained(root, item["file"])
                try:
                    if verify:
                        with path.open("rb") as stream:
                            if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                                raise IntegrityError(f"data checksum mismatch: {path}")
                    if not pq.read_schema(path).equals(schema, check_metadata=False):
                        raise IntegrityError(f"data schema does not match manifest: {path}")
                    if pq.read_metadata(path).num_rows != item["rows"]:
                        raise IntegrityError(f"data row count does not match manifest: {path}")
                    dataset = ds.dataset(str(path), schema=schema, format="parquet")
                    scanner = dataset.scanner(
                        columns=columns, filter=predicate, batch_size=batch_size,
                        batch_readahead=1, fragment_readahead=1, use_threads=False,
                    )
                    for batch in scanner.to_batches():
                        if batch.num_rows:
                            yield batch.replace_schema_metadata(lineage)
                except (OSError, pa.ArrowException) as error:
                    raise WarehouseError(f"cannot read {path}: {error}") from error

        return pa.RecordBatchReader.from_batches(output_schema, batches())

    def read_file(
        self, filename: str, cols: Sequence[str] | None = None, filters: Sequence | None = None, *,
        repository_id: str | None = None, snapshot_id: str | None = None, variant_id: str | None = None,
        as_arrow: bool = False, verify: bool = True,
    ) -> pd.DataFrame | pa.Table:
        if type(as_arrow) is not bool:
            raise SelectionError("as_arrow must be a boolean")
        with self.read_batches(
            filename, cols, filters, repository_id=repository_id, snapshot_id=snapshot_id,
            variant_id=variant_id, verify=verify,
        ) as reader:
            table = reader.read_all()
        if as_arrow:
            return table
        frame = table.to_pandas(types_mapper=pd.ArrowDtype)
        frame.attrs.update({
            key.decode().removeprefix("warehouse."): value.decode()
            for key, value in (table.schema.metadata or {}).items()
        })
        return frame
