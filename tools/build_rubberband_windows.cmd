@echo off
setlocal

set REPO_ROOT=%~dp0..
pushd %REPO_ROOT%

set VCVARS64=E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS64%" (
  echo [build_rubberband] ERROR: vcvars64.bat not found: %VCVARS64%
  exit /b 1
)

call "%VCVARS64%"
if errorlevel 1 (
  echo [build_rubberband] ERROR: vcvars64.bat failed
  exit /b 1
)

set RB_VCXPROJ=backend\src-tauri\third_party\rubberband\source\rubberband-4.0.0\otherbuilds\rubberband-library.vcxproj
if not exist "%RB_VCXPROJ%" (
  echo [build_rubberband] ERROR: vcxproj not found: %RB_VCXPROJ%
  exit /b 1
)

msbuild "%RB_VCXPROJ%" /p:Configuration=Release /p:Platform=x64 /m
if errorlevel 1 (
  echo [build_rubberband] ERROR: msbuild failed
  exit /b 1
)

set RB_OUTDIR=backend\src-tauri\third_party\rubberband\source\rubberband-4.0.0\otherbuilds\x64\Release
set RB_LIB=%RB_OUTDIR%\rubberband-library.lib
set RB_DEF=backend\src-tauri\third_party\rubberband\source\rubberband-4.0.0\otherbuilds\rubberband-capi.def
set RB_DLL=%RB_OUTDIR%\rubberband.dll
set RB_IMPLIB=%RB_OUTDIR%\rubberband.lib

set RB_DLL_VCXPROJ=backend\src-tauri\third_party\rubberband\source\rubberband-4.0.0\otherbuilds\rubberband-capi-dll.vcxproj
set RB_RES_DIR=backend\src-tauri\resources\rubberband\windows\x64
set RB_RES_DLL=%RB_RES_DIR%\rubberband.dll

if not exist "%RB_LIB%" (
  echo [build_rubberband] ERROR: static lib not found: %RB_LIB%
  exit /b 1
)
if not exist "%RB_DEF%" (
  echo [build_rubberband] ERROR: def file not found: %RB_DEF%
  exit /b 1
)

if not exist "%RB_DLL_VCXPROJ%" (
  echo [build_rubberband] ERROR: dll vcxproj not found: %RB_DLL_VCXPROJ%
  exit /b 1
)

echo [build_rubberband] Building rubberband.dll (Release x64)
msbuild "%RB_DLL_VCXPROJ%" /p:Configuration=Release /p:Platform=x64 /m
if errorlevel 1 (
  echo [build_rubberband] ERROR: dll build failed
  exit /b 1
)

echo [build_rubberband] rubberband.dll: %RB_DLL%
echo [build_rubberband] Tip: set HIFISHIFTER_RUBBERBAND_DLL=%RB_DLL%

if not exist "%RB_RES_DIR%" mkdir "%RB_RES_DIR%"
copy /y "%RB_DLL%" "%RB_RES_DLL%" >nul
if errorlevel 1 (
  echo [build_rubberband] ERROR: failed to copy rubberband.dll into resources dir
  exit /b 1
)
echo [build_rubberband] Copied to resources: %RB_RES_DLL%

echo [build_rubberband] OK
popd
endlocal