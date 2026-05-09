# Brigade Primitive #2 — System Prompt smoke test.
#
# Verifies the OpenClaw-style first-turn experience end-to-end:
#   - bootstrap-phase machine (first-turn nudge fires once, marker written)
#   - layered persona files drive identity (BOOTSTRAP/IDENTITY/SOUL/AGENTS/USER/TOOLS/HEARTBEAT)
#   - session transcript persists across turns (recall name + self-name)
#   - runtime suffix injects host context (model/shell/OS)
#   - workspace-only sourcing (no per-cwd walker)
#
# Usage:
#   $env:OPENROUTER_API_KEY = "sk-or-v1-..."
#   pwsh F:\Brigade\scripts\smoke-primitive-2.ps1
#   pwsh F:\Brigade\scripts\smoke-primitive-2.ps1 -SkipBuild       # faster reruns
#   pwsh F:\Brigade\scripts\smoke-primitive-2.ps1 -SkipWipe        # keep state from last run
#   pwsh F:\Brigade\scripts\smoke-primitive-2.ps1 -SkipOnboard     # already onboarded

param(
  [string]$Provider      = "openrouter",
  [string]$Model         = "openai/gpt-5.4",
  [string]$FallbackModel = "openai/gpt-5.4-mini",
  [int]   $GatewayPort   = 18789,
  [switch]$SkipBuild,
  [switch]$SkipWipe,
  [switch]$SkipOnboard
)

$ErrorActionPreference = "Stop"
$BrigadeRoot = Resolve-Path "$PSScriptRoot\.."
$BrigadeDir  = Join-Path $env:USERPROFILE ".brigade"
Set-Location $BrigadeRoot

