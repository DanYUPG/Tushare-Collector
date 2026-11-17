import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import Mock, patch

from collector.filesystem import atomic_move, ensure_path_length, sync_directory
from collector.runner import Runner
from collector.store import Store


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_worker_exclusion_works_across_processes_and_releases_after_close(self):
        store = Store(self.root / "control/collector.sqlite3")
        first = Runner(store)
        first.start()
        self.addCleanup(first.close)
        probe = """
import sys
from pathlib import Path
from collector.runner import Runner
from collector.store import Store

runner = Runner(Store(Path(sys.argv[1])))
try:
    runner.start()
except RuntimeError as error:
    if "已有" not in str(error):
        raise
    print("blocked")
else:
    runner.close()
    raise SystemExit("A second worker must not start")
"""
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-c", probe, str(store.path)],
            capture_output=True, encoding="utf-8", timeout=20, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "blocked")
        first.close()
        replacement = Runner(store)
        replacement.start()
        replacement.close()

    def test_worker_startup_failure_releases_the_process_lock(self):
        store = Store(self.root / "control/collector.sqlite3")
        failed = Runner(store)
        with patch.object(store, "recover", side_effect=OSError("fixture failure")):
            with self.assertRaisesRegex(OSError, "fixture"):
                failed.start()
        replacement = Runner(store)
        replacement.start()
        replacement.close()

    def test_snapshot_directory_and_pointer_publish_on_unicode_paths(self):
        root = self.root / "本地仓库"
        root.mkdir()
        staging = root / ".snapshot.tmp"
        staging.mkdir()
        (staging / "data.parquet").write_bytes(b"fixture rows")
        final = root / "snapshot"
        atomic_move(staging, final)
        pointer = root / "current.json"
        pointer.write_bytes(b'{"snapshot_id":"old"}')
        temporary = root / ".current.tmp"
        temporary.write_bytes(b'{"snapshot_id":"snapshot"}')
        atomic_move(temporary, pointer, replace=True)
        sync_directory(root)
        self.assertEqual(pointer.read_bytes(), b'{"snapshot_id":"snapshot"}')
        self.assertEqual((final / "data.parquet").read_bytes(), b"fixture rows")
        self.assertFalse(temporary.exists())
        self.assertFalse(staging.exists())

    def test_windows_path_preflight_counts_utf16_and_honors_long_path_support(self):
        path = PureWindowsPath("C:/") / ("a" * 120) / ("\U0001f600" * 65) / "data.parquet"
        self.assertLess(len(str(path)), 260)
        backend = SimpleNamespace(long_paths_enabled=Mock(return_value=False))
        with (
            patch("collector.filesystem.IS_WINDOWS", True),
            patch.dict(sys.modules, {"collector.windows_files": backend}),
        ):
            with self.assertRaisesRegex(OSError, "长路径"):
                ensure_path_length(path)
            backend.long_paths_enabled.return_value = True
            ensure_path_length(path)
        with patch("collector.filesystem.IS_WINDOWS", False):
            ensure_path_length(path)

    def test_directory_publication_checks_final_child_paths_before_moving(self):
        source = self.root / "staging"
        source.mkdir()
        child = source / ("a" * 80 + ".parquet")
        child.write_bytes(b"keep")
        destination = PureWindowsPath("C:/") / ("b" * 170)
        backend = SimpleNamespace(long_paths_enabled=Mock(return_value=False), move_file=Mock())
        with (
            patch("collector.filesystem.IS_WINDOWS", True),
            patch.dict(sys.modules, {"collector.windows_files": backend}),
        ):
            with self.assertRaisesRegex(OSError, "长路径"):
                atomic_move(source, destination)
        backend.move_file.assert_not_called()
        self.assertEqual(child.read_bytes(), b"keep")

    @unittest.skipUnless(os.name == "nt", "Windows native file publication")
    def test_windows_move_retries_sharing_conflicts_without_copy_fallback(self):
        import pywintypes
        import win32con
        import winerror

        from collector.windows_files import move_file

        source, destination = self.root / "temporary", self.root / "current"
        busy = pywintypes.error(winerror.ERROR_SHARING_VIOLATION, "MoveFileEx", "busy")
        with (
            patch("collector.windows_files.win32file.MoveFileEx", side_effect=[busy, None]) as move,
            patch("collector.windows_files.time.sleep") as wait,
        ):
            move_file(source, destination, replace=True)
        self.assertEqual(move.call_count, 2)
        wait.assert_called_once()
        self.assertEqual(
            move.call_args.args,
            (
                str(source), str(destination),
                win32con.MOVEFILE_REPLACE_EXISTING | win32con.MOVEFILE_WRITE_THROUGH,
            ),
        )
        for code in (winerror.ERROR_ACCESS_DENIED, winerror.ERROR_NOT_SAME_DEVICE):
            with self.subTest(code=code):
                with patch(
                    "collector.windows_files.win32file.MoveFileEx",
                    side_effect=pywintypes.error(code, "MoveFileEx", "fixture"),
                ) as move:
                    with self.assertRaises(OSError):
                        move_file(source, destination, replace=True)
                self.assertEqual(move.call_count, 1)

    @unittest.skipUnless(os.name == "nt", "Windows native file publication")
    def test_windows_persistent_sharing_conflict_is_an_error_not_an_infinite_retry(self):
        import pywintypes
        import winerror

        from collector.windows_files import move_file

        with (
            patch(
                "collector.windows_files.win32file.MoveFileEx",
                side_effect=pywintypes.error(winerror.ERROR_SHARING_VIOLATION, "MoveFileEx", "busy"),
            ) as move,
            patch("collector.windows_files.time.monotonic", side_effect=[0, 2]),
            patch("collector.windows_files.time.sleep") as wait,
        ):
            with self.assertRaises(OSError):
                move_file(self.root / "temporary", self.root / "current", replace=True)
        self.assertEqual(move.call_count, 1)
        wait.assert_not_called()


if __name__ == "__main__":
    unittest.main()
