@echo off
rem start-loop.bat -- one-click engine start for Windows. Keep this file inside the
rem repo's deploy\ folder; to get a desktop icon, right-click it -> [傳送到] ->
rem [桌面 (建立捷徑)] so the shortcut keeps pointing back here.
setlocal
set "REPO=%~dp0.."
for %%I in ("%REPO%") do set "REPO=%%~fI"
if "%LOOP_PORT%"=="" set "LOOP_PORT=4711"
set "URL=http://127.0.0.1:%LOOP_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo ERR: node not found -- install Node.js ^>= 20 first
  pause
  exit /b 1
)

rem Already running? Just open the board.
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection 127.0.0.1 -Port %LOOP_PORT% -InformationLevel Quiet -WarningAction SilentlyContinue))" >nul 2>nul
if not errorlevel 1 (
  echo Engine already running -- opening %URL%
  start "" "%URL%"
  exit /b 0
)

cd /d "%REPO%"
if not exist node_modules (
  echo First run: npm ci
  call npm ci || (pause & exit /b 1)
)
if not exist dist\server.js (
  echo First run: npm run build
  call npm run build || (pause & exit /b 1)
)

echo Starting engine (keep that window open; close it to stop the engine)
start "LoopEngineering" cmd /k node dist\server.js

rem Wait up to 60s for the board, then open the browser.
for /l %%i in (1,1,60) do (
  powershell -NoProfile -Command "exit [int](-not (Test-NetConnection 127.0.0.1 -Port %LOOP_PORT% -InformationLevel Quiet -WarningAction SilentlyContinue))" >nul 2>nul
  if not errorlevel 1 (
    start "" "%URL%"
    exit /b 0
  )
  powershell -NoProfile -Command "Start-Sleep -Seconds 1" >nul
)
echo WARN: board not up after 60s -- check the LoopEngineering window for errors
pause
