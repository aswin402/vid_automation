# ==============================================================================
# CelestiaVid Desktop — Single-Command Windows Installer (PowerShell & CMD)
#
# PowerShell One-Liner:
#   irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex
#
# Command Prompt (cmd.exe) One-Liner:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
#
# Environment Variables (Optional):
#   $env:CELESTIAVID_VERSION  Release tag to install (default: "latest", e.g. "v0.2.0")
#   $env:CELESTIAVID_FORMAT   "exe" (default NSIS per-user setup) or "msi"
# ==============================================================================

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:CELESTIAVID_REPO) { $env:CELESTIAVID_REPO } else { "aswin402/vid_automation" }
$Version = if ($env:CELESTIAVID_VERSION) { $env:CELESTIAVID_VERSION } else { "latest" }
$Format = if ($env:CELESTIAVID_FORMAT) { $env:CELESTIAVID_FORMAT.ToLower() } else { "exe" }

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  CelestiaVid Desktop Installer for Windows (x64)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$ApiUrl = if ($Version -eq "latest") {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

Write-Host "-> Fetching release metadata ($Version) from $Repo..." -ForegroundColor Gray
$Headers = @{
    "Accept"     = "application/vnd.github+json"
    "User-Agent" = "CelestiaVid-Windows-Installer"
}
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers -Method Get
$TagName = $Release.tag_name
Write-Host "-> Resolved release: $TagName" -ForegroundColor Green

$Asset = $null
if ($Format -eq "msi") {
    $Asset = $Release.assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1
} else {
    $Asset = $Release.assets | Where-Object { $_.name -match 'setup\.exe$' -or $_.name -match '\.exe$' } | Select-Object -First 1
    if (-not $Asset) {
        $Asset = $Release.assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1
    }
}

if (-not $Asset) {
    throw "No Windows installer (.exe or .msi) found on GitHub Release $TagName. Visit https://github.com/$Repo/releases/tag/$TagName"
}

$DownloadUrl = $Asset.browser_download_url
$TempInstaller = Join-Path $env:TEMP $Asset.name

if ($env:CELESTIAVID_DRY_RUN -eq "1") {
    Write-Host "-> [Dry Run] Would download & install: $DownloadUrl" -ForegroundColor Cyan
    return
}

Write-Host "-> Downloading $($Asset.name) ($([Math]::Round($Asset.size / 1MB, 1)) MB)..." -ForegroundColor Yellow
$PrevProgress = $ProgressPreference
try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempInstaller -UseBasicParsing
} finally {
    $ProgressPreference = $PrevProgress
}

try {
    if ($Asset.name -match '\.msi$') {
        Write-Host "-> Running Windows MSI Installer..." -ForegroundColor Yellow
        $Proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$TempInstaller`" /passive /norestart" -Wait -PassThru
        if ($Proc.ExitCode -ne 0) {
            throw "MSI installer exited with code $($Proc.ExitCode)"
        }
    } else {
        Write-Host "-> Installing CelestiaVid silently (per-user, no Admin required)..." -ForegroundColor Yellow
        $Proc = Start-Process -FilePath $TempInstaller -ArgumentList "/S" -Wait -PassThru
        if ($Proc.ExitCode -ne 0) {
            throw "NSIS installer exited with code $($Proc.ExitCode)"
        }
    }
} finally {
    if (Test-Path $TempInstaller) {
        Remove-Item $TempInstaller -Force -ErrorAction SilentlyContinue
    }
}

# Add per-user install folder to User PATH so `celestiavid-desktop` can be launched from CMD / PowerShell
$CandidateDirs = @(
    (Join-Path $env:LOCALAPPDATA "CelestiaVid"),
    (Join-Path $env:LOCALAPPDATA "Programs\CelestiaVid")
)

$InstalledDir = $CandidateDirs | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($InstalledDir) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $UserPath) { $UserPath = "" }
    $PathEntries = $UserPath -split ";" | Where-Object { $_ -ne "" }
    if ($PathEntries -notcontains $InstalledDir) {
        $NewUserPath = if ($UserPath) { "$UserPath;$InstalledDir" } else { $InstalledDir }
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
        $env:Path = "$env:Path;$InstalledDir"
        Write-Host "-> Added $InstalledDir to your User PATH." -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "SUCCESS! CelestiaVid $TagName is installed on Windows." -ForegroundColor Green
Write-Host "-> Open 'CelestiaVid' from the Windows Start Menu, or launch from terminal:" -ForegroundColor Cyan
if ($InstalledDir) {
    $ExeFile = Get-ChildItem -Path $InstalledDir -Filter "*.exe" | Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
    if ($ExeFile) {
        Write-Host "   `"$($ExeFile.FullName)`"" -ForegroundColor White
    }
}
Write-Host ""
