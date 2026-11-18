import hashlib
import json
import tempfile
import unittest
import uuid
from datetime import datetime
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from tushare_warehouse import IntegrityError, SelectionError, Warehouse, WarehouseError


def write_json(path, value):
    content = json.dumps(value, sort_keys=True).encode()
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repository_id = "a" * 64
        self.repository = self.root / "daily" / self.repository_id
        self.repository.mkdir(parents=True)
        self.data = pa.table({
            "ts_code": ["000001.SZ", "600000.SH", "000001.SZ", "600000.SH"],
            "trade_date": ["20191231", "20200102", "20200203", "20200203"],
            "close": pa.array([1.0, 10.0, 20.0, None], type=pa.float64()),
            "count": pa.array([1, 2, 3, None], type=pa.int64()),
        })
        self.snapshot = self.publish(self.data)
        self.warehouse = Warehouse(self.root)

    def publish(self, data, *, request=False, file_entries=None):
        snapshot_id = uuid.uuid4().hex
        directory = self.repository / "snapshots" / snapshot_id
        directory.mkdir(parents=True)
        partitions, files = {}, []
        if file_entries is None:
            file_entries = [("one", data, None)]
        for key, table, variant in file_entries:
            path = directory / f"{key}.parquet"
            pq.write_table(table, path, row_group_size=2)
            files.append({
                "month": key, "file": path.relative_to(self.repository).as_posix(), "rows": table.num_rows,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            })
            if request:
                partitions[key] = {"variant_id": variant, "variant": {"freq": variant[0]}}
        manifest = {
            "format_version": 1, "snapshot_id": snapshot_id, "dataset_id": "daily",
            "storage_layout": "request_partitions" if request else "monthly",
            "columns": data.column_names,
            "schema": [{"name": field.name, "type": str(field.type)} for field in data.schema],
            "dates": partitions, "months": files, "rows": sum(item["rows"] for item in files),
        }
        digest = write_json(directory / "manifest.json", manifest)
        (directory / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
        write_json(self.repository / "current.json", {
            "snapshot_id": snapshot_id, "manifest_sha256": digest,
        })
        write_json(self.root / "catalog.json", {
            "format_version": 1, "tables": {"daily": {
                "default_repository": self.repository_id,
                "repositories": {self.repository_id: {
                    "path": self.repository.relative_to(self.root).as_posix(),
                }},
            }},
        })
        return snapshot_id

    def rewrite_manifest(self, change):
        path = self.repository / "snapshots" / self.snapshot / "manifest.json"
        manifest = json.loads(path.read_bytes())
        change(manifest)
        digest = write_json(path, manifest)
        (path.parent / "manifest.sha256").write_text(digest, encoding="ascii")
        write_json(self.repository / "current.json", {
            "snapshot_id": self.snapshot, "manifest_sha256": digest,
        })

    def test_projection_and_filters_do_not_add_keys_or_expose_history(self):
        result = self.warehouse.read_file(
            "daily", cols=["close", "ts_code"],
            filters=[("trade_date", ">", "20200101"), ("close", ">=", 10),
                     ("ts_code", "in", ["000001.SZ"])],
        )
        self.assertIsInstance(result, pd.DataFrame)
        self.assertEqual(list(result.columns), ["close", "ts_code"])
        self.assertEqual(result["close"].tolist(), [20])
        self.assertEqual(result.attrs["snapshot_id"], self.snapshot)
        self.assertEqual(self.warehouse.list_tables(), ["daily"])
        self.assertEqual(self.warehouse.describe("daily")["rows"], 4)
        empty = self.warehouse.read_file("daily", filters=[("close", ">", 100)], as_arrow=True)
        self.assertEqual(empty.num_rows, 0)
        self.assertEqual(empty.schema.field("count").type, pa.int64())
        self.assertEqual(empty.column_names, self.data.column_names)

    def test_all_filter_operators_and_nulls(self):
        cases = [
            (("count", "==", 2), [2]), (("count", "!=", 2), [1, 3]),
            (("count", ">", 2), [3]), (("count", ">=", 2), [2, 3]),
            (("count", "<", 2), [1]), (("count", "<=", 2), [1, 2]),
            (("count", "in", [2, 3]), [2, 3]), (("count", "not in", [2, 3]), [1]),
            (("count", "is null", None), [None]), (("count", "is not null", None), [1, 2, 3]),
        ]
        for condition, expected in cases:
            with self.subTest(condition=condition):
                result = self.warehouse.read_file(
                    "daily", cols=["count"], filters=[condition], as_arrow=True,
                )
                self.assertEqual(result["count"].to_pylist(), expected)

    def test_rejects_invalid_columns_filters_and_types(self):
        for options in (
            {"cols": []}, {"cols": ["close", "close"]}, {"cols": ["unknown"]}, {"cols": "close"},
            {"filters": "close > 1"}, {"filters": [("close", ">")]},
            {"filters": [("close", ">", "10")]}, {"filters": [("count", "==", 2.0)]},
            {"filters": [("count", "==", True)]}, {"filters": [("close", "==", float("nan"))]},
            {"filters": [("trade_date", ">", 20200101)]}, {"filters": [("absent", "==", 1)]},
            {"filters": [("close", "LIKE", "%")]}, {"filters": [("close", "==", None)]},
            {"filters": [("close", "in", [None])]}, {"filters": [("close", "in", [])]},
            {"filters": [("close", "is null", True)]}, {"filters": [("close", [], 1)]},
            {"as_arrow": "true"}, {"verify": "false"},
        ):
            with self.subTest(options=options), self.assertRaises(SelectionError):
                self.warehouse.read_file("daily", **options)
        with self.assertRaises(SelectionError):
            self.warehouse.read_file("missing")

    def test_batches_pin_snapshot_at_call_and_have_no_frontend_page_limit(self):
        reader = self.warehouse.read_batches("daily", cols=["count"], batch_size=1)
        new = pa.concat_tables([self.data] * 100)
        latest = self.publish(new)
        with reader:
            batches = list(reader)
        self.assertEqual(sum(batch.num_rows for batch in batches), 4)
        self.assertTrue(all(batch.num_rows <= 1 for batch in batches))
        self.assertEqual(reader.schema.metadata[b"warehouse.snapshot_id"].decode(), self.snapshot)
        self.assertEqual(self.warehouse.read_file("daily").shape[0], 400)
        self.assertEqual(self.warehouse.read_file("daily", snapshot_id=self.snapshot).shape[0], 4)
        self.assertEqual(self.warehouse.describe("daily")["snapshot_id"], latest)
        for batch_size in (0, -1, True):
            with self.assertRaises(SelectionError):
                self.warehouse.read_batches("daily", batch_size=batch_size)

    def test_request_variants_are_explicit_and_duplicate_event_rows_are_preserved(self):
        self.publish(self.data, request=True, file_entries=[
            ("one", self.data.slice(0, 1), "b" * 64),
            ("two", pa.concat_tables([self.data.slice(0, 1)] * 2), "c" * 64),
        ])
        self.assertEqual(len(self.warehouse.describe("daily")["variants"]), 2)
        with self.assertRaisesRegex(SelectionError, "variant"):
            self.warehouse.read_file("daily")
        chosen = self.warehouse.read_file("daily", variant_id="c" * 64)
        self.assertEqual(len(chosen), 2)
        self.assertEqual(chosen.attrs["variant_id"], "c" * 64)
        self.assertEqual(chosen["ts_code"].tolist(), ["000001.SZ"] * 2)
        with self.assertRaises(SelectionError):
            self.warehouse.read_file("daily", variant_id="d" * 64)

    def test_multiple_repositories_require_a_default_or_explicit_choice(self):
        path = self.root / "catalog.json"
        value = json.loads(path.read_bytes())
        first_id = self.repository_id
        self.repository_id = "d" * 64
        self.repository = self.root / "daily" / self.repository_id
        self.repository.mkdir(parents=True)
        self.publish(self.data.slice(0, 1))
        second = json.loads(path.read_bytes())
        value["tables"]["daily"]["repositories"].update(second["tables"]["daily"]["repositories"])
        value["tables"]["daily"]["default_repository"] = None
        write_json(path, value)
        with self.assertRaisesRegex(SelectionError, "repository_id"):
            self.warehouse.read_file("daily")
        self.assertEqual(
            self.warehouse.read_file("daily", repository_id=first_id).shape[0], 4,
        )
        self.assertEqual(self.warehouse.read_file("daily", repository_id=self.repository_id).shape[0], 1)
        self.assertFalse(self.warehouse.list_repositories("daily")[0]["default"])

    def test_manifest_and_data_tampering_are_reported(self):
        path = self.repository / "snapshots" / self.snapshot / "manifest.json"
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        with self.assertRaisesRegex(IntegrityError, "checksum"):
            self.warehouse.read_file("daily")
        path.write_bytes(original)
        data = path.parent / "one.parquet"
        pq.write_table(self.data.set_column(2, "close", pa.array([9.0] * 4)), data)
        with self.assertRaisesRegex(IntegrityError, "checksum"):
            self.warehouse.read_file("daily")
        self.assertEqual(self.warehouse.read_file("daily", verify=False)["close"].tolist(), [9] * 4)
        pq.write_table(pa.table({"wrong": [1]}), data)
        with self.assertRaisesRegex(IntegrityError, "schema"):
            self.warehouse.read_file("daily", verify=False)

    def test_paths_and_duplicate_file_entries_cannot_escape_or_duplicate_data(self):
        for filename in ("../../outside.parquet", "C:/outside.parquet", "/outside.parquet"):
            with self.subTest(filename=filename):
                self.rewrite_manifest(lambda value: value["months"][0].update(file=filename))
                with self.assertRaises(IntegrityError):
                    self.warehouse.read_file("daily")
        self.snapshot = self.publish(self.data)

        def duplicate(value):
            value["months"].append(dict(value["months"][0]))
            value["rows"] *= 2

        self.rewrite_manifest(duplicate)
        with self.assertRaisesRegex(IntegrityError, "duplicate"):
            self.warehouse.read_file("daily")

    def test_timestamp_predicates_use_datetime_without_date_string_coercion(self):
        data = pa.table({
            "time": pa.array([datetime(2026, 1, 1, 9), datetime(2026, 1, 1, 10)],
                             type=pa.timestamp("ns")),
        })
        self.publish(data)
        result = self.warehouse.read_file(
            "daily", filters=[("time", ">", datetime(2026, 1, 1, 9))], as_arrow=True,
        )
        self.assertEqual(result.num_rows, 1)
        with self.assertRaises(SelectionError):
            self.warehouse.read_file("daily", filters=[("time", ">", "20260101")])

    def test_missing_legacy_metadata_is_explicit_and_reading_creates_no_files(self):
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*")
                  if path.is_file()}
        self.warehouse.read_file("daily")
        after = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*")
                 if path.is_file()}
        self.assertEqual(before, after)
        (self.root / "catalog.json").unlink()
        with self.assertRaisesRegex(WarehouseError, "index command"):
            self.warehouse.list_tables()
