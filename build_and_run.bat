@echo off
setlocal

echo ========================================
echo HiFiShifter Auto Build and Run Script
echo ========================================

echo.
echo Select mode:
echo   [1] Python (pywebview) - build frontend then run run_gui.py
echo   [2] Tauri  (Rust)      - ensure frontend deps then cargo tauri dev
echo.

choice /c 12 /n /m "Enter 1 or 2: "
if errorlevel 2 goto MODE_TAURI
goto MODE_PY

:MODE_PY

echo.
echo [1/3] Activating conda environment (diffsinger)...
call conda activate diffsinger
if %errorlevel% neq 0 (
    echo Failed to activate diffsinger environment!
    echo Please make sure the environment exists.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/3] Building frontend...
cd /d %~dp0frontend
if not exist node_modules (
    echo frontend/node_modules not found, running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo npm install failed!
        cd /d %~dp0
        pause
        exit /b %errorlevel%
    )
)
call npm run build
if %errorlevel% neq 0 (
    echo Frontend build failed!
    cd /d %~dp0
    pause
    exit /b %errorlevel%
)
cd /d %~dp0

echo.
echo [3/3] Starting HiFiShifter...
python run_gui.py

pause
exit /b 0

:MODE_TAURI
echo.
echo [1/2] Ensuring frontend dependencies...
cd /d %~dp0frontend
if not exist node_modules (
    echo frontend/node_modules not found, running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo npm install failed!
        cd /d %~dp0
        pause
        exit /b %errorlevel%
    )
)
cd /d %~dp0

echo.
echo [2/2] Starting Tauri dev...
cd /d %~dp0backend\src-tauri
cargo tauri dev
if %errorlevel% neq 0 (
    echo cargo tauri dev failed!
    cd /d %~dp0
    pause
    exit /b %errorlevel%
)

cd /d %~dp0
pause
exit /b 0
