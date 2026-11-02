"""Updater tests using tiny synthetic releases; no network or installed app."""

from __future__ import annotations

import hashlib
import io
import json
import pathlib
import tempfile
import unittest
import unittest.mock
import zipfile

import update_helper
import update_service

TEST_TMP = pathlib.Path(__file__).resolve().parent / ".test-tmp"
TEST_TMP.mkdir(exist_ok=True)


def archive_bytes(version: str = "0.8.91") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("DrumScribe/DrumScribe.exe", b"app")
        bundle.writestr("DrumScribe/DrumScribeUpdater.exe", b"helper")
        bundle.writestr("DrumScribe/VERSION.txt", version)
    return buffer.getvalue()


class UpdateTests(unittest.TestCase):
    def test_release_requires_newer_version_and_digest(self):
        raw = archive_bytes()
        asset = {"name": "DrumScribe-win-x64.zip", "size": len(raw),
                 "digest": f"sha256:{hashlib.sha256(raw).hexdigest()}",
                 "browser_download_url": "https://github.com/MQ-sheila/drum-scribe/releases/download/v0.8.91/DrumScribe-win-x64.zip"}
        release = {"owner": "MQ-sheila", "repo": "drum-scribe",
                   "tag_name": "v0.8.91", "assets": [asset]}
        self.assertIsNone(update_service.release_from_payload(release, "0.8.91", asset["name"]))
        self.assertEqual(update_service.release_from_payload(release, "0.8.90", asset["name"])["size"], len(raw))
        asset["digest"] = None
        with self.assertRaises(ValueError):
            update_service.release_from_payload(release, "0.8.90", asset["name"])

    def test_archive_rejects_traversal(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as temporary:
            root = pathlib.Path(temporary)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("DrumScribe/../outside.txt", "bad")
            with self.assertRaises(ValueError):
                update_service.extract_release(archive, root / "output")
            self.assertFalse((root / "outside.txt").exists())

    def test_download_verifies_and_stages(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as temporary:
            root = pathlib.Path(temporary)
            app_root = root / "resources"
            app_root.mkdir()
            (app_root / "VERSION.txt").write_text("0.8.90", encoding="utf-8")
            (app_root / "update_config.json").write_text(json.dumps({
                "repository": "MQ-sheila/drum-scribe", "asset": "DrumScribe-win-x64.zip"}), encoding="utf-8")
            manager = update_service.UpdateManager(app_root, root / "installed", root / "data")
            raw = archive_bytes()
            manager._release = {"url": "https://github.com/example", "version": "0.8.91",
                                "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            with unittest.mock.patch.object(update_service.urllib.request, "urlopen", return_value=io.BytesIO(raw)):
                manager._download()
            self.assertEqual(manager.status()["state"], "ready")
            self.assertTrue((manager._staged / "DrumScribe.exe").is_file())

    def test_failed_new_launch_restores_old_folder(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as temporary:
            root = pathlib.Path(temporary)
            install = root / "release" / "DrumScribe"
            install.mkdir(parents=True)
            (install / "DrumScribe.exe").write_bytes(b"old")
            work = root / "data" / "updates"
            staged = work / "pending" / "staging" / "DrumScribe"
            staged.mkdir(parents=True)
            (staged / "DrumScribe.exe").write_bytes(b"new")

            class FailedProcess:
                def poll(self): return 1
                def wait(self, timeout=None): return 1

            with unittest.mock.patch.object(update_helper, "launch", side_effect=[FailedProcess(), FailedProcess()]):
                with self.assertRaises(RuntimeError):
                    update_helper.apply_update(install, staged, work, 0.1)
            self.assertEqual((install / "DrumScribe.exe").read_bytes(), b"old")
            self.assertFalse((install.parent / ".DrumScribe-rollback").exists())

    def test_healthy_new_launch_removes_backup(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as temporary:
            root = pathlib.Path(temporary)
            install = root / "release" / "DrumScribe"
            install.mkdir(parents=True)
            (install / "DrumScribe.exe").write_bytes(b"old")
            work = root / "data" / "updates"
            staged = work / "pending" / "staging" / "DrumScribe"
            staged.mkdir(parents=True)
            (staged / "DrumScribe.exe").write_bytes(b"new")

            def healthy_launch(executable, marker=None):
                marker.write_text("ready", encoding="ascii")
                return object()

            with unittest.mock.patch.object(update_helper, "launch", side_effect=healthy_launch):
                update_helper.apply_update(install, staged, work, 0.1)
            self.assertEqual((install / "DrumScribe.exe").read_bytes(), b"new")
            self.assertFalse((install.parent / ".DrumScribe-rollback").exists())


if __name__ == "__main__":
    unittest.main()
