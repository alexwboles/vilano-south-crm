@echo off
setlocal
title Vilano CRM Launcher

REM ============================================================
REM  Vilano CRM - one-click launcher (Windows)
REM  Double-click this file the first time. It will:
REM    1. make sure Node.js 22+ is available (downloads a portable
REM       copy into .runtime if you don't have one - no admin needed)
REM    2. install dependencies (first run only)
REM    3. add a "Vilano CRM" shortcut to your Desktop (first run only)
REM  Then it starts the server and opens the CRM in your browser.
REM  After that, just double-click the Desktop shortcut.
REM  Close the "Vilano CRM - server" window to stop the server.
REM ============================================================

set "HERE=%~dp0"
set "PORT=3000"
set "NODE_VER=v22.23.3"
set "RUNTIME_DIR=%HERE%.runtime"
set "NODE_DIR=%RUNTIME_DIR%\nodejs"
set "NODE_EXE=%NODE_DIR%\node.exe"

REM --- 1. Find a usable Node.js (system first, portable fallback). ---
REM Flat goto-style logic (no nested blocks): every line parses on its own.
goto :node_check

:node_check
where node >nul 2>nul
if errorlevel 1 goto :node_portable_check
set "NVER="
for /f "tokens=1 delims=v." %%V in ('node --version 2^>nul') do set "NVER=%%V"
if not defined NVER goto :node_portable_check
if %NVER% GEQ 22 goto :node_system_ok
echo.
echo  Found Node.js v%NVER%, but Vilano CRM needs v22 or newer.
echo  I'll use a portable copy instead - nothing is installed on your system.
goto :node_portable_check

:node_system_ok
set "NODE_EXE=node"
set "NPMCMD=npm"
goto :node_done

:node_portable_check
if exist "%NODE_EXE%" goto :node_portable_ok
goto :node_download

:node_portable_ok
set "NPMCMD=%NODE_DIR%\npm.cmd"
goto :node_done

:node_download
echo.
echo  First run: getting a portable Node.js %NODE_VER% (about 30MB)...
echo  This goes inside the app folder - no admin rights needed.
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip' -OutFile '%RUNTIME_DIR%\node.zip'"
if errorlevel 1 goto :node_dl_failed
powershell -NoProfile -Command "Expand-Archive -Path '%RUNTIME_DIR%\node.zip' -DestinationPath '%RUNTIME_DIR%' -Force"
if errorlevel 1 goto :node_dl_failed
if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%" >nul 2>nul
move "%RUNTIME_DIR%\node-%NODE_VER%-win-x64" "%NODE_DIR%" >nul
del "%RUNTIME_DIR%\node.zip" 2>nul
if not exist "%NODE_EXE%" goto :node_dl_failed
echo  Node.js ready.
set "NPMCMD=%NODE_DIR%\npm.cmd"
goto :node_done

:node_dl_failed
echo.
echo  Couldn't download Node.js. Check your internet connection,
echo  then double-click this launcher again.
pause
exit /b 1

:node_done

REM --- 2. Dependencies (first run only). ---
if exist "%HERE%node_modules" goto :deps_done
echo.
echo  First run: installing dependencies - a minute or two...
cd /d "%HERE%"
call %NPMCMD% install
if errorlevel 1 (
  echo  Install failed. Check your internet connection and run the launcher again.
  pause
  exit /b 1
)
:deps_done

REM --- 3. Desktop shortcut (first run only). ---
if exist "%USERPROFILE%\Desktop\Vilano CRM.lnk" goto :shortcut_done
echo.
echo  Adding a "Vilano CRM" shortcut to your Desktop...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:USERPROFILE+'\Desktop\Vilano CRM.lnk');$s.TargetPath='%HERE%Vilano CRM.bat';$s.WorkingDirectory='%HERE%';$s.IconLocation='%HERE%public\favicon.ico';$s.Save()"
if exist "%USERPROFILE%\Desktop\Vilano CRM.lnk" echo  Shortcut created.
:shortcut_done

REM --- 4. Start the server (unless it's already running). ---
curl -sf -o nul "http://127.0.0.1:%PORT%/health" >nul 2>nul
if not errorlevel 1 goto :already_running
echo.
echo  Starting Vilano CRM server...
cd /d "%HERE%"
start "Vilano CRM - server (close this window to stop)" /d "%HERE%" "%NODE_EXE%" server.js
set /a TRIES=0
:waitloop
timeout /t 1 /nobreak >nul
curl -sf -o nul "http://127.0.0.1:%PORT%/health" >nul 2>nul
if not errorlevel 1 goto :server_up
set /a TRIES+=1
if %TRIES% LSS 30 goto waitloop
echo.
echo  The server didn't start. Look at the "Vilano CRM - server" window
echo  for the error, then double-click this launcher again.
pause
exit /b 1
:already_running
echo.
echo  Server is already running - opening the CRM...
:server_up

REM --- 5. Show the addresses (including the phone one) and open the browser. ---
set "LANIP="
for /f %%I in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } ^| Select-Object -ExpandProperty IPAddress -First 1"') do set "LANIP=%%I"
echo.
echo  ========================================================
echo   Vilano CRM is running.
echo.
echo   On this PC, open:   http://127.0.0.1:%PORT%
if defined LANIP echo   On your phone ^(same Wi-Fi^), open:  http://%LANIP%:%PORT%
if not defined LANIP echo   ^(Phone address not detected - make sure you're on Wi-Fi^)
echo  ========================================================
echo.
echo  Opening your browser now...
start "" "http://127.0.0.1:%PORT%"
echo.
echo  Done - the server keeps running in its own window.
echo  Close the "Vilano CRM - server" window whenever you want to stop it.
timeout /t 12 >nul
exit /b 0
