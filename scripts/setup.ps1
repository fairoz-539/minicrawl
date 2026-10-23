# Creates .env with YOUR OWN freshly generated keys (Windows PowerShell).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   (run from the minicrawl folder)
#   -AnthropicKey <key>   set the Anthropic key without being asked
#   -SkipAnthropic        don't ask for an Anthropic key
param([string]$AnthropicKey = "", [switch]$SkipAnthropic)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (Test-Path .env) {
  Write-Host ".env already exists - not touching it. Delete it first to start over."
  exit 0
}

function New-RandomHex {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

$apiKey = New-RandomHex
$searxngSecret = New-RandomHex

$anthropicKey = $AnthropicKey
# Ask only when someone is at the keyboard (scripts/CI pass -AnthropicKey or -SkipAnthropic).
if (-not $anthropicKey -and -not $SkipAnthropic -and -not [Console]::IsInputRedirected -and [Environment]::UserInteractive) {
  Write-Host "Optional: your own Anthropic API key for AI extraction (https://console.anthropic.com)."
  $secure = Read-Host "Paste it, or press Enter to skip" -AsSecureString
  $anthropicKey = [System.Net.NetworkCredential]::new("", $secure).Password
}

$lines = Get-Content .env.example | ForEach-Object {
  if ($_ -match '^API_KEY=') { "API_KEY=$apiKey" }
  elseif ($_ -match '^SEARXNG_SECRET=') { "SEARXNG_SECRET=$searxngSecret" }
  elseif ($anthropicKey -and $_ -match '^# ANTHROPIC_API_KEY=') { "ANTHROPIC_API_KEY=$anthropicKey" }
  else { $_ }
}
# UTF-8 without BOM, so Docker Compose and Node read the first line correctly.
[System.IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "Created .env with a new API key. Use it as:  Authorization: Bearer <key>"
Write-Host "Your API key: $apiKey"
Write-Host "(It is stored only in .env on this machine.)"
Write-Host ""
Write-Host "Next:  docker compose up -d --build"
