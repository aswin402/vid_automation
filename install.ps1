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
#   $env:CELESTIAVID_NO_LAUNCH            "1" to skip launching CelestiaVid after install
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
$NoLaunch = ($env:CELESTIAVID_NO_LAUNCH -eq "1") -or ($args -contains "--no-launch") -or ($args -contains "-NoLaunch")
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

function Select-WindowsAsset($Assets, [string]$PreferredFormat) {
    if (-not $Assets) { return $null }
    if ($PreferredFormat -eq "msi") {
        return ($Assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1)
    }
    $ExeAsset = $Assets | Where-Object { $_.name -match 'setup\.exe$' -or $_.name -match '\.exe$' } | Select-Object -First 1
    if ($ExeAsset) { return $ExeAsset }
    return ($Assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1)
}

function Normalize-SemverPrefix([string]$RawVersion) {
    if (-not $RawVersion) { return "" }
    $Trimmed = $RawVersion.Trim().TrimStart('v', 'V')
    if ($Trimmed -match '^(\d+\.\d+\.\d+)') {
        return $Matches[1]
    }
    return $Trimmed
}

function Get-ExeVersionString([string]$ExePath) {
    if (-not (Test-Path $ExePath)) { return "" }
    try {
        $Info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ExePath)
        if ($Info.ProductVersion -and $Info.ProductVersion.Trim() -ne "") {
            return (Normalize-SemverPrefix $Info.ProductVersion)
        }
        if ($Info.FileVersion -and $Info.FileVersion.Trim() -ne "") {
            return (Normalize-SemverPrefix $Info.FileVersion)
        }
    } catch {}
    return ""
}

