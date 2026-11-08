<#
  dsh-token-saver — one-command installer for Windows (PowerShell 5.1+).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Off
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Status

  Installs nothing globally and touches no credentials. It edits only the DSH
  profile patches under %USERPROFILE%\.dsh\profiles, keeping .bak copies.
#>
[CmdletBinding()]
param(
    [switch]$Off,
    [switch]$Status,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required (node not found on PATH).'
}

$dsh = Join-Path $env:USERPROFILE '.dsh'
if (-not (Test-Path $dsh)) {
    throw "DSH home not found at $dsh - install and run DSH once first."
}

Push-Location $repo
try {
    if ($Status) {
        node bin/verify.mjs
        if ($LASTEXITCODE -ne 0) { Write-Warning 'config verifier reported problems' }
        node bin/verify-agent-teams.mjs
        return
    }

    if ($Off) {
        Write-Host 'Disabling token policy (back to DSH defaults)...'
        node bin/tokensaver.mjs off
    }
    else {
        Write-Host 'Applying token policy...'
        node bin/tokensaver.mjs on
    }

    if (-not $DryRun) {
        Write-Host ''
        Write-Host 'Restart DSH to load the new profile rows.' -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
}