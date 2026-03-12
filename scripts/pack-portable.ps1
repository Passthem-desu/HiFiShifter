<#
.SYNOPSIS
    将 HiFiShifter 打包为便携版压缩包（Portable ZIP）

.DESCRIPTION
    此脚本在 `cargo tauri build` 构建完成后，从产物目录中收集 exe、
    资源文件和依赖 DLL，打成一个免安装的 .zip 便携包。

.PARAMETER SkipBuild
    跳过构建步骤，直接从已有产物打包（用于构建已完成的情况）

.PARAMETER OutputDir
    输出目录，默认为项目根目录下的 dist 文件夹

.EXAMPLE
    .\scripts\pack-portable.ps1
    # 完整构建 + 打包

.EXAMPLE
    .\scripts\pack-portable.ps1 -SkipBuild
    # 跳过构建，直接打包已有产物

.EXAMPLE
    .\scripts\pack-portable.ps1 -OutputDir "C:\output"
    # 指定输出目录
#>

param(
    [switch]$SkipBuild,
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

# ===== 路径定义 =====
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$TauriDir = Join-Path $ProjectRoot "backend\src-tauri"
$TargetRelease = Join-Path $ProjectRoot "backend\src-tauri\target\x86_64-pc-windows-msvc\release"

# 从 tauri.conf.json 读取版本号和产品名
$TauriConf = Get-Content (Join-Path $TauriDir "tauri.conf.json") -Raw | ConvertFrom-Json
$ProductName = $TauriConf.productName
$Version = $TauriConf.version

# 输出目录
if (-not $OutputDir) {
    $OutputDir = Join-Path $ProjectRoot "dist"
}

$PortableDirName = "$ProductName-portable"
$TempDir = Join-Path $OutputDir $PortableDirName
$ZipName = "$ProductName-v$Version-portable-win-x64.zip"
$ZipPath = Join-Path $OutputDir $ZipName

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  HiFiShifter 便携版打包工具" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  产品名称: $ProductName"
Write-Host "  版本:     $Version"
Write-Host "  输出路径: $ZipPath"
Write-Host ""

# ===== 步骤 1: 构建（可选） =====
if (-not $SkipBuild) {
    Write-Host "[1/4] 正在构建 Release 版本..." -ForegroundColor Yellow
    Push-Location $TauriDir
    try {
        cargo tauri build
        if ($LASTEXITCODE -ne 0) {
            throw "构建失败，退出码: $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
    Write-Host "[1/4] 构建完成 ✓" -ForegroundColor Green
}
else {
    Write-Host "[1/4] 跳过构建步骤（-SkipBuild）" -ForegroundColor DarkGray
}

# ===== 步骤 2: 检查产物 =====
Write-Host "[2/4] 检查构建产物..." -ForegroundColor Yellow

$ExePath = Join-Path $TargetRelease "$ProductName.exe"
if (-not (Test-Path $ExePath)) {
    throw "找不到 exe: $ExePath`n请先运行 'cargo tauri build' 或移除 -SkipBuild 参数"
}

# 定义需要收集的资源文件（源路径 -> 目标相对路径）
$Resources = @(
    @{ Src = Join-Path $TauriDir "resources\models\nsf_hifigan\pc_nsf_hifigan.onnx"; Dst = "models\nsf_hifigan\pc_nsf_hifigan.onnx" },
    @{ Src = Join-Path $TauriDir "resources\models\nsf_hifigan\config.json";          Dst = "models\nsf_hifigan\config.json" },
    @{ Src = Join-Path $TauriDir "resources\models\hnsep\hnsep.onnx";                 Dst = "models\hnsep\hnsep.onnx" },
    @{ Src = Join-Path $TauriDir "resources\models\hnsep\config.yaml";                Dst = "models\hnsep\config.yaml" },
    @{ Src = Join-Path $TauriDir "third_party\vslib\vslib_x64.dll";                   Dst = "vslib_x64.dll" }
)

# 检查所有资源文件是否存在
$Missing = @()
foreach ($res in $Resources) {
    if (-not (Test-Path $res.Src)) {
        $Missing += $res.Src
    }
}
if ($Missing.Count -gt 0) {
    Write-Host "以下资源文件缺失:" -ForegroundColor Red
    $Missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    throw "资源文件不完整，无法打包"
}

Write-Host "[2/4] 产物检查通过 ✓" -ForegroundColor Green

# ===== 步骤 3: 组装目录 =====
Write-Host "[3/4] 组装便携包目录..." -ForegroundColor Yellow

# 清理旧的临时目录和 zip
if (Test-Path $TempDir) {
    Remove-Item $TempDir -Recurse -Force
}
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

# 创建输出目录
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

# 复制 exe
Copy-Item $ExePath -Destination $TempDir
Write-Host "  ✓ $ProductName.exe" -ForegroundColor DarkGreen

# 复制资源文件
foreach ($res in $Resources) {
    $DstFull = Join-Path $TempDir $res.Dst
    $DstDir = Split-Path $DstFull -Parent
    if (-not (Test-Path $DstDir)) {
        New-Item -ItemType Directory -Path $DstDir -Force | Out-Null
    }
    Copy-Item $res.Src -Destination $DstFull
    Write-Host "  ✓ $($res.Dst)" -ForegroundColor DarkGreen
}

# 复制 LICENSE
$LicensePath = Join-Path $ProjectRoot "LICENSE"
if (Test-Path $LicensePath) {
    Copy-Item $LicensePath -Destination $TempDir
    Write-Host "  ✓ LICENSE" -ForegroundColor DarkGreen
}

# 检查是否有额外的 DLL 依赖（如 onnxruntime）
$OrtDll = Join-Path $TargetRelease "onnxruntime.dll"
if (Test-Path $OrtDll) {
    Copy-Item $OrtDll -Destination $TempDir
    Write-Host "  ✓ onnxruntime.dll" -ForegroundColor DarkGreen
}

# 检查 WebView2Loader.dll（Tauri 可能需要）
$Wv2Dll = Join-Path $TargetRelease "WebView2Loader.dll"
if (Test-Path $Wv2Dll) {
    Copy-Item $Wv2Dll -Destination $TempDir
    Write-Host "  ✓ WebView2Loader.dll" -ForegroundColor DarkGreen
}

Write-Host "[3/4] 目录组装完成 ✓" -ForegroundColor Green

# ===== 步骤 4: 压缩 =====
Write-Host "[4/4] 正在压缩为 ZIP..." -ForegroundColor Yellow

Compress-Archive -Path $TempDir -DestinationPath $ZipPath -CompressionLevel Optimal

# 清理临时目录
Remove-Item $TempDir -Recurse -Force

$ZipSize = (Get-Item $ZipPath).Length
$ZipSizeMB = [math]::Round($ZipSize / 1MB, 2)

Write-Host "[4/4] 压缩完成 ✓" -ForegroundColor Green
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  打包成功！" -ForegroundColor Green
Write-Host "  输出: $ZipPath" -ForegroundColor Green
Write-Host "  大小: $ZipSizeMB MB" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