function Stop-AllCelestiaVidProcesses {
    # 1. Stop main CelestiaVid binaries by name
    $Names = @("celestiavid-desktop", "CelestiaVid", "celestiavid")
    foreach ($N in $Names) {
        Get-Process -Name $N -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    # 2. Stop any process executing out of a CelestiaVid install directory
    try {
        Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $PPath = $_.Path
                if ($PPath -and ($PPath -match '(?i)\\CelestiaVid\\' -or $PPath -match '(?i)\\com\.celestialabs\.celestiavid\\')) {
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                }
            } catch {}
        }
    } catch {}

    # 3. Stop lingering WebView2 children bound to CelestiaVid user data dir so file locks release
    try {
        $WvProcs = $null
        if (Get-Command "Get-CimInstance" -ErrorAction SilentlyContinue) {
            $WvProcs = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue
        } elseif (Get-Command "Get-WmiObject" -ErrorAction SilentlyContinue) {
            $WvProcs = Get-WmiObject Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue
        }
        if ($WvProcs) {
            foreach ($Wv in $WvProcs) {
                if ($Wv.CommandLine -and ($Wv.CommandLine -match '(?i)celestiavid')) {
                    Stop-Process -Id $Wv.ProcessId -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}

    # 4. Wait up to 8 seconds for OS handles to fully close
    for ($i = 0; $i -lt 32; $i++) {
        $StillRunning = Get-Process -Name "celestiavid-desktop", "CelestiaVid" -ErrorAction SilentlyContinue
        if (-not $StillRunning) { break }
        Start-Sleep -Milliseconds 250
    }
}

function Clear-CelestiaVidWebViewCache {
    $WvRoots = @(
        (Join-Path $env:LOCALAPPDATA "com.celestialabs.celestiavid\EBWebView\Default"),
        (Join-Path $env:APPDATA "com.celestialabs.celestiavid\EBWebView\Default"),
        (Join-Path $env:LOCALAPPDATA "CelestiaVid\EBWebView\Default")
    )
    $CacheSubdirs = @(
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "Service Worker\CacheStorage",
        "Service Worker\ScriptCache"
    )
    $ClearedAny = $false
    foreach ($Root in $WvRoots) {
        if (Test-Path $Root) {
            foreach ($Sub in $CacheSubdirs) {
                $Target = Join-Path $Root $Sub
                if (Test-Path $Target) {
                    try {
                        Remove-Item -Path $Target -Recurse -Force -ErrorAction SilentlyContinue
                        $ClearedAny = $true
                    } catch {}
                }
            }
        }
    }
    return $ClearedAny
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
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "CelestiaVid-Windows-Installer"
    "Cache-Control" = "no-cache"
    "Pragma"        = "no-cache"
}
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers -Method Get
$Asset = Select-WindowsAsset -Assets $Release.assets -PreferredFormat $Format

# If latest release is mid-CI-publish and Windows asset is not attached yet, pick newest release with a Windows installer
if (-not $Asset -and $Version -eq "latest" -and -not $env:CELESTIAVID_UPDATE_MANIFEST_URL) {
    try {
        $RecentReleases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=8" -Headers $Headers -Method Get
        foreach ($Cand in $RecentReleases) {
            if ($Cand.draft) { continue }
            $CandAsset = Select-WindowsAsset -Assets $Cand.assets -PreferredFormat $Format
            if ($CandAsset) {
                $Release = $Cand
                $Asset = $CandAsset
                break
            }
        }
    } catch {}
}

if ($IsInteractive) {
    Write-Host "`r$(' ' * 76)`r" -NoNewline
}

$TagName = $Release.tag_name
if (-not $TagName) {
    Write-StepErr "Failed to resolve release tag from $ApiUrl"
    throw "Unable to resolve release tag."
}
$CleanVer = Normalize-SemverPrefix $TagName
Write-StepOk "Resolved target release $TagName"

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
$TempInstaller = Join-Path $env:TEMP "CelestiaVid-$CleanVer-$($Asset.name)"
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

# ------ Step 4: Clean Previous Builds, Install & Verify Binary Version --------
$TargetInstallDir = Join-Path $env:LOCALAPPDATA "CelestiaVid"
$PriorInstallDirs = New-Object System.Collections.Generic.List[string]
$PriorInstallDirs.Add($TargetInstallDir)
$PriorInstallDirs.Add((Join-Path $env:LOCALAPPDATA "Programs\CelestiaVid"))

try {
    Stop-AllCelestiaVidProcesses

    # Scan Uninstall Registry for prior MSI or custom-directory installations
    $UninstallRoots = @(
        @{ Hive = "HKCU"; Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" },
        @{ Hive = "HKLM"; Path = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" },
        @{ Hive = "HKLM"; Path = "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" }
    )
    foreach ($RootInfo in $UninstallRoots) {
        try {
            $Items = Get-ItemProperty -Path $RootInfo.Path -ErrorAction SilentlyContinue | Where-Object {
                $_.DisplayName -like "*CelestiaVid*" -or $_.PSChildName -like "*CelestiaVid*"
            }
            foreach ($Item in $Items) {
                if ($Item.InstallLocation -and (Test-Path $Item.InstallLocation)) {
                    $CleanLoc = $Item.InstallLocation.TrimEnd('\')
                    if (-not $PriorInstallDirs.Contains($CleanLoc)) {
                        $PriorInstallDirs.Add($CleanLoc)
                    }
                }
                # If switching/updating to NSIS (.exe) and a legacy MSI per-machine install exists, remove the MSI so Program Files doesn't shadow per-user!
                $IsMsiEntry = ($Item.WindowsInstaller -eq 1) -or ($Item.PSChildName -match '^\{[0-9A-Fa-f\-]+\}$')
                if ($IsMsiEntry -and ($Asset.name -notmatch '\.msi$')) {
                    Write-StepInfo "Removing legacy MSI installation ($($Item.DisplayName) $($Item.DisplayVersion))..."
                    try {
                        if ($RootInfo.Hive -eq "HKLM") {
                            Start-Process -FilePath "msiexec.exe" -ArgumentList "/x $($Item.PSChildName) /passive /norestart" -Verb RunAs -Wait -ErrorAction Stop | Out-Null
                        } else {
                            Start-Process -FilePath "msiexec.exe" -ArgumentList "/x $($Item.PSChildName) /passive /norestart" -Wait -ErrorAction Stop | Out-Null
                        }
                        Write-StepOk "Removed legacy MSI copy so old shortcuts cannot shadow $TagName"
                    } catch {
                        Write-StepWarn "Could not auto-remove legacy MSI in Program Files (approve UAC or uninstall old MSI in Settings > Apps if needed)."
                    }
                }
            }
        } catch {}
    }

    # Pin NSIS InstallDirRegKey to %LOCALAPPDATA%\CelestiaVid so silent setup always installs to a single predictable location
    if ($Asset.name -notmatch '\.msi$') {
        foreach ($SubKeyName in @(
            "Software\com.celestialabs.celestiavid\CelestiaVid",
            "Software\CelestiaLabs\CelestiaVid"
        )) {
            try {
                $RegKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKeyName)
                if ($RegKey) {
                    $PrevDir = $RegKey.GetValue("")
                    if ($PrevDir -and (Test-Path ([string]$PrevDir))) {
                        $CleanPrev = ([string]$PrevDir).TrimEnd('\')
                        if (-not $PriorInstallDirs.Contains($CleanPrev)) {
                            $PriorInstallDirs.Add($CleanPrev)
                        }
                    }
                    $RegKey.SetValue("", $TargetInstallDir, [Microsoft.Win32.RegistryValueKind]::String)
                    $RegKey.Close()
                }
            } catch {}
        }

        # Explicitly delete old per-user CelestiaVid executables BEFORE NSIS runs so silent setup can never skip overwriting
        foreach ($OldDir in $PriorInstallDirs) {
            if ($OldDir -match '(?i)\\Program Files') { continue }
            if (-not (Test-Path $OldDir)) { continue }
            foreach ($OldExeName in @("celestiavid-desktop.exe", "CelestiaVid.exe")) {
                $OldExePath = Join-Path $OldDir $OldExeName
                if (Test-Path $OldExePath) {
                    for ($r = 0; $r -lt 15; $r++) {
                        try {
                            Remove-Item -Path $OldExePath -Force -ErrorAction Stop
                            break
                        } catch {
                            Stop-AllCelestiaVidProcesses
                            Start-Sleep -Milliseconds 350
                        }
                    }
                }
            }
        }
    }

    # Clear persistent WebView2 HTTP & JS bytecode cache so fresh UI bundle always loads
    if (Clear-CelestiaVidWebViewCache) {
        Write-StepOk "Cleared stale WebView2 UI cache"
    }

    if ($Asset.name -match '\.msi$') {
        $Proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$TempInstaller`" /passive /norestart" -PassThru
    } else {
        # NSIS /D= must be unquoted and the final parameter on the command line
        $Proc = Start-Process -FilePath $TempInstaller -ArgumentList "/S /D=$TargetInstallDir" -PassThru
    }

    $SpinIdx = 0
    while (-not $Proc.HasExited) {
        if ($IsInteractive) {
            $F = $SpinnerFrames[$SpinIdx % $SpinnerFrames.Count]
            $SpinIdx++
            Write-Host "`r  $F Installing CelestiaVid $TagName...                    " -NoNewline -ForegroundColor Gray
        }
        Start-Sleep -Milliseconds 85
    }
    if ($IsInteractive) {
        Write-Host "`r$(' ' * 76)`r" -NoNewline
    }

    # Locate installed binary and verify its embedded PE ProductVersion matches $CleanVer
    $SearchDirs = @(
        $TargetInstallDir,
        (Join-Path $env:LOCALAPPDATA "Programs\CelestiaVid"),
        (Join-Path $env:ProgramFiles "CelestiaVid")
    )
    $VerifiedExe = $null
    foreach ($Dir in $SearchDirs) {
        if (-not (Test-Path $Dir)) { continue }
        $CandExe = Get-ChildItem -Path $Dir -Filter "*.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '(?i)uninstall|ffmpeg|ffprobe' } |
            Select-Object -First 1
        if ($CandExe) {
            $FoundVer = Get-ExeVersionString $CandExe.FullName
            if ($FoundVer -eq $CleanVer) {
                $VerifiedExe = $CandExe
                break
            }
        }
    }

    # Fallback: if silent /S aborted or version mismatched, run passive (/P) installer and re-verify
    if (($Proc.ExitCode -ne 0 -or -not $VerifiedExe) -and ($Asset.name -notmatch '\.msi$')) {
        Write-StepWarn "Silent setup needs passive retry to replace binary - running passive updater..."
        Stop-AllCelestiaVidProcesses
        $RetryProc = Start-Process -FilePath $TempInstaller -ArgumentList "/P /D=$TargetInstallDir" -Wait -PassThru
        foreach ($Dir in $SearchDirs) {
            if (-not (Test-Path $Dir)) { continue }
            $CandExe = Get-ChildItem -Path $Dir -Filter "*.exe" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '(?i)uninstall|ffmpeg|ffprobe' } |
                Select-Object -First 1
            if ($CandExe) {
                $FoundVer = Get-ExeVersionString $CandExe.FullName
                if ($FoundVer -eq $CleanVer -or $RetryProc.ExitCode -eq 0) {
                    $VerifiedExe = $CandExe
                    break
                }
            }
        }
        if (-not $VerifiedExe) {
            Write-StepErr "Installer exited with code $($RetryProc.ExitCode) and binary v$CleanVer was not found."
            throw "Installer failed to place CelestiaVid v$CleanVer in $TargetInstallDir."
        }
    } elseif ($Proc.ExitCode -ne 0) {
        Write-StepErr "Installer exited with code $($Proc.ExitCode)"
        throw "Installer failed with exit code $($Proc.ExitCode)"
    }

    $ActualVerLabel = if ($VerifiedExe) { Get-ExeVersionString $VerifiedExe.FullName } else { $CleanVer }
    if (-not $ActualVerLabel) { $ActualVerLabel = $CleanVer }
    Write-StepOk "Installed & verified CelestiaVid v$ActualVerLabel"
} finally {
    if (Test-Path $TempInstaller) {
        Remove-Item $TempInstaller -Force -ErrorAction SilentlyContinue
    }
}

$CandidateDirs = @(
    $TargetInstallDir,
    (Join-Path $env:LOCALAPPDATA "Programs\CelestiaVid"),
    (Join-Path $env:ProgramFiles "CelestiaVid")
)
$InstalledDir = if ($VerifiedExe) {
    $VerifiedExe.DirectoryName
} else {
    $CandidateDirs | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$ExeFile = if ($VerifiedExe) {
    $VerifiedExe
} elseif ($InstalledDir) {
    Get-ChildItem -Path $InstalledDir -Filter "*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '(?i)uninstall|ffmpeg|ffprobe' } |
        Select-Object -First 1
} else {
    $null
}
$LaunchDisplay = if ($ExeFile) { $ExeFile.Name } else { "Start Menu -> CelestiaVid" }

if ($InstalledDir) {
    # Place $InstalledDir at the front of User PATH and prune stale CelestiaVid entries
    try {
        $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $UserPath) { $UserPath = "" }
        $KeptEntries = $UserPath -split ";" | Where-Object {
            $_ -ne "" -and $_ -ne $InstalledDir -and -not ($_ -match '(?i)\\CelestiaVid$' -and -not (Test-Path $_))
        }
        $NewUserPath = if ($KeptEntries) {
            "$InstalledDir;" + ($KeptEntries -join ";")
        } else {
            $InstalledDir
        }
        if ($NewUserPath -ne $UserPath) {
            [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
            Write-StepOk "Updated User PATH -> $InstalledDir"
        }
        $env:Path = "$InstalledDir;$env:Path"
    } catch {}
}

# Refresh Start Menu, Desktop & Taskbar shortcuts so every icon points directly to the new binary
if ($ExeFile) {
    try {
        $WshShell = New-Object -ComObject WScript.Shell
        $StartMenuPrograms = [Environment]::GetFolderPath("Programs")
        $DesktopDir = [Environment]::GetFolderPath("Desktop")
        $TaskbarPin = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\CelestiaVid.lnk"

        $ShortcutPaths = New-Object System.Collections.Generic.List[string]
        if ($StartMenuPrograms) {
            $ShortcutPaths.Add((Join-Path $StartMenuPrograms "CelestiaVid.lnk"))
        }
        if ($DesktopDir) {
            $ShortcutPaths.Add((Join-Path $DesktopDir "CelestiaVid.lnk"))
        }
        if (Test-Path $TaskbarPin) {
            $ShortcutPaths.Add($TaskbarPin)
        }

        foreach ($LnkPath in $ShortcutPaths) {
            try {
                $Sc = $WshShell.CreateShortcut($LnkPath)
                $Sc.TargetPath = $ExeFile.FullName
                $Sc.WorkingDirectory = $ExeFile.DirectoryName
                $Sc.Description = "CelestiaVid Studio - AI Branded Video Automation"
                $Sc.IconLocation = "$($ExeFile.FullName),0"
                $Sc.Save()
            } catch {}
        }
        Write-StepOk "Refreshed Desktop & Start Menu shortcuts -> v$CleanVer"
    } catch {}
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

if ($ExeFile -and -not $NoLaunch) {
    try {
        Write-StepInfo "Launching CelestiaVid Studio $TagName..."
        Start-Process -FilePath $ExeFile.FullName -WorkingDirectory $ExeFile.DirectoryName | Out-Null
    } catch {}
}
