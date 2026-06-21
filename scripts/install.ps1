# Brigade installer for Windows (PowerShell 5+).
#
# Installs Node.js (latest LTS) if it's missing or older than 22.12, then installs
# @spinabot/brigade globally via npm. Safe to re-run.
#
#   irm https://brigade.spinabot.com/install.ps1 | iex
#
# (Or directly from GitHub:)
#   irm https://raw.githubusercontent.com/spinabot/brigade/main/scripts/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Pkg          = '@spinabot/brigade'
$MinMajor     = 22
$MinMinor     = 12
$RuntimeDir   = Join-Path $env:LOCALAPPDATA 'Brigade\node'
$FallbackNode = 'v22.18.0'
$script:NodeFreshlyInstalled = $false

function Info($m) { Write-Host "▸ $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

function Test-NodeOk {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  try { $v = (& node -v).TrimStart('v') } catch { return $false }
  $parts = $v.Split('.')
  $maj = [int]$parts[0]; $min = [int]$parts[1]
  if ($maj -gt $MinMajor) { return $true }
  if ($maj -eq $MinMajor -and $min -ge $MinMinor) { return $true }
  return $false
}

function Install-Node {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  elseif ([Environment]::Is64BitOperatingSystem) { $arch = 'x64' }
  else { $arch = 'x86' }

  Info 'Resolving latest Node LTS ...'
  $ver = $null
  try {
    $idx = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
    $ver = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
  } catch { }
  if (-not $ver) { $ver = $FallbackNode }

  $name = "node-$ver-win-$arch"
  $url  = "https://nodejs.org/dist/$ver/$name.zip"
  Info "Installing Node $ver ($arch) into $RuntimeDir ..."

  $tmp = Join-Path $env:TEMP "$name.zip"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $tmp

  if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
  $parent = Split-Path $RuntimeDir -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Expand-Archive -Path $tmp -DestinationPath $parent -Force
  Rename-Item -Path (Join-Path $parent $name) -NewName (Split-Path $RuntimeDir -Leaf)
  Remove-Item $tmp -Force

  # Add to the current session PATH and persist for the user.
  $env:Path = "$RuntimeDir;$env:Path"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$RuntimeDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$RuntimeDir;$userPath", 'User')
  }
  $script:NodeFreshlyInstalled = $true
}

Info 'Brigade installer'
if (Test-NodeOk) {
  Info "Node $(node -v) detected — good."
} else {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Info "Node $(node -v) is too old (need $MinMajor.$MinMinor+)."
  } else {
    Info 'Node not found.'
  }
  Install-Node
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'npm is not available even after installing Node. Please report this.'
}

Info "Installing $Pkg ..."
& npm i -g $Pkg

Write-Host "`n✓ Brigade installed.  Run:  brigade onboard" -ForegroundColor Green
if ($script:NodeFreshlyInstalled) {
  Write-Host '   Node was just installed — open a new terminal first so it is on your PATH.'
}
