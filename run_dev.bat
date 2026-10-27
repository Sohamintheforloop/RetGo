@echo off
REM One command: checks Node and Python, installs anything missing (first run only), starts the
REM edge worker, the local patcher and the web app in THIS window, then opens the browser.
REM Press Ctrl+C to stop everything. Extra options are passed through, e.g. run_dev.bat --no-browser
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.11 or newer from python.org and tick "Add python.exe to PATH", then reopen this window.
  pause
  exit /b 1
)
python tools\dev.py %*
echo.
pause
