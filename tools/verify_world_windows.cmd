@echo off

REM ==================================================================================
REM [DEPRECATED] This script is no longer needed as of v2026.03
REM ==================================================================================
REM WORLD vocoder is now statically linked at compile time using the `cc` crate.
REM The Rust build script (backend/src-tauri/build.rs) automatically compiles
REM WORLD C++ sources during cargo build - no separate DLL verification required.
REM
REM This file is kept for reference only.
REM ==================================================================================

setlocal

set REPO_ROOT=%~dp0..
pushd %REPO_ROOT%

set VCVARS64=E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS64%" (
  echo [verify_world] ERROR: vcvars64.bat not found: %VCVARS64%
  exit /b 1
)

call "%VCVARS64%"
if errorlevel 1 (
  echo [verify_world] ERROR: vcvars64.bat failed
  exit /b 1
)

set MSVC_TOOLSET=%HIFISHIFTER_MSVC_TOOLSET%
if "%MSVC_TOOLSET%"=="" set MSVC_TOOLSET=v145

set WORLD_DLL=backend\src-tauri\third_party\world\build_world_dll\_build_%MSVC_TOOLSET%\bin\Release\world.dll
if not exist "%WORLD_DLL%" set WORLD_DLL=backend\src-tauri\third_party\world\build_world_dll\_build_%MSVC_TOOLSET%\bin\world.dll
if not exist "%WORLD_DLL%" (
  echo [verify_world] ERROR: world.dll not found. Build it first:
  echo [verify_world]   tools\build_world_windows.cmd
  exit /b 1
)

set OUT=%TEMP%\world_exports.txt

dumpbin /exports "%WORLD_DLL%" > "%OUT%"
if errorlevel 1 (
  echo [verify_world] ERROR: dumpbin failed
  exit /b 1
)

findstr /c:"Harvest" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_world] ERROR: export Harvest not found
  exit /b 1
)

findstr /c:"GetSamplesForHarvest" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_world] ERROR: export GetSamplesForHarvest not found
  exit /b 1
)

findstr /c:"Dio" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_world] ERROR: export Dio not found
  exit /b 1
)

findstr /c:"GetSamplesForDIO" "%OUT%" >nul
if errorlevel 1 (
  echo [verify_world] ERROR: export GetSamplesForDIO not found
  exit /b 1
)

echo [verify_world] OK: exports look good
echo [verify_world] DLL: %WORLD_DLL%
popd
endlocal
