# ==============================================================================
# CelestiaVid Studio - Minimal Windows Terminal Installer & Updater (PowerShell)
#
# PowerShell One-Liner:
#   irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex
#
# Command Prompt (cmd.exe) One-Liner:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/aswin402/vid_automation/main/install.ps1 | iex"
#
# Optional Environment Variables:
#   $env:CELESTIAVID_VERSION              Release tag to install (default: "latest")
#   $env:CELESTIAVID_FORMAT               "exe" (default NSIS per-user setup) or "msi"
#   $env:CELESTIAVID_UPDATE               "1" to run in explicit update mode
#   $env:CELESTIAVID_SKIP_BACKUP          "1" to skip pre-install app data snapshot
#   $env:CELESTIAVID_DRY_RUN              "1" to preview without installing
#   $env:CELESTIAVID_UPDATE_MANIFEST_URL  Custom release manifest URL override
# ==============================================================================

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
} catch {}
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$Repo = if ($env:CELESTIAVID_REPO) { $env:CELESTIAVID_REPO } else { "aswin402/vid_automation" }
$Version = if ($env:CELESTIAVID_VERSION) { $env:CELESTIAVID_VERSION } else { "latest" }
$Format = if ($env:CELESTIAVID_FORMAT) { $env:CELESTIAVID_FORMAT.ToLower() } else { "exe" }
$IsUpdate = ($env:CELESTIAVID_UPDATE -eq "1") -or ($args -contains "--update") -or ($args -contains "-Update")
$SkipBackup = ($env:CELESTIAVID_SKIP_BACKUP -eq "1") -or ($args -contains "--skip-backup")
$DryRun = ($env:CELESTIAVID_DRY_RUN -eq "1") -or ($args -contains "--dry-run") -or ($args -contains "-DryRun")

$IsInteractive = [Environment]::UserInteractive -and -not [Console]::IsOutputRedirected

# Construct Unicode TUI glyphs via codepoints so script source stays 100% pure 7-bit ASCII (zero BOM)
$SymOk      = [string][char]0x2713
$SymBullet  = [string][char]0x2022
$SymErr     = [string][char]0x2717
$SymDiamond = [string][char]0x25C6
$BarFillCh  = [string][char]0x2501
$BarEmptyCh = [string][char]0x2500
$BoxVert    = [string][char]0x2502
$BoxTop     = "  " + [char]0x256D + ([string][char]0x2500 * 56) + [char]0x256E
$BoxBot     = "  " + [char]0x2570 + ([string][char]0x2500 * 56) + [char]0x256F
$MidDot     = [string][char]0x00B7
$SpinnerFrames = @(
    0x280B, 0x2819, 0x2839, 0x2838, 0x283C,
    0x2834, 0x2826, 0x2827, 0x2807, 0x280F
) | ForEach-Object { [string][char]$_ }

function Write-StepOk([string]$Message) {
    Write-Host "  " -NoNewline
    Write-Host $SymOk -ForegroundColor Green -NoNewline
    Write-Host " $Message"
}

function Write-StepInfo([string]$Message) {
    Write-Host "  " -NoNewline
    Write-Host $SymBullet -ForegroundColor Cyan -NoNewline
    Write-Host " $Message"
}

function Write-StepWarn([string]$Message) {
    Write-Host "  " -NoNewline
    Write-Host "!" -ForegroundColor Yellow -NoNewline
    Write-Host " $Message"
}

function Write-StepErr([string]$Message) {
    Write-Host "  " -NoNewline
    Write-Host $SymErr -ForegroundColor Red -NoNewline
    Write-Host " $Message"
}

function Format-Megabytes([long]$Bytes) {
    return ("{0:N1} MB" -f ($Bytes / 1MB))
}

$ModeLabel = if ($IsUpdate) { "Updater  " } else { "Installer" }

