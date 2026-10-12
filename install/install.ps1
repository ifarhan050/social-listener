<#
  Social Listener - installer / updater / uninstaller (Windows 10/11). No admin rights needed.

  Easiest: double-click "Install on Windows.cmd" from the Social Listener Setup download.
  Or in PowerShell:
    irm https://raw.githubusercontent.com/__SOCIAL_LISTENER_REPO__/main/install/install.ps1 | iex
  Or from a downloaded copy:
    powershell -ExecutionPolicy Bypass -File install.ps1 [-Repo owner/repo] [-Ref main] [-DryRun]
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall [-RemoveData]

  What it does (re-runnable; your data, settings and Facebook login are kept):
    1. Node.js: uses Node 20+ if installed, otherwise downloads the official Node.js LTS
       (checksum-verified) into the app folder - nothing is installed system-wide.
    2. Downloads the app from GitHub into %LOCALAPPDATA%\social-listener.
    3. Installs its packages and builds it.
    4. Uses your Chrome/Edge (or downloads a private Chromium if neither exists).
    5. Starts it in the background, starts it automatically when you log in,
       and opens the dashboard.
#>
param(
  [string]$Repo = '__SOCIAL_LISTENER_REPO__',
  [string]$Ref = 'main',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'social-listener'),
  [switch]$DryRun,
  [switch]$NoStart,
  [switch]$NoAutostart,
  [switch]$Uninstall,
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$TOTAL = 6
function Step([int]$n, [string]$m) { Write-Host ''; Write-Host "[$n/$TOTAL] $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "      $m" }
# throw (not exit): when run via "irm ... | iex", exit would close the user's PowerShell window.
function Fail([string]$m, [string]$fix = '') {
  Write-Host ''
  Write-Host "Setup stopped: $m" -ForegroundColor Red
  if ($fix) { Write-Host "What to do: $fix" -ForegroundColor Yellow }
  throw $m
}

$serviceDir = Join-Path $InstallDir 'service'
$dataDir = Join-Path $serviceDir 'data'
$nodeDir = Join-Path $InstallDir 'runtime\node'
$conn = Join-Path $HOME '.social-listener\connection.json'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Social Listener.lnk'
$menuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Social Listener'
$vbs = Join-Path $InstallDir 'start-hidden.vbs'

function Stop-Service-IfRunning {
  if (Test-Path $conn) {
    try {
      $old = Get-Content $conn -Raw | ConvertFrom-Json
      if ($old.pid) { Stop-Process -Id $old.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
    } catch {}
  }
}

# --- User PATH (HKCU, no admin), keeping %VARIABLES% unexpanded ------------------------------
function Get-UserPath { (Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames') }
function Set-UserPath([string]$value) {
  Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $value -Type ExpandString
  # Tell running apps (Explorer, Claude) that the environment changed.
  if (-not ('SL.Native' -as [type])) {
    Add-Type -Namespace SL -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  }
  $r = [UIntPtr]::Zero
  [void][SL.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}
function Add-ToUserPath([string]$dir) {
  $p = Get-UserPath
  if (($p -split ';') -contains $dir) { return $false }
  Set-UserPath ((@($p.TrimEnd(';'), $dir) | Where-Object { $_ }) -join ';')
  return $true
}
function Remove-FromUserPath([string]$dir) {
  $p = Get-UserPath
  $parts = $p -split ';' | Where-Object { $_ -and $_ -ne $dir }
  if (($parts -join ';') -ne $p) { Set-UserPath ($parts -join ';') }
}

function New-Shortcut([string]$path, [string]$target, [string]$arguments, [string]$workDir) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($path)
  $s.TargetPath = $target
  $s.Arguments = $arguments
  if ($workDir) { $s.WorkingDirectory = $workDir }
  $s.Save()
}

# --- Uninstall ------------------------------------------------------------------------------
if ($Uninstall) {
  Write-Host 'Uninstalling Social Listener...' -ForegroundColor Cyan
  if ($DryRun) {
    Write-Host "  Stop the service; remove $startupLnk and $menuDir; remove $nodeDir from your PATH;"
    Write-Host "  delete $InstallDir (keeping service\data unless -RemoveData)."
    return
  }
  Stop-Service-IfRunning
  Remove-Item $startupLnk, $menuDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-FromUserPath $nodeDir
  Remove-Item $conn -Force -ErrorAction SilentlyContinue
  $wipe = $RemoveData
  if (-not $wipe -and (Test-Path $dataDir) -and [Environment]::UserInteractive) {
    $a = Read-Host 'Also delete your saved results and the Facebook login? Type YES to delete, or press Enter to keep them'
    $wipe = ($a -eq 'YES')
  }
  if (Test-Path $InstallDir) {
    if ($wipe) { Remove-Item $InstallDir -Recurse -Force }
    else {
      Get-ChildItem $InstallDir | Where-Object { $_.Name -ne 'service' } | Remove-Item -Recurse -Force
      Get-ChildItem $serviceDir -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('data', '.env') } | Remove-Item -Recurse -Force
      Write-Host "Kept your data in $serviceDir (delete that folder to remove it)."
    }
  }
  Write-Host 'Social Listener was removed. You can also remove the plugin in Claude -> Customize -> Plugins.' -ForegroundColor Green
  return
}

if ($Repo -like '__*__' -and $env:SOCIAL_LISTENER_REPO) { $Repo = $env:SOCIAL_LISTENER_REPO }
if ($Repo -like '__*__') { Fail 'No GitHub repository configured.' 'Run with -Repo <owner>/<repo>.' }
if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail "Invalid -Repo '$Repo' (expected owner/repo)." }
if ($Ref -notmatch '^[A-Za-z0-9_./-]+$') { Fail "Invalid -Ref '$Ref'." }
$zipUrl = "https://codeload.github.com/$Repo/zip/$Ref"
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }

# --- Node.js ---------------------------------------------------------------------------------
function Find-SystemNode {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n -or $n.Source -like "$nodeDir*") { return $null }
  try { $major = [int]((& $n.Source -v).TrimStart('v').Split('.')[0]) } catch { return $null }
  if ($major -ge 20) { return $n.Source }
  return $null
}

