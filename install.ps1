#!/usr/bin/env pwsh
#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $PSCommandPath
$OpenCodeDir = Join-Path $env:USERPROFILE ".config" "opencode"
$MiMoCodeDir = Join-Path $env:USERPROFILE ".config" "mimocode"

function Install-For {
  param(
    [string]$Name,
    [string]$ConfigDir,
    [string]$SdkPackage
  )

  Write-Host "Installing for $Name..."

  $PluginsDir = Join-Path $ConfigDir "plugins"
  New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null

  $SymlinkPath = Join-Path $PluginsDir "opencode-agents-sync.js"
  $TargetPath = Join-Path $PluginDir "index.js"

  # Remove existing file/symlink if present
  if (Test-Path $SymlinkPath) {
    Remove-Item -LiteralPath $SymlinkPath -Force
  }

  try {
    New-Item -ItemType SymbolicLink -Path $SymlinkPath -Target $TargetPath | Out-Null
    Write-Host "  Symlink created: $SymlinkPath -> $TargetPath"
  }
  catch {
    Write-Warning @"
  Could not create symbolic link (requires admin or Developer Mode).
  Falling back to copy. You will need to re-copy after updating the plugin.

  To enable symlinks without admin:
    - Windows 10/11: Settings > For Developers > Developer Mode > ON
    - Or run PowerShell as Administrator

"@
    Copy-Item -LiteralPath $TargetPath -Destination $SymlinkPath -Force
    Write-Host "  Copied: $TargetPath -> $SymlinkPath"
  }

  if ($SdkPackage) {
    $NodeModulesDir = Join-Path $ConfigDir "node_modules" $SdkPackage
    if (-not (Test-Path $NodeModulesDir)) {
      Write-Host "  Installing SDK dependency: $SdkPackage"
      $PackageJson = Join-Path $ConfigDir "package.json"
      if (-not (Test-Path $PackageJson)) {
        '{"dependencies":{}}' | Set-Content -Path $PackageJson -NoNewline
      }
      Push-Location $ConfigDir
      try {
        npm install $SdkPackage --save
      }
      finally {
        Pop-Location
      }
    }
  }

  Write-Host "✓ $Name installed"
}

$FoundAny = $false

if (Test-Path $OpenCodeDir) {
  Install-For -Name "OpenCode" -ConfigDir $OpenCodeDir -SdkPackage "@opencode-ai/plugin"
  $FoundAny = $true
}

if (Test-Path $MiMoCodeDir) {
  Install-For -Name "MiMo Code" -ConfigDir $MiMoCodeDir -SdkPackage "@mimo-ai/plugin"
  $FoundAny = $true
}

if (-not $FoundAny) {
  Write-Host "No OpenCode or MiMo Code config found."
  Write-Host "Run opencode or mimocode at least once, then re-run this script."
  exit 1
}

Write-Host "Done. Restart your editor to load the plugin."
