<#
.SYNOPSIS
  install-goose.ps1 — Install Goose (by Block/AAIF) and configure it for
                      Lumina Edge's local OpenAI-compatible API on port 8090.

.DESCRIPTION
  Installs Goose, writes the correct config pointing at localhost:8090/v1,
  and verifies the connection to Lumina Edge.

  Usage: .\install-goose.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $Root

Write-Host "[install-goose] Platform: Windows" -ForegroundColor Cyan

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Check for existing Goose installation
# ──────────────────────────────────────────────────────────────────────────────
$GoosePath = Get-Command "goose" -ErrorAction SilentlyContinue
$GooseExists = ($null -ne $GoosePath)

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Determine arch and install Goose if not present
# ──────────────────────────────────────────────────────────────────────────────
if (-not $GooseExists) {
  Write-Host "[install-goose] Installing Goose..." -ForegroundColor Yellow

  # Detect architecture
  $Arch = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "i686" }

  # Check for common Windows package managers (winget first, then choco, then scoop)
  if (Get-Command "winget" -ErrorAction SilentlyContinue) {
    Write-Host "[install-goose] Installing via winget..." -ForegroundColor Yellow
    winget install -e --id Block.Goose
  } elseif (Get-Command "choco" -ErrorAction SilentlyContinue) {
    Write-Host "[install-goose] Installing via Chocolatey..." -ForegroundColor Yellow
    choco install goose
  } elseif (Get-Command "scoop" -ErrorAction SilentlyContinue) {
    Write-Host "[install-goose] Installing via Scoop..." -ForegroundColor Yellow
    scoop install goose
  } else {
    # Download binary directly from GitHub
    $LatestUrl = "https://github.com/block/goose/releases/latest/download/goose-$Arch-pc-windows-msvc.zip"
    $DownloadPath = "$env:TEMP\goose.zip"
    $ExtractPath = "$env:LOCALAPPDATA\Programs\Goose"

    Write-Host "[install-goose] Downloading from GitHub..." -ForegroundColor Yellow
    Write-Host "  URL: $LatestUrl" -ForegroundColor Gray

    try {
      Invoke-WebRequest -Uri $LatestUrl -OutFile $DownloadPath -UseBasicParsing
    } catch {
      Write-Host "[install-goose] Download failed: $_" -ForegroundColor Red
      Write-Host "[install-goose] Please install Goose manually from:" -ForegroundColor Yellow
      Write-Host "  https://github.com/block/goose/releases/latest" -ForegroundColor Cyan
      exit 1
    }

    # Create extract directory and unzip
    New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null
    try {
      Expand-Archive -Path $DownloadPath -DestinationPath $ExtractPath -Force
    } catch {
      Write-Host "[install-goose] Extraction failed. Trying 7-Zip..." -ForegroundColor Yellow
      if (Get-Command "7z" -ErrorAction SilentlyContinue) {
        & 7z x $DownloadPath -o"$ExtractPath" -aoa
      } else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($DownloadPath, $ExtractPath)
      }
    }

    Remove-Item $DownloadPath -Force -ErrorAction SilentlyContinue

    # Add to PATH for current session
    $env:Path = "$ExtractPath;$env:Path"

    # Add to PATH permanently for future sessions (user-level)
    try {
      $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
      if ($currentPath -notlike "*$ExtractPath*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$ExtractPath", "User")
        Write-Host "[install-goose] Added Goose to user PATH" -ForegroundColor Green
      }
    } catch {
      Write-Host "[install-goose] Could not update PATH (non-fatal)" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "[install-goose] Goose already installed at $($GoosePath.Source)" -ForegroundColor Green
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Verify Goose is available
# ──────────────────────────────────────────────────────────────────────────────
$GoosePath = Get-Command "goose" -ErrorAction SilentlyContinue
if (-not $GoosePath) {
  Write-Host "[install-goose] WARNING: goose not found in PATH." -ForegroundColor Yellow
  Write-Host "  The install may have completed but you need to restart your terminal." -ForegroundColor Yellow
  Write-Host "  Or add the install directory to your PATH manually." -ForegroundColor Yellow
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Create Goose config directory and config.yaml
# ──────────────────────────────────────────────────────────────────────────────
$GooseConfigDir = "$env:APPDATA\Block\goose\config"
$GooseCustomProvidersDir = "$GooseConfigDir\custom_providers"

New-Item -ItemType Directory -Path $GooseConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $GooseCustomProvidersDir -Force | Out-Null

$ConfigPath = "$GooseConfigDir\config.yaml"

# Backup existing config
if (Test-Path $ConfigPath) {
  $BackupPath = "$ConfigPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item $ConfigPath $BackupPath
  Write-Host "[install-goose] Backed up existing config to $BackupPath" -ForegroundColor Gray
}

Write-Host "[install-goose] Writing Goose config to $ConfigPath" -ForegroundColor Yellow

@"
# ==============================================================================
# Goose Configuration — Lumina Edge Integration
# Connects Goose to the local Lumina Edge API at http://localhost:8090/v1
# ==============================================================================

# Provider: OpenAI-compatible (Lumina Edge)
GOOSE_PROVIDER: "openai"
GOOSE_MODEL: ""
GOOSE_MODE: "auto"
GOOSE_MAX_TURNS: 1000

# Lumina Edge API endpoint — no auth required
OPENAI_API_KEY: "lumina-edge"
OPENAI_HOST: "http://localhost:8090"
OPENAI_BASE_PATH: "/v1"

# Extensions: enable the developer builtin for shell + file system access
extensions:
  developer:
    bundled: true
    enabled: true
    name: developer
    timeout: 300
    type: builtin
"@ | Out-File -FilePath $ConfigPath -Encoding utf8

Write-Host "[install-goose] Config written." -ForegroundColor Green

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Create custom provider JSON (fallback / GUI support)
# ──────────────────────────────────────────────────────────────────────────────
$CustomProviderPath = "$GooseCustomProvidersDir\lumina.json"

@"
{
  "name": "lumina_edge",
  "engine": "openai",
  "display_name": "Lumina Edge",
  "description": "Local LLM via Lumina Edge on port 8090",
  "base_url": "http://localhost:8090/v1",
  "models": [],
  "requires_auth": false,
  "supports_streaming": true
}
"@ | Out-File -FilePath $CustomProviderPath -Encoding utf8

Write-Host "[install-goose] Custom provider written to $CustomProviderPath" -ForegroundColor Green

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: Verify connection to Lumina Edge API
# ──────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[install-goose] Checking if Lumina Edge API is running on port 8090..." -ForegroundColor Yellow

try {
  $Response = Invoke-RestMethod -Uri "http://localhost:8090/v1/models" -TimeoutSec 5 -ErrorAction SilentlyContinue
  if ($Response -and $Response.data) {
    Write-Host "[install-goose] Lumina Edge API is running!" -ForegroundColor Green
    Write-Host "[install-goose] Available models:" -ForegroundColor Cyan
    $Response.data | ForEach-Object { Write-Host "  - $($_.id)" }
    Write-Host ""
    Write-Host "[install-goose] You can now run Goose:" -ForegroundColor Green
    Write-Host "  goose session start" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or use the single-command launcher:" -ForegroundColor Cyan
    Write-Host "  .\start-goose.ps1" -ForegroundColor Cyan
  } else {
    throw "No models returned"
  }
} catch {
  Write-Host "[install-goose] Lumina Edge API is not running on port 8090." -ForegroundColor Yellow
  Write-Host "  Start it first with:" -ForegroundColor Yellow
  Write-Host "    .\start_api.ps1" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Then verify with:" -ForegroundColor Yellow
  Write-Host "    curl http://localhost:8090/v1/models" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Or use the combined launcher:" -ForegroundColor Yellow
  Write-Host "    .\start-goose.ps1" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[install-goose] Installation complete!" -ForegroundColor Green
Write-Host "  Config: $ConfigPath" -ForegroundColor Gray
Write-Host ""
Write-Host "  To verify your Goose configuration:" -ForegroundColor Yellow
Write-Host "    goose info -v" -ForegroundColor Cyan
