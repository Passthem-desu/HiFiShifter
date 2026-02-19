@echo off
echo ========================================
echo HiFiShifter Auto Build and Run Script
echo ========================================

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
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo Frontend build failed!
    cd ..
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo [3/3] Starting HiFiShifter...
python run_gui.py

pause
