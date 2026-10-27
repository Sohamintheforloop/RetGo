@echo off
REM Builds ONE file: backend\dist\RetroGamePatcher.exe
REM It contains the web app, the game catalogue and the verified fix packs. Friends only need this .exe.
REM Run from the project root in a normal Command Prompt (Python 3.11+ and Node 22.12+ required, plus internet for the first build).
setlocal

echo [1/5] Fetching the fix packs from the authors' official release pages and verifying them...
python tools\fetch_fixes.py || goto :fail

echo [2/5] Checking that every bundled file is listed and unchanged...
python tools\payload_manifest.py --check || goto :fail

echo [3/5] Building the web app...
pushd frontend
call npm ci || goto :fail
call npm run build || goto :fail
popd

echo [4/5] Packaging the app...
pushd backend
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
pip install -r requirements.txt || goto :fail
pyinstaller --noconfirm --onefile --name RetroGamePatcher ^
  --add-data "..\frontend\dist;dist" ^
  --add-data "..\catalog;catalog" ^
  --add-data "..\payloads;payloads" ^
  main.py || goto :fail
popd

echo [5/5] Fingerprint of the finished exe (keep it next to the file you share):
certutil -hashfile backend\dist\RetroGamePatcher.exe SHA256
echo.
echo Built: backend\dist\RetroGamePatcher.exe
echo Share that one file with your friends. They double-click it and the app opens in their browser.
exit /b 0

:fail
echo Build failed. Read the messages above.
exit /b 1
