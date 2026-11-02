@echo off
setlocal
cd /d "%~dp0"
pythonw "%~dp0desktop_launcher.py" chrome
if errorlevel 1 python "%~dp0desktop_launcher.py" chrome