Write-Host ""
Write-Host $BoxTop -ForegroundColor DarkGray
Write-Host ("  $BoxVert  ") -ForegroundColor DarkGray -NoNewline
Write-Host "$SymDiamond " -ForegroundColor Magenta -NoNewline
Write-Host "CelestiaVid Studio                     " -ForegroundColor White -NoNewline
Write-Host "$ModeLabel" -ForegroundColor Cyan -NoNewline
Write-Host "    $BoxVert" -ForegroundColor DarkGray
Write-Host "  $BoxVert    AI Branded Video Automation $MidDot Windows (x64)         $BoxVert" -ForegroundColor DarkGray
Write-Host $BoxBot -ForegroundColor DarkGray
Write-Host ""

# ---------------------- Step 1: Resolve Release Metadata ----------------------
$ApiUrl = if ($env:CELESTIAVID_UPDATE_MANIFEST_URL) {
    $env:CELESTIAVID_UPDATE_MANIFEST_URL
} elseif ($Version -eq "latest") {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

if ($IsInteractive) {
    Write-Host -NoNewline "  $($SpinnerFrames[0]) Checking release feed ($Version)..." -ForegroundColor Gray
}
$Headers = @{
    "Accept"     = "application/vnd.github+json"
    "User-Agent" = "CelestiaVid-Windows-Installer"
}
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers -Method Get
if ($IsInteractive) {
    Write-Host "`r$(' ' * 76)`r" -NoNewline
}

$TagName = $Release.tag_name
if (-not $TagName) {
    Write-StepErr "Failed to resolve release tag from $ApiUrl"
    throw "Unable to resolve release tag."
}
Write-StepOk "Resolved target release $TagName"

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
    Write-StepErr "No Windows installer (.exe or .msi) found on release $TagName."
    throw "No Windows asset found on release $TagName."
}

$ExpectedBytes = if ($Asset.size) { [long]$Asset.size } else { 0L }
$ExpectedSha256 = $null
if ($Asset.PSObject.Properties.Name -contains "digest" -and $Asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
    $ExpectedSha256 = $Matches[1].ToLowerInvariant()
}

# ------------------- Step 2: Automatic App Data Backup ------------------------
$DataDir = if ($env:CELESTIAVID_DATA_DIR) {
    $env:CELESTIAVID_DATA_DIR
} else {
    Join-Path $env:LOCALAPPDATA "celestiavid"
}
$DbFile = Join-Path $DataDir "celestiavid.db"
$BackupSummary = "Fresh setup (no prior DB)"

if ($SkipBackup) {
    $BackupSummary = "Skipped (--skip-backup)"
    Write-StepInfo "Skipped app data backup"
} elseif (Test-Path $DbFile) {
    $CleanVer = $TagName.TrimStart('v', 'V')
    $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $BackupId = "backup-cli-$CleanVer-$Stamp"
    $BackupDir = Join-Path (Join-Path $DataDir "backups") $BackupId

    if ($DryRun) {
        $BackupSummary = "[Dry Run] $BackupId"
        Write-StepInfo "[Dry Run] Would snapshot existing app data -> $BackupDir"
    } else {
        if ($IsInteractive) {
            Write-Host -NoNewline "  $($SpinnerFrames[1]) Backing up existing CelestiaVid projects & database..." -ForegroundColor Gray
        }
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        Copy-Item -Path $DbFile -Destination (Join-Path $BackupDir "celestiavid.db") -Force
        if (Test-Path "$DbFile-wal") {
            Copy-Item -Path "$DbFile-wal" -Destination (Join-Path $BackupDir "celestiavid.db-wal") -Force
        }
        if (Test-Path "$DbFile-shm") {
            Copy-Item -Path "$DbFile-shm" -Destination (Join-Path $BackupDir "celestiavid.db-shm") -Force
        }

        $StorageDir = Join-Path $DataDir "storage"
        $IncludesStorage = $false
        if (Test-Path $StorageDir) {
            Copy-Item -Path $StorageDir -Destination (Join-Path $BackupDir "storage") -Recurse -Force
            $IncludesStorage = $true
        }

        $Manifest = @{
            id               = $BackupId
            label            = "CLI Pre-Install Backup (-> $TagName)"
            reason           = "pre-update"
            app_version      = $CleanVer
            created_at       = (Get-Date).ToUniversalTime().ToString("o")
            path             = $BackupDir
            size_bytes       = 0
            project_count    = 0
            batch_count      = 0
            asset_count      = 0
            includes_storage = $IncludesStorage
        } | ConvertTo-Json -Depth 4
        Set-Content -Path (Join-Path $BackupDir "backup_manifest.json") -Value $Manifest -Encoding UTF8

        if ($IsInteractive) {
            Write-Host "`r$(' ' * 78)`r" -NoNewline
        }
        $BackupSummary = $BackupId
        Write-StepOk "Backed up app data ($BackupId)"
    }
}

