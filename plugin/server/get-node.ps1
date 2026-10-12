<#
  Get a private Node.js for Social Listener (Windows), without admin rights.
  Used by launch.cmd when the computer has no Node.js 18+.

    get-node.ps1 -Dir <runtime\node> [-Wait <seconds>]   start (or join) a background download, wait up to N s
    get-node.ps1 -Dir <runtime\node> -Worker             the background download itself

  Official LTS from nodejs.org, verified against SHASUMS256.txt, unpacked next to -Dir and
  renamed into place, so a half-finished download is never used. Writes only to stderr.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$Wait = 25,
  [switch]$Worker
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Say([string]$m) { [Console]::Error.WriteLine("[social-listener] $m") }

$nodeExe = Join-Path $Dir 'node.exe'
$lock = "$Dir.downloading"
if (Test-Path $nodeExe) { exit 0 }

if ($Worker) {
  $parent = Split-Path $Dir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $tmp = "$Dir.tmp-" + [guid]::NewGuid().ToString('N').Substring(0, 8)
  try {
    Set-Content -Path $lock -Value $PID -Encoding ASCII
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $rel = $index | Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 22 } | Select-Object -First 1
    if (-not $rel) { throw 'no Node.js LTS release found' }
    $name = "node-$($rel.version)-win-$arch"
    $base = "https://nodejs.org/dist/$($rel.version)"
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
    if (-not $line) { throw 'no checksum for the Node.js download' }
    $expected = ($line.Trim() -split '\s+')[0].ToLower()
    if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower() -ne $expected) { throw 'Node.js download failed its checksum check' }
    Expand-Archive -Path $zip -DestinationPath $tmp
    if (-not (Test-Path $nodeExe)) { Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $Dir }  # same volume: atomic rename
  } catch {
    Say "Node.js download failed: $($_.Exception.Message)"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

# Start a background download unless one is already running (a lock older than 10 min is stale).
$running = (Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-10))
if (-not $running) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  Set-Content -Path $lock -Value 'starting' -Encoding ASCII
  Say 'Node.js is not installed; downloading a private copy for Social Listener (one time, about 30 MB)...'
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Dir', "`"$Dir`"", '-Worker'
  )
}
$deadline = (Get-Date).AddSeconds($Wait)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $nodeExe) { exit 0 }
  Start-Sleep -Milliseconds 500
}
if (Test-Path $nodeExe) { exit 0 }
exit 1