function Install-PrivateNode {
  Info 'Finding the latest Node.js LTS release on nodejs.org'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $rel = $index | Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 22 } | Select-Object -First 1
  if (-not $rel) { Fail 'Could not find a Node.js LTS download for this computer.' 'Check your internet connection and run the installer again.' }
  $ver = $rel.version
  $name = "node-$ver-win-$arch"
  $base = "https://nodejs.org/dist/$ver"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("sl-node-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Info "Downloading Node.js $ver ($arch)"
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
    if (-not $line) { Fail 'Could not verify the Node.js download (no checksum found).' 'Run the installer again later.' }
    $expected = ($line.Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($expected -ne $actual) { Fail 'The Node.js download failed its checksum check, so it was not used.' 'Run the installer again; if it keeps failing, check for a proxy or antivirus changing downloads.' }
    Info 'Checksum OK. Unpacking'
    Expand-Archive -Path $zip -DestinationPath $tmp
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $nodeDir) | Out-Null
    Move-Item (Join-Path $tmp $name) $nodeDir
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($DryRun) {
  $sys = Find-SystemNode
  Write-Host 'Dry run - nothing will be changed. Steps:'
  if (Test-Path (Join-Path $nodeDir 'node.exe')) { Write-Host "  1. Node.js: use the app's own copy in $nodeDir" }
  elseif ($sys) { Write-Host "  1. Node.js: use the installed $sys" }
  else {
    Write-Host "  1. Node.js: download the latest LTS for win-$arch from https://nodejs.org/dist/index.json,"
    Write-Host "     verify it against SHASUMS256.txt, unpack into $nodeDir, add it to your user PATH (no admin)"
  }
  Write-Host "  2. Download $zipUrl"
  Write-Host "  3. Copy into $InstallDir (keeping service\data and service\.env)"
  Write-Host '  4. npm ci; npm run build -w service'
  Write-Host '  5. Use installed Chrome/Edge, or download a private Chromium if neither exists'
  Write-Host "  6. Start hidden via $vbs; start at login ($startupLnk); Start menu shortcuts; open the dashboard"
  return
}

Write-Host 'Social Listener setup' -ForegroundColor Green
Write-Host "Installing into $InstallDir (no admin rights needed). This takes about 3-10 minutes."

# 1. Node.js
Step 1 'Checking Node.js'
$nodeExe = $null
$pathChanged = $false
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $nodeExe = Join-Path $nodeDir 'node.exe'; Info "Using the app's own Node.js ($(& $nodeExe -v))" }
else {
  $sys = Find-SystemNode
  if ($sys) { $nodeExe = $sys; Info "Using the installed Node.js ($(& $nodeExe -v))" }
  else {
    Info 'Node.js 20+ is not installed; getting a private copy for this app (nothing system-wide).'
    Install-PrivateNode
    $nodeExe = Join-Path $nodeDir 'node.exe'
    Info "Node.js $(& $nodeExe -v) ready"
  }
}
if ($nodeExe -like "$nodeDir*") {
  # Claude starts the plugin with "node": make the app's copy findable (user PATH, no admin).
  $pathChanged = Add-ToUserPath $nodeDir
  $env:Path = "$nodeDir;$env:Path"
  $npm = Join-Path $nodeDir 'npm.cmd'
  $npx = Join-Path $nodeDir 'npx.cmd'
} else { $npm = 'npm'; $npx = 'npx' }

