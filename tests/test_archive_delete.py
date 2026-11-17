import hashlib
import json
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from test_collector import CollectorFixture, response

from collector.app import create_app
from collector.archive_delete import check_deletion, cleanup_deletion, delete_archive
from collector.artifacts import export_data, preview_slice
from collector.models import CollectorError
from collector.store import Store


class ArchiveDeletionTests(CollectorFixture):
    def test_confirmed_deletion_only_removes_current_files_and_keeps_history_and_exports(self):
        run, _ = self.run_config(self.config(), [response(3)])
        other, _ = self.run_config(self.config(name="保留的另一个批次"), [response()])
        item = run["slices"][0]
        extra = Path(item["raw_path"]).with_name("keep-unregistered.txt")
        extra.write_text("not part of this deletion")
        exported = export_data(self.store, run["id"], str(self.root / "exports"))
        with self.store.connect() as db:
            before = {
                name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
                for name in ("configs", "runs", "slices", "attempts", "exports")
            }
        info = check_deletion(self.store, run["id"], item["id"])
        self.assertEqual(len(info["files"]), 2)
        self.assertGreater(info["bytes"], 0)
        self.assertTrue(Path(item["raw_path"]).exists())
        self.assertEqual(self.store.local_data()["archives"], 2)
        with self.assertRaisesRegex(CollectorError, "重新检查"):
            delete_archive(self.store, run["id"], item["id"], "0" * 64)
        result = delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        self.assertEqual(result["state"], "deleted")
        self.assertFalse(Path(item["raw_path"]).exists())
        self.assertFalse(Path(item["meta_path"]).exists())
        self.assertTrue(extra.exists())
        self.assertTrue(Path(other["slices"][0]["raw_path"]).exists())
        self.assertTrue(Path(exported["manifest_path"]).exists())
        self.assertEqual(self.store.local_data()["archives"], 1)
        self.assertEqual(self.store.local_data()["pending_deletion_count"], 0)
        historical = self.store.run(run["id"], detail=True)
        self.assertEqual(historical["state"], "succeeded")
        self.assertEqual(historical["deleted_archives"], 1)
        self.assertTrue(historical["slices"][0]["archive_deleted"])
        self.assertTrue(self.store.slice_page(run["id"])["items"][0]["archive_deleted"])
        self.assertEqual(self.store.archived_slices(run["id"])[1], [])
        with self.assertRaisesRegex(CollectorError, "已删除"):
            preview_slice(self.store, run["id"], item["id"])
        self.assertEqual(cleanup_deletion(self.store, result["id"])["state"], "deleted")
        with self.store.connect() as db:
            for name, count in before.items():
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], count)

    def test_active_runs_tampered_files_and_shared_paths_are_not_deleted(self):
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        active = self.store.create_run(self.store.save_config(self.config(name="排队任务"))["id"])
        with self.assertRaisesRegex(CollectorError, "排队或执行"):
            delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        self.store.cancel(active["id"])
        raw = Path(item["raw_path"])
        old = raw.read_bytes()
        raw.write_bytes(old + b"changed")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        raw.write_bytes(old)
        with self.store.connect() as db:
            db.execute("UPDATE slices SET raw_path=? WHERE run_id=?", (item["raw_path"], active["id"]))
        with self.assertRaisesRegex(CollectorError, "共享"):
            delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        self.assertTrue(raw.exists())
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)

    def test_partial_cleanup_is_durable_visible_and_retryable_after_restart(self):
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        original_unlink = Path.unlink

        def denied(path, *args, **kwargs):
            if str(path) == item["meta_path"]:
                raise PermissionError("test permission denied")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", denied), self.assertRaisesRegex(CollectorError, "尚未全部清理"):
            delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        self.assertFalse(Path(item["raw_path"]).exists())
        self.assertTrue(Path(item["meta_path"]).exists())
        self.store = Store(self.store.path)
        library = self.store.local_data()
        self.assertEqual(library["archives"], 0)
        self.assertEqual(library["pending_deletion_count"], 1)
        job = library["pending_deletions"][0]
        self.assertEqual(job["state"], "cleanup_failed")
        self.assertIn("permission denied", job["error"])
        with self.assertRaisesRegex(CollectorError, "已删除"):
            preview_slice(self.store, run["id"], item["id"])
        self.assertEqual(cleanup_deletion(self.store, job["id"])["state"], "deleted")
        self.assertFalse(Path(item["meta_path"]).exists())
        self.assertEqual(self.store.local_data()["pending_deletion_count"], 0)

    def test_resuming_failed_run_with_deleted_evidence_is_explicitly_rejected(self):
        run, _ = self.run_config(self.config(row_limit=2), [response(2)])
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        with self.assertRaisesRegex(CollectorError, "含已删除归档"):
            self.store.resume(run["id"])

    def test_deletion_api_requires_local_write_guard_and_exact_confirmation_but_no_token(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        path = f"/api/runs/{run['id']}/slices/{item['id']}"
        headers = {"x-collector-request": "1"}
        with TestClient(app, base_url="http://127.0.0.1") as client:
            app.state.runner.set_token("")
            info = client.get(f"{path}/deletion")
            self.assertEqual(info.status_code, 200)
            body = {"fingerprint": info.json()["fingerprint"]}
            self.assertEqual(client.request("DELETE", f"{path}/archive", json=body).status_code, 403)
            self.assertEqual(
                client.request("DELETE", f"{path}/archive", headers=headers, json={}).status_code, 422
            )
            self.assertTrue(Path(item["raw_path"]).exists())
            result = client.request("DELETE", f"{path}/archive", headers=headers, json=body)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["state"], "deleted")
            self.assertEqual(client.get(f"{path}/preview").status_code, 409)
            self.assertEqual(
                client.request("DELETE", f"{path}/archive", headers=headers, json=body).status_code, 409
            )

    def test_path_or_metadata_identity_changes_refuse_deletion(self):
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        meta = Path(item["meta_path"])
        payload = json.loads(meta.read_text())
        payload["slice_id"] = "0" * 32
        meta.write_text(json.dumps(payload))
        with self.store.connect() as db:
            db.execute(
                "UPDATE slices SET meta_sha256=? WHERE id=?",
                (hashlib.sha256(meta.read_bytes()).hexdigest(), item["id"]),
            )
        with self.assertRaisesRegex(CollectorError, "身份不一致"):
            check_deletion(self.store, run["id"], item["id"])
        self.assertTrue(Path(item["raw_path"]).exists())
