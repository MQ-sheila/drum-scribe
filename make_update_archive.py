"""Create the single GitHub Releases asset from release/DrumScribe/."""

from __future__ import annotations

import hashlib
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
print(f"{output}\nSHA-256: {digest.hexdigest()}\nVersion: {(app / 'VERSION.txt').read_text(encoding='utf-8-sig').strip()}")
