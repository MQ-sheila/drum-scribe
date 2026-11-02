param([switch]$Stage)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $appRoot 'source'
$work = Join-Path $appRoot '.build'
$dist = if ($Stage) { Join-Path $work 'staged-release' } else { Join-Path $appRoot 'release' }
$audiveris = 'C:\Program Files\Audiveris'
$tesseract = 'C:\Program Files\Tesseract-OCR'
$licenses = Join-Path $project 'third_party_licenses'

if (-not (Test-Path -LiteralPath $audiveris)) { throw '没有找到 C:\Program Files\Audiveris' }
if (-not (Test-Path -LiteralPath $tesseract)) { throw '没有找到 C:\Program Files\Tesseract-OCR' }

$assets = @(
    'index.html', 'styles.css', 'styles.v02.backup.css', 'runtime-config.js', 'core.js', 'core-engine.js', 'core-v04.js', 'core-horizontal.js',
    'pdf-export.js', 'measure-order.js', 'app.js', 'app-engine.js', 'update-ui.js', 'update_config.json',
    'drumscribe-icon.png', 'drumscribe-icon.ico'
)
$dataArgs = @()
foreach ($asset in $assets) {
    $dataArgs += '--add-data'
    $dataArgs += "$(Join-Path $project $asset);."
}
$dataArgs += '--add-data'
$dataArgs += "$audiveris;tools\Audiveris"
$dataArgs += '--add-data'
$dataArgs += "$tesseract;tools\Tesseract-OCR"
$dataArgs += '--add-data'
$dataArgs += "$(Join-Path $project 'audiveris-tessdata');tools\AudiverisTessdata"
$dataArgs += '--add-data'
$dataArgs += "$licenses;third_party_licenses"
$dataArgs += '--add-data'
$dataArgs += "$(Join-Path $project 'tools\BBDown');tools\BBDown"
$dataArgs += '--add-data'
$dataArgs += "$(Join-Path $appRoot 'VERSION.txt');."

$packArgs = @(
    '-m', 'PyInstaller', '--noconfirm', '--clean', '--windowed', '--onedir',
    '--name', 'DrumScribe', '--icon', (Join-Path $project 'drumscribe-icon.ico'), '--distpath', $dist, '--workpath', $work,
    '--specpath', $project, '--collect-all', 'webview', '--collect-all', 'yt_dlp',
    '--hidden-import', 'PIL._tkinter_finder'
) + $dataArgs + @((Join-Path $project 'packaged_launcher.py'))
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw '没有找到可用于打包的 Python' }
& $python.Source @packArgs
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败，退出码 $LASTEXITCODE" }

$helperArgs = @(
    '-m', 'PyInstaller', '--noconfirm', '--clean', '--windowed', '--onefile',
    '--name', 'DrumScribeUpdater', '--distpath', $dist, '--workpath', (Join-Path $work 'updater'),
    '--specpath', $project, (Join-Path $project 'update_helper.py')
)
& $python.Source @helperArgs
if ($LASTEXITCODE -ne 0) { throw "更新程序打包失败，退出码 $LASTEXITCODE" }
Move-Item -LiteralPath (Join-Path $dist 'DrumScribeUpdater.exe') -Destination (Join-Path $dist 'DrumScribe\DrumScribeUpdater.exe') -Force

$notice = @'
DrumScribe Windows 版

1. 双击“DrumScribe.exe”启动。
2. Audiveris 与 Tesseract 已包含在本文件夹中。
3. 如需直接生成 MSCZ，请另行安装 MuseScore 4；未安装时仍可下载 MusicXML/MXL。
4. 请保留整个文件夹，不要只复制 EXE。
5. 录制与识别缓存保存在：%LOCALAPPDATA%\DrumScribe
6. 链接下载的视频保存在：%LOCALAPPDATA%\DrumScribe\video_downloads
7. 链接导入只下载视频画面用于识谱，不下载独立音轨。
8. 程序会检查 GitHub Releases 上的新版本；下载完成后可重启安装。

第三方组件：
- Audiveris: AGPL-3.0-or-later
- Tesseract OCR: Apache-2.0
- BBDown: MIT
- yt-dlp: Unlicense
'@
Set-Content -LiteralPath (Join-Path $dist 'DrumScribe\使用说明.txt') -Value $notice -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $appRoot 'VERSION.txt') -Destination (Join-Path $dist 'DrumScribe\VERSION.txt') -Force
Write-Host "完成：$(Join-Path $dist 'DrumScribe')"
