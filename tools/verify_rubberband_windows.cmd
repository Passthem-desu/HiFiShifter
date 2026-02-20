@echo off
setlocal

set REPO_ROOT=%~dp0..
pushd %REPO_ROOT%

set VCVARS64=E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS64%" (
  echo [verify_rubberband] ERROR: vcvars64.bat not found: %VCVARS64%
  exit /b 1
)

call "%VCVARS64%"
if errorlevel 1 (
  echo [verify_rubberband] ERROR: vcvars64.bat failed
  exit /b 1
)

set RB_DLL=backend\src-tauri\third_party\rubberband\source\rubberband-4.0.0\otherbuilds\x64\Release\rubberband.dll
if not exist "%RB_DLL%" (
  echo [verify_rubberband] ERROR: rubberband.dll not found: %RB_DLL%
  exit /b 1
)

set OUT=%TEMP%\rubberband_exports.txt
dumpbin /exports "%RB_DLL%" > "%OUT%"
if errorlevel 1 (
  echo [verify_rubberband] ERROR: dumpbin failed
  exit /b 1
)

findstr /c:"rubberband_new" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_rubberband] ERROR: export rubberband_new not found
  exit /b 1
)

findstr /c:"rubberband_process" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_rubberband] ERROR: export rubberband_process not found
  exit /b 1
)

findstr /c:"rubberband_retrieve" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_rubberband] ERROR: export rubberband_retrieve not found
  exit /b 1
)

echo [verify_rubberband] OK: exports look good
echo [verify_rubberband] DLL: %RB_DLL%
popd
endlocal
