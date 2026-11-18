from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath

import pyarrow as pa

from .errors import IntegrityError, SelectionError, WarehouseError


def identifier(value: object, length: int, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(rf"[a-f0-9]{{{length}}}", value) is None:
        raise IntegrityError(f"invalid {label}: {value!r}")
    return value


def contained(root: Path, relative: object) -> Path:
    if not isinstance(relative, str) or "\\" in relative or ":" in relative:
        raise IntegrityError("warehouse paths must be relative POSIX paths")
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(part in {".", ".."} for part in path.parts):
        raise IntegrityError(f"invalid warehouse path: {relative!r}")
    resolved = root.joinpath(*path.parts).resolve()
    if not resolved.is_relative_to(root):
        raise IntegrityError(f"warehouse path escapes its repository: {relative!r}")
    return resolved


def document(path: Path, digest: str | None = None) -> dict:
    try:
        content = path.read_bytes()
    except FileNotFoundError as error:
        raise WarehouseError(
            f"missing metadata: {path}; for an older warehouse, run the collector's SDK index command"
        ) from error
    if digest is not None and hashlib.sha256(content).hexdigest() != identifier(digest, 64, "SHA-256"):
        raise IntegrityError(f"manifest checksum mismatch: {path}")
    try:
        value = json.loads(content)
    except (ValueError, UnicodeDecodeError) as error:
        raise IntegrityError(f"invalid JSON: {path}") from error
    if not isinstance(value, dict):
        raise IntegrityError(f"expected a JSON object: {path}")
    return value


def catalog(root: Path) -> dict:
    value = document(contained(root, "catalog.json"))
    if value.get("format_version") != 1 or not isinstance(value.get("tables"), dict):
        raise IntegrityError("unsupported warehouse catalog format")
    for name, table in value["tables"].items():
        if (
            not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", name)
            or not isinstance(table, dict) or not isinstance(table.get("repositories"), dict)
        ):
            raise IntegrityError("invalid catalog table")
        for repository_id, item in table["repositories"].items():
            identifier(repository_id, 64, "repository ID")
            if not isinstance(item, dict):
                raise IntegrityError("invalid repository location")
            contained(root, item.get("path"))
        default = table.get("default_repository")
        if default is not None and (
            not isinstance(default, str) or default not in table["repositories"]
        ):
            raise IntegrityError("default repository is not registered")
    return value["tables"]


def repository(root: Path, name: str, repository_id: str | None) -> tuple[Path, str]:
    tables = catalog(root)
    if not isinstance(name, str) or name not in tables:
        raise SelectionError(f"table is not published: {name!r}")
    table = tables[name]
    selected = repository_id if repository_id is not None else table.get("default_repository")
    if selected is None:
        raise SelectionError("multiple repositories exist; select repository_id from list_repositories()")
    if not isinstance(selected, str) or selected not in table["repositories"]:
        raise SelectionError(f"repository is not registered for {name}: {selected!r}")
    path = contained(root, table["repositories"][selected]["path"])
    return path, selected


def load_snapshot(root: Path, table: str, snapshot_id: str | None) -> tuple[dict, pa.Schema]:
    if snapshot_id is None:
        pointer = document(contained(root, "current.json"))
        snapshot_id = identifier(pointer.get("snapshot_id"), 32, "snapshot ID")
        digest = pointer.get("manifest_sha256")
        if digest is None:
            raise WarehouseError("legacy snapshot pointer; run the collector's SDK index command")
    else:
        identifier(snapshot_id, 32, "snapshot ID")
        try:
            digest = contained(root, f"snapshots/{snapshot_id}/manifest.sha256").read_text(
                encoding="ascii",
            ).strip()
        except FileNotFoundError as error:
            raise WarehouseError(
                "missing snapshot checksum; run the collector's SDK index command",
            ) from error
    manifest_path = contained(root, f"snapshots/{snapshot_id}/manifest.json")
    manifest = document(manifest_path, digest)
    manifest.setdefault(
        "storage_layout", "current_snapshot" if manifest.get("grain") == "current_snapshot" else "monthly",
    )
    if (
        manifest.get("format_version") != 1 or manifest.get("snapshot_id") != snapshot_id
        or manifest.get("dataset_id", "daily") != table
        or not isinstance(manifest.get("schema"), list)
        or not isinstance(manifest.get("months"), list) or not isinstance(manifest.get("dates"), dict)
        or type(manifest.get("rows")) is not int or manifest["rows"] < 0
        or not isinstance(manifest.get("storage_layout"), str)
        or manifest["storage_layout"] not in {"monthly", "current_snapshot", "request_partitions"}
    ):
        raise IntegrityError("unsupported or inconsistent snapshot manifest")
    try:
        schema = pa.schema([
            pa.field(item["name"], pa.type_for_alias(item["type"])) for item in manifest["schema"]
        ])
    except (KeyError, TypeError, ValueError) as error:
        raise IntegrityError("unsupported manifest schema") from error
    if not schema.names or len(set(schema.names)) != len(schema) or schema.names != manifest.get("columns"):
        raise IntegrityError("manifest columns do not match its schema")
    paths, partitions = set(), set()
    total = 0
    for item in manifest["months"]:
        if (
            not isinstance(item, dict) or not isinstance(item.get("month"), str)
            or type(item.get("rows")) is not int or item["rows"] < 0
        ):
            raise IntegrityError("invalid manifest file entry")
        path = contained(root, item.get("file"))
        if path.suffix != ".parquet" or not path.is_relative_to(root / "snapshots"):
            raise IntegrityError("data file is not a snapshot Parquet")
        identifier(item.get("sha256"), 64, "data SHA-256")
        if path in paths or item["month"] in partitions:
            raise IntegrityError("duplicate file or partition in snapshot manifest")
        paths.add(path)
        partitions.add(item["month"])
        total += item["rows"]
    if total != manifest["rows"]:
        raise IntegrityError("manifest file row counts do not match the snapshot")
    return manifest, schema


def request_variants(manifest: dict) -> list[dict]:
    if manifest["storage_layout"] != "request_partitions":
        return []
    variants = {}
    for source in manifest["dates"].values():
        if not isinstance(source, dict) or not isinstance(source.get("variant"), dict):
            raise IntegrityError("invalid request partition metadata")
        key = identifier(source.get("variant_id"), 64, "variant ID")
        params = source["variant"]
        if key in variants and variants[key] != params:
            raise IntegrityError("inconsistent request variant parameters")
        variants[key] = params
    if {item["month"] for item in manifest["months"]} != set(manifest["dates"]):
        raise IntegrityError("request partition files and metadata do not match")
    return [{"id": key, "params": params} for key, params in sorted(variants.items())]


def selected_files(manifest: dict, variant_id: str | None) -> tuple[list[dict], str | None]:
    if manifest["storage_layout"] != "request_partitions":
        if variant_id is not None:
            raise SelectionError("this table has no request variants")
        return manifest["months"], None
    variants = {item["id"] for item in request_variants(manifest)}
    if variant_id is None and len(variants) == 1:
        variant_id = next(iter(variants))
    if not isinstance(variant_id, str) or variant_id not in variants:
        raise SelectionError("select one variant_id from describe()['variants']; variants cannot be mixed")
    files = [
        item for item in manifest["months"]
        if manifest["dates"][item["month"]]["variant_id"] == variant_id
    ]
    return files, variant_id
