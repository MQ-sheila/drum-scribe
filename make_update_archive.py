"""Create the single GitHub Releases asset from release/DrumScribe/."""

from __future__ import annotations

import hashlib
import json
import pathlib
import zipfile


root = pathlib.Path(__file__).resolve().parent
app = root / "release" / "DrumScribe"
output = root / "release" / "DrumScribe-win-x64.zip"
if not (app / "DrumScribe.exe").is_file() or not (app / "DrumScribeUpdater.exe").is_file():
    raise SystemExit("请先运行 build_exe.ps1，生成完整的 release/DrumScribe")
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED,
                     compresslevel=6, allowZip64=True) as bundle:
    for path in sorted(app.rglob("*")):
        if path.is_file():
            bundle.write(path, pathlib.Path("DrumScribe") / path.relative_to(app))
digest = hashlib.sha256()
with output.open("rb") as archive:
    while block := archive.read(1024 * 1024):
        digest.update(block)
version = (app / "VERSION.txt").read_text(encoding="utf-8-sig").strip()
config = json.loads((root / "source" / "update_config.json").read_text(encoding="utf-8"))
repository = config["repository"]
if output.name != config["asset"]:
    raise SystemExit("更新包名称与 update_config.json 不一致")
manifest = {
    "tag_name": f"v{version}",
    "body": f"DrumScribe {version}",
    "assets": [{
        "name": output.name,
        "size": output.stat().st_size,
        "digest": f"sha256:{digest.hexdigest()}",
        "browser_download_url": (
            f"https://github.com/{repository}/releases/download/v{version}/{output.name}"
        ),
    }],
}
(root / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8")
print(f"{output}\nSHA-256: {digest.hexdigest()}\nVersion: {version}\nManifest: {root / 'latest.json'}")