Stop-Service-IfRunning

# 2. Download
Step 2 "Downloading the app ($Repo, $Ref)"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("social-listener-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'src.zip'
  try { Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing }
  catch { Fail "Could not download $zipUrl ($($_.Exception.Message))." 'Check your internet connection and run the installer again.' }
  Expand-Archive -Path $zip -DestinationPath $tmp
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $src.FullName 'service\package.json'))) { Fail 'The download does not look like the Social Listener app.' }

  # 3. Copy (data and .env are not in the archive, so they are never overwritten)
  Step 3 'Copying files'
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $InstallDir -Recurse -Force
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

Push-Location $InstallDir
try {
  Step 4 'Installing packages and building (the longest step)'
  & $npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed.' 'Run the installer again. If it fails again, send the messages above to whoever gave you this app.' }
  & $npm run build -w service --silent
  if ($LASTEXITCODE -ne 0) { Fail 'Building the app failed.' 'Run the installer again, or send the messages above to whoever gave you this app.' }

  # 5. Browser
  Step 5 'Checking for Google Chrome or Microsoft Edge'
  $browsers = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  if ($browsers | Where-Object { $_ -and (Test-Path $_) }) { Info 'Found - the agent will use it (with its own separate profile).' }
  else {
    Info 'Neither found - downloading a private Chromium for the agent (about 150 MB).'
    & $npx -w service playwright install chromium
  }
} finally { Pop-Location }

# Launchers: hidden start (used now and at login), dashboard shortcut, uninstall shortcut.
$startCmd = Join-Path $InstallDir 'start-service.cmd'
@"
@echo off
cd /d "%~dp0service"
if not exist data mkdir data
"$nodeExe" dist\index.js >> data\service.log 2>> data\service.err.log
"@ | Set-Content -Path $startCmd -Encoding ASCII
@'
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\start-service.cmd""", 0, False
'@ | Set-Content -Path $vbs -Encoding ASCII
$openDash = Join-Path $InstallDir 'open-dashboard.ps1'
@'
$c = Get-Content (Join-Path $HOME '.social-listener\connection.json') -Raw | ConvertFrom-Json
Start-Process "$($c.url)/#token=$($c.token)"
'@ | Set-Content -Path $openDash -Encoding ASCII

if ($NoStart) { Write-Host ''; Write-Host "Installed. Start it by double-clicking $vbs" -ForegroundColor Green; return }

# 6. Start
Step 6 'Starting the agent'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (Test-Path $conn) { Remove-Item $conn -Force }
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`""
for ($i = 0; $i -lt 40 -and -not (Test-Path $conn); $i++) { Start-Sleep -Seconds 1 }
if (-not (Test-Path $conn)) { Fail 'The agent did not start.' "See $dataDir\service.err.log, or run the installer again." }

if (-not $NoAutostart) {
  New-Shortcut $startupLnk 'wscript.exe' "`"$vbs`"" $InstallDir
  Info 'It will start automatically when you log in to Windows.'
}
New-Item -ItemType Directory -Force -Path $menuDir | Out-Null
New-Shortcut (Join-Path $menuDir 'Social Listener dashboard.lnk') 'powershell.exe' "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$openDash`"" $InstallDir
New-Shortcut (Join-Path $menuDir 'Uninstall Social Listener.lnk') 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\install\install.ps1`" -Uninstall" $InstallDir
Info 'Start menu: "Social Listener dashboard" and "Uninstall Social Listener".'

$c = Get-Content $conn -Raw | ConvertFrom-Json
Start-Process "$($c.url)/#token=$($c.token)"

Write-Host ''
Write-Host 'All done! The dashboard opened in your browser.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Green
Write-Host '  1. In Claude, open Customize -> Plugins and upload social-listener-plugin.zip (skip if already added).'
if ($pathChanged) { Write-Host '  2. Quit Claude completely (right-click its tray icon -> Quit) and open it again, so it can use the agent.' }
else { Write-Host '  2. If Claude was open, restart it once.' }
Write-Host '  3. In a Cowork chat, type /setup - Claude will guide you (including the Facebook login).'
