# Brigade installer for Windows (PowerShell 5+).
#
# 1. Ensures Node.js >= 22.12 (installs the latest LTS into %LOCALAPPDATA%\Brigade\node
#    if yours is missing or too old).
# 2. Installs @spinabot/brigade globally via npm.
# 3. Puts npm's REAL global dir on your PATH (persisted for your user) so
#    `brigade` works in every new terminal.
#
#   irm https://brigade.spinabot.com/install.ps1 | iex
#
# (Or directly from GitHub:)
#   irm https://raw.githubusercontent.com/spinabot/brigade/main/packaging/install/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Pkg          = '@spinabot/brigade'
$MinMajor     = 22
$MinMinor     = 12
$RuntimeDir   = Join-Path $env:LOCALAPPDATA 'Brigade\node'
$FallbackNode = 'v22.18.0'
$script:NodeFreshlyInstalled = $false

# ASCII-only output: when fetched via `irm <url> | iex`, PowerShell may decode
# the script as Latin-1 (no charset header) and the console code page may not be
# UTF-8, so non-ASCII glyphs render as mojibake (e.g. box-drawing chars). Keep it plain.
function Info($m) { Write-Host ">> $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

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

  # Make the just-installed Node the one used for the rest of this script.
  $env:Path = "$RuntimeDir;$env:Path"
  $script:NodeFreshlyInstalled = $true

  # Verify completeness - the zip bundles npm; both must be runnable now.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node install incomplete: no node.exe in $RuntimeDir." }
  if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Fail "Node install incomplete: no npm in $RuntimeDir." }
}

# Add a directory to PATH now AND persist it for the user (idempotent).
function Add-ToPath($dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  $dir = $dir.TrimEnd('\')
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $dir) {
    $newUser = if ($userPath) { "$dir;$userPath" } else { $dir }
    [Environment]::SetEnvironmentVariable('Path', $newUser, 'User')
  }
}

# Where `npm i -g` actually drops .cmd shims - DERIVED from npm, never assumed.
# On Windows the global shims live directly in the prefix dir (not prefix\bin).
function Get-NpmGlobalDir {
  $p = $null
  try { $p = (& npm prefix -g 2>$null) } catch { $p = $null }
  if (-not $p) { $p = $RuntimeDir }
  return ($p | Out-String).Trim()
}

# --- main ---
Info 'Brigade installer'
if (Test-NodeOk) {
  Info "Node $(node -v) detected - good."
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
if ($LASTEXITCODE -ne 0) {
  # Fall back to a private, hermetic Node runtime if the existing Node's global
  # install failed (e.g. a locked-down prefix) - then everything lives under
  # %LOCALAPPDATA%\Brigade.
  if (-not $script:NodeFreshlyInstalled) {
    Info 'Global install failed with your existing Node. Installing a private Node runtime for Brigade and retrying ...'
    Install-Node
    & npm i -g $Pkg
    if ($LASTEXITCODE -ne 0) { Fail "npm could not install $Pkg." }
  } else {
    Fail "npm could not install $Pkg."
  }
}

# Put the real npm global dir on PATH (covers both the bundled and system Node).
Add-ToPath (Get-NpmGlobalDir)

Write-Host "`nOK: Brigade installed.  Run:  brigade onboard" -ForegroundColor Green
if (-not (Get-Command brigade -ErrorAction SilentlyContinue)) {
  Write-Host '   Open a NEW terminal so brigade is on your PATH.'
}
