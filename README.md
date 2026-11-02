# DrumScribe

从视频画面捕捉鼓谱、去重整理、生成 PDF，并通过 Audiveris 导出 MusicXML。

## 目录

- `source/`：当前有效源码、测试、图标和第三方许可。
- `release/DrumScribe/`：唯一的 Windows 发布目录；每次构建覆盖旧版。
- `build_exe.ps1`：使用本机 Audiveris 与 Tesseract 重建发行版。

## 使用

双击 `release/DrumScribe/DrumScribe.exe`。Audiveris、Tesseract、BBDown 和 yt-dlp 已内置；需要 MSCZ 时由用户自行安装 MuseScore 4。可以粘贴视频链接下载并直接进入谱面框选。链接导入只需视频画面，不下载独立音轨。

## 构建

1. 安装 `source/requirements-build.txt` 中的 Python 依赖。
2. 在开发机安装 Audiveris 与 Tesseract。
3. 运行根目录的 `build_exe.ps1`。
4. 运行 `python make_update_archive.py`，将 `release/DrumScribe-win-x64.zip` 上传到 GitHub 仓库 `MQ-sheila/drum-scribe` 的新 Release，标签为 `v` 加 `VERSION.txt` 中的版本号。
5. 发布 Release 后，把脚本生成的根目录 `latest.json` 提交到 `main`。GitHub API 遇到公共 IP 限额时，程序会从这个公开清单继续检查更新。每次发布新版本都要同步清单。

自动更新会核对 GitHub 附件的 SHA-256，并在程序退出后替换整个安装目录；新版本未能正常打开时恢复旧版本。请用完整文件夹首次分发，后续保持同一个安装路径。

GitHub 仓库存放源码；Windows 安装包不提交到 Git 历史，而是上传到对应版本的 **Release 附件**。仅创建仓库或推送源码不会让自动更新生效。首次安装需要手动下载完整文件夹；`0.8.92` 起在 GitHub API 达到限额时也能通过公开清单检查更新。

录制与识别数据保存在 `%LOCALAPPDATA%\DrumScribe`；链接下载的视频保存在其 `video_downloads` 子目录。
