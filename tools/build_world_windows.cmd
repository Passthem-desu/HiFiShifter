@echo off
setlocal

set REPO_ROOT=%~dp0..
pushd %REPO_ROOT%

set VCVARS64=E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS64%" (
  echo [build_world] ERROR: vcvars64.bat not found: %VCVARS64%
  exit /b 1
)

call "%VCVARS64%"
if errorlevel 1 (
  echo [build_world] ERROR: vcvars64.bat failed
  exit /b 1
)

where cmake >nul 2>nul
if errorlevel 1 (
  echo [build_world] ERROR: cmake not found in PATH
  echo [build_world] Tip: install CMake and restart the terminal.
  exit /b 1
)

set WORLD_CMAKE=backend\src-tauri\third_party\world\build_world_dll\CMakeLists.txt
if not exist "%WORLD_CMAKE%" (
  echo [build_world] ERROR: CMakeLists not found: %WORLD_CMAKE%
  exit /b 1
)

set WORLD_SRC=backend\src-tauri\third_party\world\source\World\src\cheaptrick.cpp
if not exist "%WORLD_SRC%" (
  echo [build_world] ERROR: WORLD source not found. Run:
  echo [build_world]   git clone https://github.com/mmorise/World.git backend\src-tauri\third_party\world\source\World
  exit /b 1
)
set MSVC_TOOLSET=%HIFISHIFTER_MSVC_TOOLSET%
if "%MSVC_TOOLSET%"=="" set MSVC_TOOLSET=v145

set BUILD_DIR=backend\src-tauri\third_party\world\build_world_dll\_build_%MSVC_TOOLSET%
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"

echo [build_world] Configuring (CMake + MSVC x64)
cmake -S backend\src-tauri\third_party\world\build_world_dll -B "%BUILD_DIR%" -G "Visual Studio 17 2022" -A x64 -T %MSVC_TOOLSET%
echo [build_world] cmake configure exit=%ERRORLEVEL%
if errorlevel 1 (
  echo [build_world] ERROR: cmake configure failed
  echo [build_world] Tip: if toolset mismatch, set env HIFISHIFTER_MSVC_TOOLSET ^(e.g. v145^)
  exit /b 1
)

echo [build_world] Building world.dll (Release x64)
cmake --build "%BUILD_DIR%" --config Release
if errorlevel 1 (
  echo [build_world] ERROR: cmake build failed
  exit /b 1
)

set WORLD_DLL=%BUILD_DIR%\bin\Release\world.dll
if not exist "%WORLD_DLL%" set WORLD_DLL=%BUILD_DIR%\bin\world.dll
if not exist "%WORLD_DLL%" (
  echo [build_world] ERROR: world.dll not found under %BUILD_DIR%\bin
  exit /b 1
)

set WORLD_RES_DIR=backend\src-tauri\resources\world\windows\x64
set WORLD_RES_DLL=%WORLD_RES_DIR%\world.dll
if not exist "%WORLD_RES_DIR%" mkdir "%WORLD_RES_DIR%"

copy /y "%WORLD_DLL%" "%WORLD_RES_DLL%" >nul
if errorlevel 1 (
  echo [build_world] ERROR: failed to copy world.dll into resources dir
  exit /b 1
)

echo [build_world] world.dll: %WORLD_DLL%
echo [build_world] Copied to resources: %WORLD_RES_DLL%
echo [build_world] Tip: set HIFISHIFTER_WORLD_DLL=%WORLD_DLL%

echo [build_world] OK
popd
endlocal
