import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from collector.app import create_app
from collector.credentials import CredentialStore
from collector.models import CollectorError

TOKEN = "credential-test-only-not-a-real-token"
HEADERS = {"X-Collector-Request": "1"}


class CredentialTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        environment = patch.dict(os.environ, {"TUSHARE_TOKEN": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.credentials = CredentialStore(self.root)

    def app(self):
        return create_app(self.root, start_worker=False)

    def test_remember_is_opt_in_private_and_reloads_after_restart_without_exposing_token(self):
        app = self.app()
        with TestClient(app, base_url="http://localhost") as client:
            response = client.put("/api/credential", headers=HEADERS, json={"token": TOKEN})
            self.assertEqual(response.json()["persistence"], "process_memory_only")
            self.assertFalse(self.credentials.path.exists())
            response = client.put("/api/credential", headers=HEADERS, json={
                "token": TOKEN, "remember": True,
            })
            self.assertEqual(response.json()["persistence"], "local_file")
            self.assertNotIn(TOKEN, response.text)
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(self.credentials.path.stat().st_mode), 0o600)
            self.assertEqual(self.credentials.load(), TOKEN)
            status = client.get("/api/status")
            self.assertTrue(status.json()["token_persisted"])
            self.assertEqual(status.json()["credential_file"], str(self.credentials.path))
            for path in ("/api/status", "/api/activity", "/api/configs", "/api/runs"):
                self.assertNotIn(TOKEN, client.get(path).text)
            self.assertNotIn(TOKEN.encode(), app.state.store.path.read_bytes())
        reopened = self.app()
        self.assertEqual(reopened.state.runner.token, TOKEN)
        with TestClient(reopened, base_url="http://localhost") as client:
            self.assertTrue(client.get("/api/status").json()["token_persisted"])

    def test_memory_only_update_and_clear_remove_saved_token_and_prevent_reload(self):
        for clear in (False, True):
            with self.subTest(clear=clear):
                app = self.app()
                with TestClient(app, base_url="http://localhost") as client:
                    client.put("/api/credential", headers=HEADERS, json={"token": TOKEN, "remember": True})
                    if clear:
                        result = client.delete("/api/credential", headers=HEADERS)
                        self.assertEqual(result.json()["persistence"], "cleared")
                        self.assertEqual(app.state.runner.token, "")
                    else:
                        result = client.put("/api/credential", headers=HEADERS, json={"token": "memory-only"})
                        self.assertEqual(result.json()["persistence"], "process_memory_only")
                        self.assertEqual(app.state.runner.token, "memory-only")
                    self.assertFalse(self.credentials.path.exists())
                    self.assertFalse(client.get("/api/status").json()["token_persisted"])
                self.assertEqual(self.app().state.runner.token, "")

    def test_environment_takes_priority_without_overwriting_local_file(self):
        self.credentials.save(TOKEN)
        with patch.dict(os.environ, {"TUSHARE_TOKEN": " environment-test-only "}):
            self.assertEqual(self.app().state.runner.token, "environment-test-only")
            self.assertEqual(self.credentials.load(), TOKEN)
        self.assertEqual(self.app().state.runner.token, TOKEN)

    def test_failed_write_or_clear_keeps_current_token_and_does_not_report_success(self):
        app = self.app()
        with TestClient(app, base_url="http://localhost") as client:
            client.put("/api/credential", headers=HEADERS, json={"token": TOKEN, "remember": True})
            with patch("collector.credentials.atomic_move", side_effect=PermissionError(TOKEN)):
                response = client.put("/api/credential", headers=HEADERS, json={
                    "token": "replacement-test-only", "remember": True,
                })
            self.assertEqual(response.status_code, 409)
            self.assertNotIn(TOKEN, response.text)
            self.assertEqual(app.state.runner.token, TOKEN)
            self.assertEqual(self.credentials.load(), TOKEN)
            self.assertEqual(list(self.root.glob(".tushare-token.*")), [])
            with patch("collector.credentials.Path.unlink", side_effect=PermissionError(TOKEN)):
                response = client.delete("/api/credential", headers=HEADERS)
            self.assertEqual(response.status_code, 409)
            self.assertNotIn(TOKEN, response.text)
            self.assertEqual(app.state.runner.token, TOKEN)
            self.assertTrue(client.get("/api/status").json()["token_persisted"])

    def test_save_and_clear_require_same_origin_and_strict_opt_in(self):
        with TestClient(self.app(), base_url="http://localhost") as client:
            self.assertEqual(client.put("/api/credential", json={
                "token": TOKEN, "remember": True,
            }).status_code, 403)
            self.assertEqual(client.delete("/api/credential").status_code, 403)
            self.assertEqual(client.delete("/api/credential", headers={
                **HEADERS, "Origin": "https://other.example",
            }).status_code, 403)
            for payload, expected in (
                ({"token": TOKEN, "remember": "true"}, 422),
                ({"token": " " + TOKEN + " invalid"}, 409),
            ):
                response = client.put("/api/credential", headers=HEADERS, json=payload)
                self.assertEqual(response.status_code, expected)
                self.assertNotIn(TOKEN, response.text)
            self.assertFalse(self.credentials.path.exists())

    def test_startup_rejects_insecure_links_and_corrupt_files_without_leaking_content(self):
        self.credentials.save(TOKEN)
        if os.name == "nt":
            import ntsecuritycon
            import win32security

            acl = win32security.ACL()
            everyone = win32security.CreateWellKnownSid(win32security.WinWorldSid, None)
            acl.AddAccessAllowedAce(win32security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, everyone)
            win32security.SetNamedSecurityInfo(
                str(self.credentials.path), win32security.SE_FILE_OBJECT,
                win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, acl, None,
            )
        else:
            self.credentials.path.chmod(0o644)
        with self.assertRaisesRegex(CollectorError, "权限"):
            self.app()
        self.credentials.path.unlink()
        target = self.root / "other-file"
        target.write_text(TOKEN)
        self.credentials.path.symlink_to(target)
        with self.assertRaisesRegex(CollectorError, "本地凭证文件"):
            self.app()
        self.assertEqual(target.read_text(), TOKEN)
        self.credentials.path.unlink()
        self.credentials.save(TOKEN)
        for content in (b"\xff", TOKEN.encode() + b" invalid", b"x" * 4097):
            self.credentials.path.write_bytes(content)
            with self.assertRaises(CollectorError) as error:
                self.app()
            self.assertNotIn(TOKEN, str(error.exception))

    def test_temporary_name_collision_does_not_remove_an_existing_file_or_old_token(self):
        self.credentials.save(TOKEN)
        temporary = self.root / ".tushare-token.collision"
        temporary.write_bytes(b"keep")
        with patch("collector.credentials.uuid.uuid4") as identifier:
            identifier.return_value.hex = "collision"
            with self.assertRaises(CollectorError):
                self.credentials.save("replacement-test-only")
        self.assertEqual(temporary.read_bytes(), b"keep")
        self.assertEqual(self.credentials.load(), TOKEN)

    def test_hardlinked_credentials_are_rejected_without_changing_the_other_link(self):
        self.credentials.save(TOKEN)
        other = self.root / "other-link"
        other.hardlink_to(self.credentials.path)
        with self.assertRaises(CollectorError):
            self.app()
        self.assertEqual(other.read_bytes(), (TOKEN + "\n").encode())


if __name__ == "__main__":
    unittest.main()
