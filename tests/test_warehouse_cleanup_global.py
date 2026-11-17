from pathlib import Path
from unittest.mock import patch

import test_warehouse
from fastapi.testclient import TestClient
from test_collector import CollectorFixture

from collector.app import create_app
from collector.datasets import DatasetService
from collector.models import CollectorError
from collector.warehouse_cleanup import execute_cleanup, registered_deletion_info
from collector.warehouse_cleanup_global import execute_global_cleanup, preview_global_cleanup


class GlobalCleanupTests(CollectorFixture):
    sample = test_warehouse.WarehouseTests.sample
    register = test_warehouse.WarehouseTests.register

    def setUp(self):
        super().setUp()
        self.app = create_app(self.root / "web", start_worker=False)
        self.store = self.app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in self.app.state.warehouses.values():
            warehouse.datasets = self.service
        self.warehouses = {
            key: self.app.state.warehouses[key]
            for key in ("daily", "adj_factor", "daily_basic", "stock_basic")
        }
        self.sources = {}
        for dataset_id in ("daily", "adj_factor"):
            run = self.sample(dataset_id, "20260105")
            self.sources[dataset_id] = Path(run["slices"][0]["raw_path"])
            self.warehouses[dataset_id].refresh()

    def test_global_api_previews_all_and_requires_confirmation_before_deleting(self):
        with TestClient(self.app, base_url="http://127.0.0.1") as client:
            response = client.get("/api/warehouse-cleanup")
            self.assertEqual(response.status_code, 200, response.text)
            preview = response.json()
            self.assertEqual(preview["check_mode"], "fast")
            self.assertEqual((preview["count"], preview["files"]), (2, 4))
            self.assertTrue(all(path.exists() for path in self.sources.values()))
            self.assertTrue(any(item["dataset_id"] == "stock_basic" for item in preview["skipped"]))
            body = {"fingerprint": preview["fingerprint"], "retention_days": 0}
            self.assertEqual(client.post("/api/warehouse-cleanup", json=body).status_code, 403)
            headers = {"X-Collector-Request": "1"}
            self.assertEqual(client.post(
                "/api/warehouse-cleanup", json={**body, "check_mode": "unknown"}, headers=headers,
            ).status_code, 422)
            self.assertEqual(client.post(
                "/api/warehouse-cleanup", json={**body, "fingerprint": "0" * 64}, headers=headers,
            ).status_code, 409)
            result = client.post("/api/warehouse-cleanup", json=body, headers=headers)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual((result.json()["state"], result.json()["deleted"]), ("deleted", 2))
            self.assertTrue(all(not path.exists() for path in self.sources.values()))
            for dataset_id in self.sources:
                self.assertEqual(self.warehouses[dataset_id].rows()["matching_rows"], 2)

    def test_any_changed_snapshot_invalidates_whole_confirmation_before_first_delete(self):
        preview = preview_global_cleanup(self.warehouses)
        self.sample("daily", "20260106")
        self.warehouses["daily"].refresh()
        with self.assertRaisesRegex(CollectorError, "尚未执行"):
            execute_global_cleanup(self.warehouses, preview["fingerprint"])
        self.assertTrue(all(path.exists() for path in self.sources.values()))
        retained = preview_global_cleanup(self.warehouses, retention_days=36500)
        self.assertEqual(retained["count"], 0)

    def test_dataset_failure_does_not_claim_success_and_other_confirmed_datasets_complete(self):
        preview = preview_global_cleanup(self.warehouses)

        def selective(warehouse, *args, **kwargs):
            if warehouse.dataset_id == "adj_factor":
                raise CollectorError("fixture warehouse changed after preflight")
            return execute_cleanup(warehouse, *args, **kwargs)

        with patch("collector.warehouse_cleanup_global.execute_cleanup", side_effect=selective):
            result = execute_global_cleanup(self.warehouses, preview["fingerprint"])
        self.assertEqual((result["state"], result["deleted"]), ("cleanup_failed", 1))
        self.assertTrue(self.sources["adj_factor"].exists())
        self.assertFalse(self.sources["daily"].exists())
        self.assertTrue(any("error" in item for item in result["results"]))

    def test_global_preview_includes_durable_partial_cleanup_retry(self):
        preview = preview_global_cleanup(self.warehouses)
        with patch.object(Path, "unlink", side_effect=PermissionError("fixture denied")):
            failed = execute_global_cleanup(self.warehouses, preview["fingerprint"])
        self.assertEqual(failed["state"], "cleanup_failed")
        retry = preview_global_cleanup(self.warehouses)
        self.assertEqual((retry["count"], retry["pending"]), (0, 2))
        result = execute_global_cleanup(self.warehouses, retry["fingerprint"])
        self.assertEqual((result["state"], result["deleted"]), ("deleted", 2))
        self.assertTrue(all(not path.exists() for path in self.sources.values()))

    def test_preview_hash_checks_do_not_reserve_the_database_writer(self):
        def verify_while_other_connection_can_write(*args, **kwargs):
            with self.store.connect() as db:
                db.execute("PRAGMA busy_timeout=100")
                db.execute("BEGIN IMMEDIATE")
                db.rollback()
            return registered_deletion_info(*args, **kwargs)

        with patch(
            "collector.warehouse_cleanup.registered_deletion_info",
            side_effect=verify_while_other_connection_can_write,
        ):
            preview = preview_global_cleanup(self.warehouses)
        self.assertEqual(preview["count"], 2)