$DownloadUrl = $Asset.browser_download_url
$TempInstaller = Join-Path $env:TEMP "CelestiaVid-$($TagName.TrimStart('v'))-$($Asset.name)"
$PartInstaller = "$TempInstaller.part"

if ($DryRun) {
    Write-StepInfo "[Dry Run] Would download & verify $($Asset.name) ($(Format-Megabytes $ExpectedBytes)) from $DownloadUrl"
    return
}

# -------- Step 3: Resumable Download + Size & SHA-256 Verification ------------
if (Test-Path $TempInstaller) {
    Remove-Item $TempInstaller -Force -ErrorAction SilentlyContinue
}
if (Test-Path $PartInstaller) {
    Remove-Item $PartInstaller -Force -ErrorAction SilentlyContinue
}

Add-Type -AssemblyName System.Net.Http
$Handler = New-Object System.Net.Http.HttpClientHandler
$Handler.AllowAutoRedirect = $true
$HttpClient = New-Object System.Net.Http.HttpClient($Handler)
$HttpClient.Timeout = [TimeSpan]::FromMinutes(30)
$HttpClient.DefaultRequestHeaders.Add("User-Agent", "CelestiaVid-Windows-Installer")

$MaxAttempts = 8
$Attempt = 0
$Downloaded = 0L

