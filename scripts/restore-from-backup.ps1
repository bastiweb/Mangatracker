param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$dataDir = Join-Path $projectRoot "data"
$targetDb = Join-Path $dataDir "manga.db"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$preRestoreCopy = Join-Path $dataDir ("manga.pre-restore-{0}.db" -f $timestamp)

$resolvedBackup = Resolve-Path -LiteralPath $BackupFile

if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir | Out-Null
}

Push-Location $projectRoot
try {
  Write-Host "Stopping containers..."
  docker compose stop manga-tracker caddy | Out-Null

  if (Test-Path -LiteralPath $targetDb) {
    Write-Host "Creating pre-restore copy: $preRestoreCopy"
    Copy-Item -LiteralPath $targetDb -Destination $preRestoreCopy -Force
  }

  Write-Host "Restoring backup file: $resolvedBackup"
  Copy-Item -LiteralPath $resolvedBackup -Destination $targetDb -Force

  if (-not $NoStart) {
    Write-Host "Starting stack..."
    docker compose up -d | Out-Null
  }

  Write-Host "Restore completed."
  Write-Host "Database: $targetDb"
  if (Test-Path -LiteralPath $preRestoreCopy) {
    Write-Host "Previous DB copy: $preRestoreCopy"
  }
} finally {
  Pop-Location
}