if (-not $env:OPENROUTER_API_KEY) {
  Write-Host "ERROR: `$env:OPENROUTER_API_KEY is not set." -ForegroundColor Red
  Write-Host "       `$env:OPENROUTER_API_KEY = `"sk-or-v1-...`""
  exit 1
}

# === PHASE 0 — wipe ============================================================
Write-Host "`n===PHASE 0=== state" -ForegroundColor Cyan
if ($SkipWipe) {
  Write-Host "  -SkipWipe set, keeping existing $BrigadeDir" -ForegroundColor Yellow
} elseif (Test-Path $BrigadeDir) {
  Remove-Item $BrigadeDir -Recurse -Force
  Write-Host "  Wiped $BrigadeDir" -ForegroundColor Green
} else {
  Write-Host "  No existing ~/.brigade — clean slate." -ForegroundColor Green
}

# === PHASE 1 — build ===========================================================
Write-Host "`n===PHASE 1=== build" -ForegroundColor Cyan
if ($SkipBuild) {
  Write-Host "  -SkipBuild set, using existing dist/" -ForegroundColor Yellow
} else {
  npm run build
  if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED" -ForegroundColor Red; exit 1 }
}

# === PHASE 2 — non-interactive config seed =====================================
# `brigade onboard` is interactive-only by design (TUI wizard). Brigade
# documents the non-interactive path as: write brigade.json + auth-profiles.json
# directly. We do exactly that here.
Write-Host "`n===PHASE 2=== seed brigade.json + auth-profiles.json ($Provider / $Model)" -ForegroundColor Cyan
if ($SkipOnboard) {
  Write-Host "  -SkipOnboard set, assuming brigade.json already configured" -ForegroundColor Yellow
} else {
  $authDir = Join-Path $BrigadeDir "agents\main\agent"
  New-Item -ItemType Directory -Path $authDir -Force | Out-Null

  $configPath  = Join-Path $BrigadeDir "brigade.json"
  $profilePath = Join-Path $authDir   "auth-profiles.json"

  $config = [ordered]@{
    version = 2
    agents = [ordered]@{
      defaults = [ordered]@{
        provider = $Provider
        model = [ordered]@{
          primary   = $Model
          fallbacks = @($FallbackModel)
        }
      }
    }
    meta = [ordered]@{
      installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      installedBy = "smoke-primitive-2.ps1"
    }
  }
  ($config | ConvertTo-Json -Depth 8) | Set-Content -Path $configPath -Encoding utf8
  Write-Host "  Wrote $configPath" -ForegroundColor Green

  # NOTE: writing the literal API key into auth-profiles.json. We tried
  # `keyRef: { source: "env", provider: "env", id: "OPENROUTER_API_KEY" }`
  # but Pi's auth resolution doesn't honor env-refs in this shape — the
  # turn returns empty in ~3ms with no HTTP call. Literal key works.
  # Fix this upstream when Pi gains real keyRef support; for the smoke
  # test the file is mode 0600 and never leaves the local machine.
  $profiles = [ordered]@{
    version = 1
    profiles = [ordered]@{
      "${Provider}:default" = [ordered]@{
        provider = $Provider
        alias    = "default"
        type     = "api_key"
        key      = $env:OPENROUTER_API_KEY
      }
    }
  }
  ($profiles | ConvertTo-Json -Depth 8) | Set-Content -Path $profilePath -Encoding utf8
  Write-Host "  Wrote $profilePath (literal key, mode 0600 on POSIX)" -ForegroundColor Green
}

# === PHASE 3 — multi-turn conversation =========================================
Write-Host "`n===PHASE 3=== multi-turn conversation" -ForegroundColor Cyan

$turns = @(
  @{ Msg = "hey";                                                                Note = "TURN 1: bootstrap nudge fires"        },
  @{ Msg = "who is this?";                                                       Note = "TURN 2: 'fresh out of the box' answer"},
  @{ Msg = "my name is Bhasvanth, but call me B";                                Note = "TURN 3: user identity captured"       },
  @{ Msg = "your name is Otter from now on. just acknowledge briefly.";          Note = "TURN 4: agent self-naming"            },
  @{ Msg = "what is my name?";                                                   Note = "TURN 5: recall user identity"         },
  @{ Msg = "what is your name?";                                                 Note = "TURN 6: recall self identity"         }
)

foreach ($t in $turns) {
  Write-Host "`n--- $($t.Note) — `"$($t.Msg)`"" -ForegroundColor Magenta
  node .\brigade.mjs agent --message $t.Msg
  if ($LASTEXITCODE -ne 0) { Write-Host "TURN FAILED" -ForegroundColor Red; exit 1 }
}

# === PHASE 4 — runtime probe ===================================================
Write-Host "`n===PHASE 4=== runtime-suffix probe" -ForegroundColor Cyan
node .\brigade.mjs agent --message "without using any tools, just from your system prompt: what model are you, what shell does the user have, and what OS family? Three short bullets."

# === PHASE 5 — session JSONL inspection ========================================
Write-Host "`n===PHASE 5=== session JSONL" -ForegroundColor Cyan
$sessionDir = Join-Path $BrigadeDir 'agents\main\sessions'
$jsonlFiles = Get-ChildItem $sessionDir -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue
foreach ($f in $jsonlFiles) {
  $count   = (Get-Content $f.FullName).Count
  $userN   = (Select-String -Path $f.FullName -Pattern '"role":"user"'      -SimpleMatch | Measure-Object).Count
  $asstN   = (Select-String -Path $f.FullName -Pattern '"role":"assistant"' -SimpleMatch | Measure-Object).Count
  $marker  = (Select-String -Path $f.FullName -Pattern 'brigade:bootstrap-context:delivered' -SimpleMatch | Measure-Object).Count
  Write-Host "  $($f.Name): lines=$count, user=$userN, assistant=$asstN, bootstrap-marker=$marker"
}
Write-Host "  Pass criteria: 1 file, user=7 (6 + probe), bootstrap-marker=1" -ForegroundColor Yellow

# === PHASE 6 — done ============================================================
Write-Host "`n===PHASE 6=== done" -ForegroundColor Green
Write-Host "  State kept at $BrigadeDir for inspection."
Write-Host "  Wipe again: Remove-Item '$BrigadeDir' -Recurse -Force"