try {
    while ($Attempt -lt $MaxAttempts) {
        $Attempt++
        $ExistingBytes = if (Test-Path $PartInstaller) { (Get-Item $PartInstaller).Length } else { 0L }
        if ($ExpectedBytes -gt 0 -and $ExistingBytes -ge $ExpectedBytes) {
            $Downloaded = $ExistingBytes
            break
        }

        try {
            $ReqMsg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $DownloadUrl)
            if ($ExistingBytes -gt 0) {
                $ReqMsg.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue($ExistingBytes, $null)
            }

            $Response = $HttpClient.SendAsync($ReqMsg, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            $StatusCode = [int]$Response.StatusCode

            if ($ExistingBytes -gt 0 -and $StatusCode -eq 206) {
                $FileMode = [System.IO.FileMode]::Append
                $Downloaded = $ExistingBytes
            } elseif ($StatusCode -ge 200 -and $StatusCode -lt 300) {
                $FileMode = [System.IO.FileMode]::Create
                $Downloaded = 0L
            } else {
                $Response.Dispose()
                throw "HTTP status $StatusCode"
            }

            $TotalBytes = if ($ExpectedBytes -gt 0) {
                $ExpectedBytes
            } elseif ($Response.Content.Headers.ContentLength) {
                $Downloaded + [long]$Response.Content.Headers.ContentLength
            } else {
                0L
            }

            $NetStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $FileStream = New-Object System.IO.FileStream($PartInstaller, $FileMode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 65536)
            $Buffer = New-Object byte[] 65536
            $FrameIdx = 0
            $BarWidth = 22
            $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

            try {
                while (($Read = $NetStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                    $FileStream.Write($Buffer, 0, $Read)
                    $Downloaded += $Read

                    if ($IsInteractive -and $Stopwatch.ElapsedMilliseconds -ge 65) {
                        $Stopwatch.Restart()
                        $Frame = $SpinnerFrames[$FrameIdx % $SpinnerFrames.Count]
                        $FrameIdx++

                        if ($TotalBytes -gt 0) {
                            $Pct = [Math]::Min(100, [int](($Downloaded * 100) / $TotalBytes))
                            $Filled = [int](($Pct * $BarWidth) / 100)
                            $Empty = $BarWidth - $Filled
                            $Bar = ($BarFillCh * $Filled) + ($BarEmptyCh * $Empty)
                            $Line = "  $Frame Downloading installer  $Bar  $($Pct.ToString().PadLeft(3))% ($(Format-Megabytes $Downloaded) / $(Format-Megabytes $TotalBytes))"
                            Write-Host "`r$($Line.PadRight(79))" -NoNewline -ForegroundColor Cyan
                        } else {
                            $Line = "  $Frame Downloading installer  $(Format-Megabytes $Downloaded)"
                            Write-Host "`r$($Line.PadRight(79))" -NoNewline -ForegroundColor Cyan
                        }
                    }
                }
                $FileStream.Flush()
            } finally {
                $FileStream.Dispose()
                $NetStream.Dispose()
                $Response.Dispose()
            }
        } catch {
            # Transient socket drop or timeout - loop will resume via HTTP Range
        }

        $CurrentBytes = if (Test-Path $PartInstaller) { (Get-Item $PartInstaller).Length } else { 0L }
        $Downloaded = $CurrentBytes

        if ($ExpectedBytes -le 0 -and $CurrentBytes -gt 0) {
            break
        }
        if ($ExpectedBytes -gt 0 -and $CurrentBytes -ge $ExpectedBytes) {
            break
        }

        if ($Attempt -lt $MaxAttempts) {
            if ($IsInteractive) {
                Write-Host "`r$(' ' * 80)`r" -NoNewline
                Write-StepWarn "Connection interrupted at $(Format-Megabytes $CurrentBytes) / $(Format-Megabytes $ExpectedBytes) - resuming ($Attempt/$MaxAttempts)..."
            }
            Start-Sleep -Seconds 2
        }
    }
} finally {
    $HttpClient.Dispose()
    $Handler.Dispose()
}

# Built-in Windows curl.exe fallback if .NET HttpClient stream was still incomplete
$CurrentBytes = if (Test-Path $PartInstaller) { (Get-Item $PartInstaller).Length } else { 0L }
if (($ExpectedBytes -gt 0 -and $CurrentBytes -lt $ExpectedBytes) -or $CurrentBytes -eq 0) {
    $CurlCmd = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($CurlCmd) {
        if ($IsInteractive) {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
        }
        Write-StepInfo "Completing download via Windows curl.exe..."
        & $CurlCmd.Source -fL --retry 5 --retry-delay 2 -C - -o "$PartInstaller" "$DownloadUrl"
        $CurrentBytes = if (Test-Path $PartInstaller) { (Get-Item $PartInstaller).Length } else { 0L }
        $Downloaded = $CurrentBytes
    }
}

if ($IsInteractive) {
    Write-Host "`r$(' ' * 80)`r" -NoNewline
}

if ($ExpectedBytes -gt 0 -and $Downloaded -ne $ExpectedBytes) {
    if (Test-Path $PartInstaller) {
        Remove-Item $PartInstaller -Force -ErrorAction SilentlyContinue
    }
    Write-StepErr "Incomplete download ($(Format-Megabytes $Downloaded) received, expected $(Format-Megabytes $ExpectedBytes))."
    throw "Installer download was incomplete ($Downloaded / $ExpectedBytes bytes). Please check your network and re-run."
}

Move-Item -Path $PartInstaller -Destination $TempInstaller -Force
Write-StepOk "Downloaded $($Asset.name) ($(Format-Megabytes $Downloaded))"

if ($ExpectedSha256) {
    $ActualSha256 = (Get-FileHash -Path $TempInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $ExpectedSha256) {
        Remove-Item $TempInstaller -Force -ErrorAction SilentlyContinue
        Write-StepErr "SHA-256 checksum mismatch (expected $ExpectedSha256, got $ActualSha256)."
        throw "Downloaded installer failed SHA-256 integrity verification."
    }
    Write-StepOk "Verified SHA-256 package integrity"
}

try {
    Unblock-File -Path $TempInstaller -ErrorAction SilentlyContinue
} catch {}

# --------------- Step 4: Animated Silent Install & PATH Setup -----------------
try {
    Get-Process -Name "celestiavid-desktop", "CelestiaVid" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400

    if ($Asset.name -match '\.msi$') {
        $Proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$TempInstaller`" /passive /norestart" -PassThru
    } else {
        $Proc = Start-Process -FilePath $TempInstaller -ArgumentList "/S" -PassThru
    }

    $SpinIdx = 0
    while (-not $Proc.HasExited) {
        if ($IsInteractive) {
            $F = $SpinnerFrames[$SpinIdx % $SpinnerFrames.Count]
            $SpinIdx++
            Write-Host "`r  $F Installing CelestiaVid $TagName (per-user setup)...   " -NoNewline -ForegroundColor Gray
        }
        Start-Sleep -Milliseconds 85
    }
    if ($IsInteractive) {
        Write-Host "`r$(' ' * 76)`r" -NoNewline
    }

    if ($Proc.ExitCode -ne 0) {
        Write-StepErr "Installer exited with code $($Proc.ExitCode)"
        throw "Installer failed with exit code $($Proc.ExitCode)"
    }
    Write-StepOk "Installed CelestiaVid $TagName"
} finally {
    if (Test-Path $TempInstaller) {
        Remove-Item $TempInstaller -Force -ErrorAction SilentlyContinue
    }
}

