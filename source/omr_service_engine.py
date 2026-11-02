"""Optional local bridge for Audiveris and MuseScore.

The browser app never uploads score images. This small standard-library server
is started next to the UI and only accepts JSON from 127.0.0.1. It reports a
clear unavailable state when Audiveris is not installed; it never fabricates a
MusicXML result.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import csv
import datetime
import json
import io
import mimetypes
import os
import pathlib
import secrets
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from PIL import Image, ImageOps
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import video_download


# Console tools such as Tesseract and Audiveris must stay completely hidden in
# the windowed build. OCR can invoke Tesseract many times per captured row.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


APP_ROOT = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))
if getattr(sys, "frozen", False):
    ROOT = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home())) / "DrumScribe"
else:
    ROOT = pathlib.Path(__file__).resolve().parent
ROOT.mkdir(parents=True, exist_ok=True)
OUTPUT = ROOT / "omr_output"
OUTPUT.mkdir(exist_ok=True)
CAPTURES = ROOT / "captures"
CAPTURES.mkdir(exist_ok=True)
EXPORTS = ROOT / "exports"
EXPORTS.mkdir(exist_ok=True)


def _first_existing(candidates: list[pathlib.Path]) -> str | None:
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def find_musescore() -> str | None:
    env = os.environ.get("MUSESCORE") or os.environ.get("MUSESCORE_PATH")
    candidates = []
    if env:
        candidates.append(pathlib.Path(env))
    candidates.extend([
        pathlib.Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
        pathlib.Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
        pathlib.Path(r"C:\Program Files (x86)\MuseScore 4\bin\MuseScore4.exe"),
    ])
    found = _first_existing(candidates)
    if found:
        return found
    for name in ("MuseScore4.exe", "musescore4", "musescore"):
        located = shutil.which(name)
        if located:
            return located
    return None



def find_tesseract() -> str | None:
    env = os.environ.get("TESSERACT_PATH")
    candidates = [pathlib.Path(env)] if env else []
    candidates.extend([
        APP_ROOT / "tools" / "Tesseract-OCR" / "tesseract.exe",
        pathlib.Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        pathlib.Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    ])
    found = _first_existing(candidates)
    return found or shutil.which("tesseract.exe") or shutil.which("tesseract")


def tesseract_environment(tesseract: str) -> dict[str, str]:
    environment = os.environ.copy()
    tessdata = pathlib.Path(tesseract).parent / "tessdata"
    if tessdata.is_dir():
        environment["TESSDATA_PREFIX"] = str(tessdata)
    return environment


def audiveris_environment() -> dict[str, str]:
    environment = os.environ.copy()
    # Audiveris invokes Tesseract's legacy recognizer. The regular bundled
    # Tesseract model is LSTM-only, so give Audiveris a model containing both
    # legacy and LSTM data without changing the environment used by our own OCR.
    tessdata = APP_ROOT / "tools" / "AudiverisTessdata"
    if tessdata.is_dir():
        environment["TESSDATA_PREFIX"] = str(tessdata)
    else:
        environment.pop("TESSDATA_PREFIX", None)
    return environment


def find_audiveris() -> str | None:
    env = os.environ.get("AUDIVERIS") or os.environ.get("AUDIVERIS_PATH")
    candidates = []
    if env:
        candidates.append(pathlib.Path(env))
    candidates.extend([
        APP_ROOT / "tools" / "Audiveris" / "Audiveris.exe",
        APP_ROOT / "tools" / "Audiveris" / "bin" / "Audiveris.exe",
        APP_ROOT / "tools" / "Audiveris" / "audiveris.jar",
        pathlib.Path(r"C:\Program Files\Audiveris\Audiveris.exe"),
        pathlib.Path(r"C:\Program Files\Audiveris\bin\Audiveris.exe"),
        pathlib.Path(r"C:\Program Files\Audiveris\audiveris.jar"),
        pathlib.Path(r"C:\Program Files (x86)\Audiveris\Audiveris.exe"),
    ])
    for directory in (
        pathlib.Path(r"C:\Program Files\Audiveris"),
        pathlib.Path(r"C:\Program Files (x86)\Audiveris"),
    ):
        try:
            candidates.extend(directory.glob("**/audiveris*.jar"))
            candidates.extend(directory.glob("**/Audiveris*.exe"))
        except OSError:
            pass
    found = _first_existing(candidates)
    if found:
        return found
    for name in ("audiveris", "Audiveris.exe"):
        located = shutil.which(name)
        if located:
            return located
    return None


def tools_status() -> dict:
    audiveris = find_audiveris()
    musescore = find_musescore()
    return {
        "ok": True,
        "audiveris": {"available": bool(audiveris), "path": audiveris},
        "musescore": {"available": bool(musescore), "path": musescore},
        "tesseract": {"available": bool(find_tesseract()), "path": find_tesseract()},
        "message": "Audiveris 未安装，实验性 MusicXML 导出不可用" if not audiveris else "已找到本地 OMR 工具",
    }


def decode_data_url(value: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError("图片数据格式不正确")
    if "," not in value:
        raise ValueError("图片必须是 data URL")
    header, encoded = value.split(",", 1)
    if ";base64" not in header:
        raise ValueError("只支持 base64 图片")
    return base64.b64decode(encoded, validate=True)


_ACTIVE_PROCESSES: set[subprocess.Popen] = set()
_ACTIVE_PROCESS_LOCK = threading.Lock()
_PROCESS_SHUTDOWN = threading.Event()


def _terminate_process_tree(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
                creationflags=NO_WINDOW,
            )
            return
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        process.terminate()
        process.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
        except OSError:
            pass


def terminate_active_processes() -> None:
    """Stop every OCR/OMR child process when the desktop window closes."""
    _PROCESS_SHUTDOWN.set()
    with _ACTIVE_PROCESS_LOCK:
        processes = list(_ACTIVE_PROCESSES)
    for process in processes:
        _terminate_process_tree(process)
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_PROCESSES.difference_update(processes)


atexit.register(terminate_active_processes)


def _limited_output(value: str | None, limit: int | None) -> str:
    value = value or ""
    return value if limit is None else value[-limit:]


def run_process(
    command: list[str],
    timeout: int = 300,
    environment: dict[str, str] | None = None,
    *,
    encoding: str | None = None,
    errors: str | None = None,
    output_limit: int | None = 4000,
) -> tuple[int, str, str]:
    if _PROCESS_SHUTDOWN.is_set():
        return 130, "", "应用正在关闭，识别已终止"
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding=encoding,
            errors=errors,
            env=environment,
            creationflags=NO_WINDOW,
        )
    except FileNotFoundError as error:
        return 127, "", str(error)
    except OSError as error:
        return 126, "", str(error)
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_PROCESSES.add(process)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return process.returncode, _limited_output(stdout, output_limit), _limited_output(stderr, output_limit)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process)
        try:
            stdout, _stderr = process.communicate(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            stdout = ""
        return 124, _limited_output(stdout, output_limit), "处理超时，请减少谱行数量后重试"
    finally:
        with _ACTIVE_PROCESS_LOCK:
            _ACTIVE_PROCESSES.discard(process)


def audiveris_command(audiveris: str, input_file: pathlib.Path, output_dir: pathlib.Path) -> list[str]:
    path = pathlib.Path(audiveris)
    # Keep five-line drum recognition enabled, but disable text categories that
    # commonly reinterpret dense hi-hat beams as chord names or lyrics.
    drum_options = [
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.drumNotation=true",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.oneLineStaves=false",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.chordNames=false",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.lyricsAboveStaff=false",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.fingerings=false",
    ]
    if path.suffix.lower() == ".jar":
        return ["java", "-jar", str(path), "-batch", *drum_options, "-export", "-output", str(output_dir), str(input_file)]
    return [str(path), "-batch", *drum_options, "-export", "-output", str(output_dir), str(input_file)]


def hide_default_part_names(result_file: pathlib.Path) -> None:
    """Hide Audiveris' synthetic Voice labels before MuseScore imports the file."""
    def clean_xml(data: bytes) -> bytes:
        xml = data.decode("utf-8", "replace")
        xml = re.sub(r"<part-name(?:\s[^>]*)?>\s*Voice\s*</part-name>", '<part-name print-object="no">Drumset</part-name>', xml, flags=re.I)
        xml = re.sub(r"<part-abbreviation(?:\s[^>]*)?>\s*Voice\s*</part-abbreviation>", '<part-abbreviation print-object="no">Dr.</part-abbreviation>', xml, flags=re.I)
        return xml.encode("utf-8")

    if result_file.suffix.lower() in {".musicxml", ".xml"}:
        result_file.write_bytes(clean_xml(result_file.read_bytes()))
        return
    if result_file.suffix.lower() != ".mxl":
        return
    replacement = result_file.with_suffix(".cleaning")
    with zipfile.ZipFile(result_file, "r") as source, zipfile.ZipFile(replacement, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.lower().endswith((".xml", ".musicxml")) and not info.filename.lower().endswith("container.xml"):
                data = clean_xml(data)
            target.writestr(info, data)
    replacement.replace(result_file)


def remove_spurious_drum_curves(result_file: pathlib.Path) -> int:
    """Remove Audiveris curve detections that become false drum ties/slurs."""
    def clean_xml(data: bytes) -> tuple[bytes, int]:
        xml = data.decode("utf-8", "replace")
        removed = 0
        for tag in ("tie", "tied", "slur"):
            xml, count = re.subn(rf"\s*<{tag}\b[^>]*/>", "", xml, flags=re.I)
            removed += count
            xml, count = re.subn(
                rf"\s*<{tag}\b[^>]*>.*?</{tag}>",
                "",
                xml,
                flags=re.I | re.S,
            )
            removed += count
        return xml.encode("utf-8"), removed

    suffix = result_file.suffix.lower()
    if suffix in {".musicxml", ".xml"}:
        cleaned, removed = clean_xml(result_file.read_bytes())
        result_file.write_bytes(cleaned)
        return removed
    if suffix != ".mxl":
        return 0

    replacement = result_file.with_suffix(".curves-cleaning")
    removed_total = 0
    with zipfile.ZipFile(result_file, "r") as source, zipfile.ZipFile(
        replacement, "w", compression=zipfile.ZIP_DEFLATED
    ) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.lower().endswith((".xml", ".musicxml")) and not info.filename.lower().endswith("container.xml"):
                data, removed = clean_xml(data)
                removed_total += removed
            target.writestr(info, data)
    replacement.replace(result_file)
    return removed_total


def hide_musescore_instrument_names(mscz_file: pathlib.Path) -> None:
    if not mscz_file or mscz_file.suffix.lower() != ".mscz" or not mscz_file.is_file():
        return
    replacement = mscz_file.with_suffix(".cleaning")
    with zipfile.ZipFile(mscz_file, "r") as source, zipfile.ZipFile(replacement, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.lower().endswith(".mscx"):
                xml = data.decode("utf-8", "replace")
                xml = re.sub(r"<longName>.*?</longName>", "<longName></longName>", xml, flags=re.I | re.S)
                xml = re.sub(r"<shortName>.*?</shortName>", "<shortName></shortName>", xml, flags=re.I | re.S)
                data = xml.encode("utf-8")
            target.writestr(info, data)
    replacement.replace(mscz_file)


def collect_result_files(directory: pathlib.Path) -> list[pathlib.Path]:
    return sorted(
        [*directory.rglob("*.musicxml"), *directory.rglob("*.xml"), *directory.rglob("*.mxl")],
        key=lambda item: item.stat().st_mtime,
    )


def validate_musescore_result(
    musescore: str,
    target: pathlib.Path,
    output_dir: pathlib.Path,
) -> pathlib.Path | None:
    """Return the score only when MuseScore can reopen it without -f."""
    validation_file = output_dir / f".{target.stem}-validation.musicxml"
    code, _stdout, _stderr = run_process(
        [musescore, "-o", str(validation_file), str(target)]
    )
    try:
        validation_file.unlink(missing_ok=True)
    except OSError:
        pass
    if code != 0:
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return target


def convert_to_musescore(musescore: str | None, xml_file: pathlib.Path, output_dir: pathlib.Path) -> pathlib.Path | None:
    if not musescore:
        return None
    target = output_dir / f"{xml_file.stem}.mscz"
    returncode, _stdout, _stderr = run_process([musescore, "-f", "-o", str(target), str(xml_file)])
    if returncode != 0:
        return None
    # MuseScore's Windows launcher can return before the GUI process finishes
    # writing the requested file. Keep the temporary directory alive until it
    # appears and its size stops changing.
    previous_size = -1
    stable_checks = 0
    for _attempt in range(240):
        if target.exists():
            size = target.stat().st_size
            if size > 0 and size == previous_size:
                stable_checks += 1
                if stable_checks >= 2:
                    return validate_musescore_result(musescore, target, output_dir)
            else:
                stable_checks = 0
                previous_size = size
        time.sleep(0.25)
    if target.exists() and target.stat().st_size > 0:
        return validate_musescore_result(musescore, target, output_dir)
    return None


def export_omr(payload: dict) -> tuple[int, dict]:
    status = tools_status()
    if not status["audiveris"]["available"]:
        return 503, {
            "ok": False,
            "status": "unavailable",
            "reason": "Audiveris 未安装。请安装 Audiveris 后重新点击实验性导出。",
            "tools": status,
        }
    document = payload.get("document")
    images = payload.get("images")
    if not isinstance(document, dict) and (not isinstance(images, list) or not images):
        return 400, {"ok": False, "status": "invalid", "reason": "没有收到待识别谱面"}
    title = str(payload.get("title") or "drum-score")[:80]
    with tempfile.TemporaryDirectory(prefix="drumscope-omr-") as temporary:
        temporary_path = pathlib.Path(temporary)
        input_files = []
        try:
            if isinstance(document, dict):
                data = decode_data_url(document.get("dataUrl"))
                name = pathlib.Path(str(document.get("name") or "score.pdf")).name
                if pathlib.Path(name).suffix.lower() != ".pdf":
                    name = "score.pdf"
                target = temporary_path / name
                target.write_bytes(data)
                input_files.append(target)
            else:
                for index, item in enumerate(images):
                    data_url = item.get("dataUrl") if isinstance(item, dict) else None
                    data = decode_data_url(data_url)
                    name = pathlib.Path(str(item.get("name") or f"row-{index + 1}.png")).name
                    if pathlib.Path(name).suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                        name = f"row-{index + 1}.png"
                    target = temporary_path / f"{index:04d}-{name}"
                    target.write_bytes(data)
                    input_files.append(target)
        except (ValueError, OSError) as error:
            return 400, {"ok": False, "status": "invalid", "reason": str(error)}
        output_dir = temporary_path / "export"
        output_dir.mkdir()
        logs = []
        failed_pages = []
        for page_number, input_file in enumerate(input_files, start=1):
            command = audiveris_command(status["audiveris"]["path"], input_file, output_dir)
            code, stdout, stderr = run_process(command, environment=audiveris_environment())
            logs.append({"file": input_file.name, "returncode": code, "stdout": stdout, "stderr": stderr})
            if code != 0:
                failed_pages.append(page_number)
        result_files = collect_result_files(output_dir)
        raw_result_files = []
        if result_files:
            raw_dir = temporary_path / "audiveris-raw"
            raw_dir.mkdir()
            for index, result_file in enumerate(result_files, start=1):
                raw_target = raw_dir / f"audiveris-raw-{index:03d}{result_file.suffix.lower()}"
                shutil.copy2(result_file, raw_target)
                raw_result_files.append(raw_target)
        removed_curves = 0
        for result_file in result_files:
            hide_default_part_names(result_file)
            removed_curves += remove_spurious_drum_curves(result_file)
        if removed_curves:
            logs.append({
                "file": "MusicXML post-process",
                "returncode": 0,
                "stdout": f"Removed {removed_curves} Audiveris drum tie/slur elements",
                "stderr": "",
            })
        if not result_files:
            detail = ""
            if logs:
                combined = (logs[-1].get("stderr") or logs[-1].get("stdout") or "").strip()
                if combined:
                    detail = "；" + combined.splitlines()[-1][:240]
            return 422, {"ok": False, "status": "failed", "reason": "Audiveris 没有识别出可编辑乐谱" + detail, "failedPages": failed_pages, "logs": logs, "tools": status}
        deliverables = list(result_files)
        mscz_files = []
        if status["musescore"]["available"]:
            for result_file in result_files:
                converted = convert_to_musescore(status["musescore"]["path"], result_file, output_dir)
                if converted:
                    hide_musescore_instrument_names(converted)
                    mscz_files.append(converted)
                    deliverables.append(converted)
        deliverables.extend(output_dir.glob("*.omr"))
        safe_title = "".join("_" if char in '\\/:*?"<>|' else char for char in title).strip() or "drum-score"
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        export_folder = EXPORTS / f"{stamp}-{safe_title}"
        suffix = 2
        while export_folder.exists():
            export_folder = EXPORTS / f"{stamp}-{safe_title}-{suffix}"
            suffix += 1
        export_folder.mkdir(parents=True)
        copied = []
        for item in deliverables:
            target = export_folder / item.name
            if target.exists():
                target = export_folder / f"{item.stem}-{len(copied) + 1}{item.suffix}"
            shutil.copy2(item, target)
            copied.append(target.name)

        raw_copied = []
        for item in raw_result_files:
            target = export_folder / item.name
            shutil.copy2(item, target)
            raw_copied.append(target.name)

        input_copies = []
        for index, input_file in enumerate(input_files):
            input_name = "omr-input.pdf" if input_file.suffix.lower() == ".pdf" else f"omr-input-{index + 1:03d}{input_file.suffix.lower()}"
            target = export_folder / input_name
            shutil.copy2(input_file, target)
            input_copies.append(target.name)

        manifest = {
            "title": title,
            "createdAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "inputFiles": input_copies,
            "outputFiles": copied,
            "rawOutputFiles": raw_copied,
            "failedPages": failed_pages,
            "removedCurves": removed_curves,
            "logs": logs,
            "tools": status,
        }
        (export_folder / "omr-debug.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        order = {".mscz": 0, ".mxl": 1, ".musicxml": 1, ".xml": 1, ".omr": 2}
        downloadable = sorted(
            [name for name in copied if pathlib.Path(name).suffix.lower() in order],
            key=lambda name: (order[pathlib.Path(name).suffix.lower()], name),
        )
        kind_counts: dict[str, int] = {}
        downloads = []
        for name in downloadable:
            suffix = pathlib.Path(name).suffix.lower()
            kind = "MuseScore" if suffix == ".mscz" else "MusicXML" if suffix in {".mxl", ".musicxml", ".xml"} else "Audiveris 工程"
            kind_counts[kind] = kind_counts.get(kind, 0) + 1
            number = kind_counts[kind]
            label = f"下载 {kind}" + (f" {number}" if number > 1 else "")
            query = urllib.parse.urlencode({"job": export_folder.name, "name": name})
            downloads.append({"name": name, "label": label, "url": f"/api/omr/download?{query}"})

        message = "识别完成，可以下载结果"
        if removed_curves:
            message += f"；已清理 {removed_curves} 个 Audiveris 误判连线标记"
        if failed_pages:
            message += f"；第 {', '.join(map(str, failed_pages))} 页识别失败，其他页面已保留"
        return 200, {
            "ok": True,
            "status": "complete",
            "message": message,
            "files": [],
            "downloads": downloads,
            "outputFiles": copied,
            "debugPath": str(export_folder / "omr-debug.json"),
            "failedPages": failed_pages,
            "removedCurves": removed_curves,
            "logs": logs,
            "tools": status,
        }


def _safe_session(value: str) -> str | None:
    value = str(value or "")
    return value if re.fullmatch(r"\d{8}-\d{6}-[0-9a-f]{6}", value) else None


def _safe_export_file(job: str, name: str) -> pathlib.Path | None:
    safe_job = pathlib.Path(str(job or "")).name
    safe_name = pathlib.Path(str(name or "")).name
    if safe_job != str(job or "") or safe_name != str(name or ""):
        return None
    folder = (EXPORTS / safe_job).resolve()
    target = (folder / safe_name).resolve()
    if folder.parent != EXPORTS.resolve() or target.parent != folder or not target.is_file():
        return None
    return target



def metadata_tesseract_environment(tesseract: str) -> dict[str, str]:
    environment = tesseract_environment(tesseract)
    candidates = [
        APP_ROOT / "tools" / "AudiverisTessdata",
        APP_ROOT / "audiveris-tessdata",
    ]
    for directory in candidates:
        if (directory / "eng.traineddata").is_file():
            environment["TESSDATA_PREFIX"] = str(directory)
            break
    return environment


def _metadata_ocr_text(data_url: str, name: str) -> tuple[str, str, list[dict]]:
    tesseract = find_tesseract()
    if not tesseract:
        return "", "小节号 OCR 组件未安装", []
    try:
        raw = decode_data_url(data_url)
        if not raw or len(raw) > 12 * 1024 * 1024:
            return "", "图片过大或为空", []
        image = Image.open(io.BytesIO(raw)).convert("L")
        if image.width < 20 or image.height < 20:
            return "", "图片太小", []
        image.thumbnail((1800, 1200), Image.Resampling.LANCZOS)
        image = ImageOps.autocontrast(image)
    except (OSError, ValueError) as error:
        return "", str(error), []
    with tempfile.TemporaryDirectory(prefix="drumscribe-metadata-") as temporary:
        image_path = pathlib.Path(temporary) / f"{name}.png"
        image.save(image_path)
        environment = metadata_tesseract_environment(tesseract)
        tessdata = pathlib.Path(environment.get("TESSDATA_PREFIX", ""))
        has_chinese = (tessdata / "chi_sim.traineddata").is_file()
        psm = "6" if name == "title" else "11"
        languages = ["chi_sim", "eng"] if has_chinese else ["eng"]
        outputs = []
        line_details = []
        errors = []
        for language in languages:
            code, stdout, stderr = run_process(
                [tesseract, str(image_path), "stdout", "-l", language, "--oem", "1", "--psm", psm, "tsv"],
                timeout=90,
                environment=environment,
                encoding="utf-8",
                errors="replace",
                output_limit=None,
            )
            parsed = False
            if stdout.lstrip().startswith("level\t"):
                groups: dict[tuple[str, str, str], list[tuple[str, float]]] = {}
                for item in csv.DictReader(io.StringIO(stdout), delimiter="\t"):
                    word = str(item.get("text") or "").strip()
                    if not word:
                        continue
                    try:
                        confidence = float(item.get("conf") or -1)
                    except ValueError:
                        confidence = -1
                    if confidence < 0:
                        continue
                    key = (str(item.get("block_num")), str(item.get("par_num")), str(item.get("line_num")))
                    groups.setdefault(key, []).append((word, confidence))
                for words in groups.values():
                    line = " ".join(word for word, _confidence in words).strip()
                    if not line:
                        continue
                    weight = sum(max(len(word), 1) for word, _confidence in words)
                    confidence = sum(conf * max(len(word), 1) for word, conf in words) / max(weight, 1) / 100
                    line_details.append({"text": line, "confidence": max(0.0, min(1.0, confidence)), "language": language})
                    if line not in outputs:
                        outputs.append(line)
                parsed = True
            if not parsed:
                cleaned = stdout.strip()
                if cleaned and cleaned not in outputs:
                    outputs.append(cleaned)
                    for line in cleaned.splitlines():
                        if line.strip():
                            line_details.append({"text": line.strip(), "confidence": 0, "language": language})
            if code != 0 and stderr:
                errors.append(stderr[-1200:])
        return "\n".join(outputs), "\n".join(errors), line_details


def _title_from_ocr(text: str, line_details: list[dict] | None = None) -> tuple[str | None, float]:
    ignored = (
        "drumscribe", "cleaned score", "bilibili", "播放", "弹幕", "关注",
        "未经", "评论", "会员", "直播", "下载", "视频",
    )
    sources = line_details or [
        {"text": line, "confidence": 0.0, "language": "unknown"}
        for line in str(text or "").splitlines()
    ]
    candidates = []
    for source in sources:
        raw_line = str(source.get("text") or "")
        confidence = float(source.get("confidence") or 0)
        line = re.sub(r"\s+", " ", raw_line).strip(" _-|:;,.，。")
        line = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", line)
        if confidence < 0.78 or not 2 <= len(line) <= 36:
            continue
        lower = line.lower()
        if any(token in lower for token in ignored):
            continue
        if re.search(r"[|¦=<>\\]", line):
            continue
        if re.fullmatch(r"[\d\W_]+", line):
            continue
        if re.search(r"(?:bpm|tempo|速度)\D{0,8}\d{2,3}", line, re.I):
            continue
        chinese = len(re.findall(r"[\u3400-\u9fff]", line))
        latin_runs = re.findall(r"[A-Za-z]+", line)
        latin = sum(len(run) for run in latin_runs)
        digits = len(re.findall(r"\d", line))
        if chinese < 2 and latin < 3:
            continue
        # Short isolated Latin fragments inside a Chinese candidate are usually
        # noteheads or UI debris (for example "al" / "ai"), not a song title.
        if chinese >= 2 and latin and max(map(len, latin_runs), default=0) < 3:
            continue
        allowed = len(re.findall(r"[\u3400-\u9fffA-Za-z0-9\s《》()（）·&'’!！+\-—]", line))
        if len(line) - allowed > 1:
            continue
        score = confidence * 100 + chinese * 1.5 + latin * 0.6 - digits * 1.5
        candidates.append((score, line, confidence))
    if not candidates:
        return None, 0.0
    _score, title, confidence = max(candidates, key=lambda item: item[0])
    return title, confidence

def _tempo_from_ocr(text: str) -> int | None:
    compact = re.sub(r"\s+", " ", str(text or ""))
    patterns = (
        r"(?:bpm|tempo|速度)\D{0,8}(\d{2,3})",
        r"(?:[♩♪Jj]|[qQ])?\s*[=＝~]\s*(\d{2,3})",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, compact, re.I):
            value = int(match.group(1))
            if 30 <= value <= 300:
                return value
    return None


def recognize_score_metadata(payload: dict) -> tuple[int, dict]:
    frame_text, frame_error, frame_lines = _metadata_ocr_text(str(payload.get("frame") or ""), "title") if payload.get("frame") else ("", "", [])
    row_text, row_error, _row_lines = _metadata_ocr_text(str(payload.get("row") or ""), "tempo") if payload.get("row") else ("", "", [])
    title, title_confidence = _title_from_ocr(frame_text, frame_lines)
    tempo = _tempo_from_ocr("\n".join((row_text, frame_text)))
    return 200, {
        "ok": True,
        "title": title,
        "titleConfidence": title_confidence,
        "tempo": tempo,
        "raw": {"frame": frame_text, "row": row_text, "frameLines": frame_lines},
        "errors": [item for item in (frame_error, row_error) if item],
    }


def recognize_measure_sheet(image_bytes: bytes, block_height: int, row_count: int) -> tuple[int, dict]:
    """Compatibility endpoint for older saved frontends."""
    tesseract = find_tesseract()
    if not tesseract:
        return 503, {"ok": False, "reason": "小节号 OCR 组件未安装"}
    block_height = max(80, min(300, int(block_height)))
    row_count = max(1, min(120, int(row_count)))
    with tempfile.TemporaryDirectory(prefix="drumscope-measures-") as temporary:
        image_path = pathlib.Path(temporary) / "measure-sheet.png"
        image_path.write_bytes(image_bytes)
        command = [
            tesseract, str(image_path), "stdout", "-l", "eng", "--psm", "11",
            "-c", "tessedit_char_whitelist=0123456789", "tsv",
        ]
        code, stdout, stderr = run_process(
            command,
            timeout=120,
            environment=tesseract_environment(tesseract),
            encoding="utf-8",
            errors="replace",
            output_limit=None,
        )
        if code != 0:
            return 422, {"ok": False, "reason": "小节号 OCR 运行失败", "detail": stderr[-1200:]}
        numbers: list[dict | None] = [None] * row_count
        reader = csv.DictReader(io.StringIO(stdout), delimiter="\t")
        for item in reader:
            raw = str(item.get("text") or "").strip()
            if not raw.isdigit():
                continue
            try:
                confidence = float(item.get("conf") or -1)
                top = int(item.get("top") or 0)
                height = int(item.get("height") or 0)
                value = int(raw)
            except ValueError:
                continue
            row_index = int((top + height / 2) // block_height)
            if not (0 <= row_index < row_count and 1 <= value <= 9999 and confidence >= 35):
                continue
            current = numbers[row_index]
            if current is None or confidence > current["confidence"]:
                numbers[row_index] = {"value": value, "confidence": confidence}
        return 200, {"ok": True, "numbers": numbers}


def _decode_image_data_url(value: str) -> bytes:
    value = str(value or "")
    encoded = value.split(",", 1)[1] if "," in value else value
    raw = base64.b64decode(encoded, validate=True)
    if not raw or len(raw) > 2 * 1024 * 1024:
        raise ValueError("小节号图片过大或为空")
    return raw


def _recognize_one_measure(item: dict, tesseract: str) -> dict:
    try:
        image = Image.open(io.BytesIO(_decode_image_data_url(item.get("dataUrl", "")))).convert("L")
        if image.width < 8 or image.height < 8:
            return {"value": None, "confidence": 0, "votes": 0, "candidates": [], "reason": "crop-too-small"}
        results: list[int] = []
        trial_count = 0
        with tempfile.TemporaryDirectory(prefix="drumscope-measure-row-") as temporary:
            folder = pathlib.Path(temporary)
            for width in (58, 72, 90):
                crop = image.crop((0, 0, min(width, image.width), image.height))
                crop = ImageOps.autocontrast(crop).resize(
                    (crop.width * 8, crop.height * 8), Image.Resampling.LANCZOS
                )
                for threshold in (155, 185, 210):
                    prepared = crop.point(lambda pixel, limit=threshold: 255 if pixel > limit else 0)
                    image_path = folder / f"w{width}-t{threshold}.png"
                    prepared.save(image_path)
                    for psm in ("7", "11"):
                        trial_count += 1
                        command = [
                            tesseract, str(image_path), "stdout", "-l", "eng", "--psm", psm,
                            "-c", "tessedit_char_whitelist=0123456789",
                        ]
                        code, stdout, _stderr = run_process(
                            command,
                            timeout=20,
                            environment=tesseract_environment(tesseract),
                            encoding="utf-8",
                            errors="replace",
                            output_limit=None,
                        )
                        digits = "".join(character for character in stdout if character.isdigit())
                        if code == 0 and digits:
                            value = int(digits)
                            if 1 <= value <= 9999:
                                results.append(value)
        counts = Counter(results)
        candidates = [
            {"value": value, "votes": votes, "confidence": round(votes * 100 / max(1, trial_count), 1)}
            for value, votes in counts.most_common(5)
        ]
        best = candidates[0] if candidates else None
        return {
            "value": best["value"] if best else None,
            "confidence": best["confidence"] if best else 0,
            "votes": best["votes"] if best else 0,
            "trials": trial_count,
            "candidates": candidates,
        }
    except Exception as error:
        return {"value": None, "confidence": 0, "votes": 0, "candidates": [], "reason": str(error)[:300]}


def recognize_measure_rows(payload: dict) -> tuple[int, dict]:
    tesseract = find_tesseract()
    if not tesseract:
        return 503, {"ok": False, "reason": "小节号 OCR 组件未安装"}
    images = payload.get("images") or []
    if not isinstance(images, list) or not 1 <= len(images) <= 120:
        return 400, {"ok": False, "reason": "小节号图片数量无效"}
    with ThreadPoolExecutor(max_workers=min(6, len(images))) as executor:
        numbers = list(executor.map(lambda item: _recognize_one_measure(item, tesseract), images))
    return 200, {"ok": True, "numbers": numbers}


def save_capture_debug(payload: dict) -> tuple[int, dict]:
    session_id = _safe_session(payload.get("sessionId", ""))
    if not session_id:
        return 400, {"ok": False, "reason": "调试记录的录制编号无效"}
    folder = CAPTURES / session_id
    if not folder.is_dir():
        return 404, {"ok": False, "reason": "录制会话不存在"}
    target = folder / "debug.json"
    temporary = folder / "debug.json.tmp"
    temporary.write_text(json.dumps(payload.get("debug") or {}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    return 200, {"ok": True, "path": str(target)}

def create_capture_session(title: str = "") -> dict:
    session_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    folder = CAPTURES / session_id
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "session.json").write_text(json.dumps({"title": str(title)[:80], "created": session_id}, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "sessionId": session_id, "path": str(folder)}


def capture_info(session_id: str) -> dict | None:
    safe = _safe_session(session_id)
    if not safe:
        return None
    folder = CAPTURES / safe
    if not folder.is_dir():
        return None
    files = sorted(folder.glob("group-*-candidate-*.jpg"))
    settings = {}
    debug_path = folder / "debug.json"
    if debug_path.is_file():
        try:
            settings = json.loads(debug_path.read_text(encoding="utf-8")).get("settings") or {}
        except (OSError, ValueError, AttributeError):
            settings = {}
    if not isinstance(settings, dict):
        settings = {}
    return {
        "ok": True,
        "sessionId": safe,
        "path": str(folder),
        "mode": settings.get("mode"),
        "sourceInk": settings.get("sourceInk"),
        "files": [{"name": item.name, "url": f"/api/capture/file?session={safe}&name={urllib.parse.quote(item.name)}"} for item in files],
    }


def latest_capture() -> dict:
    folders = sorted((item for item in CAPTURES.iterdir() if item.is_dir() and _safe_session(item.name)), key=lambda item: item.stat().st_mtime, reverse=True)
    for folder in folders:
        info = capture_info(folder.name)
        if info and info["files"]:
            return info
    return {"ok": True, "sessionId": None, "path": str(CAPTURES), "files": []}


class Handler(BaseHTTPRequestHandler):
    server_version = "DrumScribeLocal/0.8.69"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _send_bytes(self, status: int, body: bytes, content_type: str, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if filename:
            encoded = urllib.parse.quote(filename)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded}")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/video-download/status":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            status, payload = video_download.status((query.get("job") or [""])[0])
            self._send(status, payload)
            return
        if path == "/api/video-download/file":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            video_download.stream_file(self, (query.get("job") or [""])[0])
            return
        if path in {"/api/health", "/api/tools"}:
            self._send(200, tools_status())
            return
        if path == "/api/omr/download":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = (query.get("name") or [""])[0]
            target = _safe_export_file((query.get("job") or [""])[0], name)
            if not target:
                self._send(404, {"ok": False, "reason": "识别结果不存在"})
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send_bytes(200, target.read_bytes(), content_type, target.name)
            return
        if path == "/api/capture/latest":
            self._send(200, latest_capture())
            return
        if path == "/api/capture/session":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            info = capture_info((query.get("session") or [""])[0])
            self._send(200 if info else 404, info or {"ok": False, "reason": "录制会话不存在"})
            return
        if path == "/api/capture/file":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            session_id = _safe_session((query.get("session") or [""])[0])
            name = pathlib.Path((query.get("name") or [""])[0]).name
            if not session_id or not re.fullmatch(r"group-\d{4}-candidate-[01]\.jpg", name):
                self._send(400, {"ok": False, "reason": "截图地址无效"})
                return
            target = CAPTURES / session_id / name
            if not target.is_file():
                self._send(404, {"ok": False, "reason": "截图不存在"})
                return
            self._send_bytes(200, target.read_bytes(), "image/jpeg")
            return
        self._send(404, {"ok": False, "reason": "未知接口"})

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if path == "/api/video-download/start":
                if length <= 0 or length > 8192:
                    raise ValueError("视频链接过长或为空")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                status, response = video_download.start(payload.get("url", ""))
                self._send(status, response)
                return
            if path == "/api/video-download/cancel":
                if length <= 0 or length > 1024:
                    raise ValueError("下载任务参数无效")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                status, response = video_download.cancel(str(payload.get("job", "")))
                self._send(status, response)
                return
            if path == "/api/score-metadata":
                if length <= 0 or length > 30 * 1024 * 1024:
                    raise ValueError("标题与速度识别请求过大或为空")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                status, response = recognize_score_metadata(payload)
                self._send(status, response)
                return
            if path == "/api/measure-ocr-rows":
                if length <= 0 or length > 40 * 1024 * 1024:
                    raise ValueError("小节号识别请求过大或为空")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                status, response = recognize_measure_rows(payload)
                self._send(status, response)
                return
            if path == "/api/capture/debug":
                if length <= 0 or length > 4 * 1024 * 1024:
                    raise ValueError("调试记录过大或为空")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                status, response = save_capture_debug(payload)
                self._send(status, response)
                return
            if path == "/api/measure-ocr":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                block = int((query.get("block") or ["190"])[0])
                count = int((query.get("count") or ["1"])[0])
                if length <= 0 or length > 40 * 1024 * 1024:
                    raise ValueError("小节号识别图片过大或为空")
                status, payload = recognize_measure_sheet(self.rfile.read(length), block, count)
                self._send(status, payload)
                return
            if path == "/api/capture/start":
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                self._send(200, create_capture_session(payload.get("title", "")))
                return
            if path == "/api/capture/frame":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                session_id = _safe_session((query.get("session") or [""])[0])
                group = int((query.get("group") or ["-1"])[0])
                candidate = int((query.get("candidate") or ["-1"])[0])
                if not session_id or group < 0 or group > 9999 or candidate not in {0, 1}:
                    raise ValueError("截图参数无效")
                if length <= 0 or length > 15 * 1024 * 1024:
                    raise ValueError("截图过大或为空")
                folder = CAPTURES / session_id
                if not folder.is_dir():
                    raise ValueError("录制会话不存在")
                target = folder / f"group-{group:04d}-candidate-{candidate}.jpg"
                temporary = target.with_suffix(".tmp")
                temporary.write_bytes(self.rfile.read(length))
                temporary.replace(target)
                os.utime(folder, None)
                self._send(200, {"ok": True, "path": str(target)})
                return
            if path != "/api/omr":
                self._send(404, {"ok": False, "reason": "未知接口"})
                return
            if length <= 0 or length > 120 * 1024 * 1024:
                raise ValueError("请求过大或为空")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            status, response = export_omr(payload)
            self._send(status, response)
        except (ValueError, json.JSONDecodeError) as error:
            self._send(400, {"ok": False, "status": "invalid", "reason": str(error)})

    def log_message(self, format: str, *args) -> None:
        print(f"[DrumScribe OMR] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="DrumScribe local Audiveris/MuseScore bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"DrumScribe OMR service listening on http://{args.host}:{args.port}")
    print(json.dumps(tools_status(), ensure_ascii=False))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()






