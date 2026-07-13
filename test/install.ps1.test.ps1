#!/usr/bin/env pwsh
#Requires -Version 7.0
# Tests for install.ps1 — run with: pwsh -NoProfile test/install.ps1.test.ps1
#
# Safety: this test NEVER touches the real USERPROFILE config.
# All operations happen inside an isolated temp sandbox.

$ErrorActionPreference = "Stop"
$Passed = 0
$Failed = 0

function Assert-True {
  param([scriptblock]$Condition, [string]$Message)
  if (& $Condition) {
    $script:Passed++
    Write-Host "  ✔ $Message" -ForegroundColor Green
  } else {
    $script:Failed++
    Write-Host "  ✖ $Message" -ForegroundColor Red
  }
}

function Assert-Equal {
  param([object]$Expected, [object]$Actual, [string]$Message)
  $eq = if ($null -eq $Expected -and $null -eq $Actual) { $true } else { $Expected -eq $Actual }
  if ($eq) {
    $script:Passed++
    Write-Host "  ✔ $Message" -ForegroundColor Green
  } else {
    $script:Failed++
    Write-Host "  ✖ $Message (expected: $Expected, actual: $Actual)" -ForegroundColor Red
  }
}

# Create a sandbox that mirrors the USERPROFILE structure: .config/opencode, .config/mimocode
$Sandbox = Join-Path $env:TMP "opencode-agents-sync-test-$(Get-Random)"
New-Item -ItemType Directory -Path $Sandbox -Force | Out-Null

# Copy install.ps1 and index.js into sandbox root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot ".." "install.ps1") -Destination $Sandbox -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot ".." "index.js") -Destination $Sandbox -Force

# Run install.ps1 in an isolated child process with USERPROFILE pointing to sandbox
function Invoke-Install {
  $wrapper = @"
`$env:USERPROFILE = '$($Sandbox -replace "'","''")'
. '$($Sandbox -replace "'","''")\install.ps1'
"@
  $wrapperPath = Join-Path $Sandbox "_wrapper.ps1"
  $stdoutPath = Join-Path $Sandbox "_stdout.txt"
  $stderrPath = Join-Path $Sandbox "_stderr.txt"
  Set-Content -LiteralPath $wrapperPath -Value $wrapper -NoNewline
  $proc = Start-Process -FilePath "pwsh" `
    -ArgumentList @("-NoProfile", "-File", $wrapperPath) `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
  $output = ""
  if (Test-Path $stdoutPath) { $output += (Get-Content $stdoutPath -Raw) }
  if (Test-Path $stderrPath) { $output += (Get-Content $stderrPath -Raw) }
  return @{ Output = $output }
}

$OC = Join-Path $Sandbox ".config" "opencode"
$MC = Join-Path $Sandbox ".config" "mimocode"

Write-Host "`n=== install.ps1 Tests ===" -ForegroundColor Cyan

# --- Test 1: No config dirs → shows error message ---
Write-Host "`n[Group: No config dirs]" -ForegroundColor Yellow
$r = Invoke-Install
Assert-True { $r.Output -match "No OpenCode or MiMo Code config found" } "should print 'No config found' message"

# --- Test 2: OpenCode only → creates symlink ---
Write-Host "`n[Group: OpenCode only]" -ForegroundColor Yellow
New-Item -ItemType Directory -Path (Join-Path $OC "plugins") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OC "node_modules" "@opencode-ai" "plugin") -Force | Out-Null
$r = Invoke-Install
Assert-True { $r.Output -match "Installing for OpenCode" } "should print 'Installing for OpenCode'"
Assert-True { $r.Output -match "OpenCode installed" } "should print 'OpenCode installed'"
$symlink = Join-Path $OC "plugins" "opencode-agents-sync.js"
Assert-True { Test-Path $symlink } "symlink file should exist"
$linkInfo = Get-Item -LiteralPath $symlink
Assert-Equal "SymbolicLink" $linkInfo.LinkType "should be a symbolic link"
Assert-True { $linkInfo.Target -eq (Join-Path $Sandbox "index.js") } "should point to index.js"

# --- Test 3: Idempotency ---
Write-Host "`n[Group: Idempotency]" -ForegroundColor Yellow
$r = Invoke-Install
Assert-True { $r.Output -match "OpenCode installed" } "should succeed on re-run"
Assert-True { Test-Path $symlink } "symlink should still exist after re-run"

# --- Test 4: Both editors ---
Write-Host "`n[Group: Both editors]" -ForegroundColor Yellow
New-Item -ItemType Directory -Path (Join-Path $MC "plugins") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $MC "node_modules" "@mimo-ai" "plugin") -Force | Out-Null
$r = Invoke-Install
Assert-True { $r.Output -match "Installing for OpenCode" } "should install for OpenCode"
Assert-True { $r.Output -match "Installing for MiMo Code" } "should install for MiMo Code"
$mimoLink = Join-Path $MC "plugins" "opencode-agents-sync.js"
Assert-True { Test-Path $mimoLink } "MiMo Code symlink should exist"

# --- Test 5: SDK dependency dir exists after install ---
Write-Host "`n[Group: SDK dependency]" -ForegroundColor Yellow
Assert-True { Test-Path (Join-Path $OC "node_modules" "@opencode-ai" "plugin") } "SDK dependency dir should exist"

# --- Cleanup ---
Remove-Item -LiteralPath $Sandbox -Recurse -Force

# --- Summary ---
Write-Host "`n=== Results ===" -ForegroundColor Cyan
$Total = $Passed + $Failed
Write-Host "$Passed / $Total passed" -ForegroundColor $(if ($Failed -eq 0) { "Green" } else { "Red" })
if ($Failed -gt 0) { exit 1 }