$CandidateDirs = @(
    (Join-Path $env:LOCALAPPDATA "CelestiaVid"),
    (Join-Path $env:LOCALAPPDATA "Programs\CelestiaVid")
)
$InstalledDir = $CandidateDirs | Where-Object { Test-Path $_ } | Select-Object -First 1
$LaunchDisplay = "Start Menu -> CelestiaVid"

if ($InstalledDir) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $UserPath) { $UserPath = "" }
    $PathEntries = $UserPath -split ";" | Where-Object { $_ -ne "" }
    if ($PathEntries -notcontains $InstalledDir) {
        $NewUserPath = if ($UserPath) { "$UserPath;$InstalledDir" } else { $InstalledDir }
        [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
        $env:Path = "$env:Path;$InstalledDir"
        Write-StepOk "Added $InstalledDir to User PATH"
    }
    $ExeFile = Get-ChildItem -Path $InstalledDir -Filter "*.exe" | Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
    if ($ExeFile) {
        $LaunchDisplay = $ExeFile.Name
    }
}

$LocText = if ($InstalledDir) { $InstalledDir } else { "%LOCALAPPDATA%\CelestiaVid" }
if ($LocText.Length -gt 42) { $LocText = "..." + $LocText.Substring($LocText.Length - 39) }
$BakText = $BackupSummary
if ($BakText.Length -gt 42) { $BakText = $BakText.Substring(0, 42) }

Write-Host ""
Write-Host $BoxTop -ForegroundColor DarkGray
Write-Host ("  $BoxVert  ") -ForegroundColor DarkGray -NoNewline
Write-Host "$SymOk " -ForegroundColor Green -NoNewline
Write-Host ("CelestiaVid {0,-10} is ready                    " -f $TagName) -ForegroundColor White -NoNewline
Write-Host $BoxVert -ForegroundColor DarkGray
Write-Host "  $BoxVert                                                        $BoxVert" -ForegroundColor DarkGray
Write-Host ("  $BoxVert  Location  {0,-43} $BoxVert" -f $LocText) -ForegroundColor Gray
Write-Host ("  $BoxVert  Backup    {0,-43} $BoxVert" -f $BakText) -ForegroundColor Gray
Write-Host "  $BoxVert  Launch    " -ForegroundColor Gray -NoNewline
Write-Host ("{0,-43}" -f $LaunchDisplay) -ForegroundColor Cyan -NoNewline
Write-Host " $BoxVert" -ForegroundColor DarkGray
Write-Host $BoxBot -ForegroundColor DarkGray
Write-Host ""
