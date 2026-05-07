# Brigade Primitive #1 smoke test — full end-to-end against a real provider.
#
# Default flow (matches the user's reference run):
#   1. Build dist/
#   2. (Optional, with -WipeState) rm -rf ~/.brigade for a true cold start
#   3. brigade onboard
#   4. Drop an auth-profiles.json that references the env var (no key on disk)
#   5. Turn 1 — bootstrap-marker SHOULD be written (first-turn nudge fires)
#   6. Assert the JSONL contains `brigade:bootstrap-context:delivered`
#   7. Turn 2 — bootstrap-marker SHOULD already exist (no re-nudge)
#   8. Session continuity (turn 3 recalls a fact from turn 2)
#   9. /model + /thinking + /reset slash-command roundtrips
#
# Defaults to OpenRouter routing `openai/gpt-5.4`. Override with -Provider /
# -Model. The script never hardcodes the API key — it expects
# $env:OPENROUTER_API_KEY (or the matching env var for whichever provider
# you pick) and writes a profile that references it via ${VAR} expansion.
#
# Usage:
#   $env:OPENROUTER_API_KEY = "sk-or-v1-..."
#   pwsh F:\Brigade\scripts\smoke-test.ps1                           # default
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -WipeState                # cold start
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -SkipBuild                # faster reruns
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -SkipOnboard              # workspace already set up
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -Provider anthropic -Model claude-opus-4-7
#   pwsh F:\Brigade\scripts\smoke-test.ps1 -Verbose                  # echo each CLI call

param(
  [string]$Provider = "openrouter",
  [string]$Model = "openai/gpt-5.4",
  [string]$AgentId = "main",
  [switch]$WipeState,
  [switch]$SkipBuild,
  [switch]$SkipOnboard,
  [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# Colours — falls back to plain text on non-TTY.
$ansi = $Host.UI.SupportsVirtualTerminal
function Print-Section { param([string]$Title)
  if ($ansi) { Write-Host "`n`e[36m═══ $Title ═══`e[0m" }
  else       { Write-Host "`n=== $Title ===" }
}
function Print-Pass { param([string]$Msg)
  if ($ansi) { Write-Host "`e[32m  PASS`e[0m  $Msg" }
  else       { Write-Host "  PASS  $Msg" }
}
function Print-Fail { param([string]$Msg)
  if ($ansi) { Write-Host "`e[31m  FAIL`e[0m  $Msg" }
  else       { Write-Host "  FAIL  $Msg" }
}
function Print-Info { param([string]$Msg)
  if ($ansi) { Write-Host "`e[90m  ...`e[0m   $Msg" }
  else       { Write-Host "  ...   $Msg" }
}

$repoRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $repoRoot

# ─────────────────────────────────────────────────────────────────────────────
# Resolve the env-var name for the chosen provider so we can both refuse to
# run without it AND write a profile that references it via ${VAR}.
# ─────────────────────────────────────────────────────────────────────────────
$envVarName = switch ($Provider) {
  "openrouter"     { "OPENROUTER_API_KEY" }
  "openai"         { "OPENAI_API_KEY" }
  "anthropic"      { "ANTHROPIC_API_KEY" }
  "google"         { "GOOGLE_API_KEY" }
  "groq"           { "GROQ_API_KEY" }
  default          { "$($Provider.ToUpper())_API_KEY" }
}
$envVarValue = [Environment]::GetEnvironmentVariable($envVarName, "Process")

Print-Section "Environment"
Write-Host "  Repo:      $repoRoot"
Write-Host "  Provider:  $Provider"
Write-Host "  Model:     $Model"
Write-Host "  AgentId:   $AgentId"
Write-Host "  EnvVar:    `$env:$envVarName  ($(if ($envVarValue) { 'set' } else { 'MISSING' }))"
Write-Host "  Node:      $((node --version) 2>$null)"

if (-not $envVarValue) {
  Print-Fail "`$env:$envVarName is not set — set it first, e.g.:"
  Write-Host "        `$env:$envVarName = `"<your-key>`""
  exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Build (unless -SkipBuild)
# ─────────────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Print-Section "1. Build"
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Print-Fail "Build failed; aborting."
    exit 1
  }
  Print-Pass "dist/ rebuilt"
} else {
  Print-Info "skipping build (per -SkipBuild)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. (Optional) wipe ~/.brigade for a true cold-start run
# ─────────────────────────────────────────────────────────────────────────────
$brigadeStateDir = Join-Path $env:USERPROFILE ".brigade"
if ($WipeState) {
  Print-Section "2. Wipe state"
  if (Test-Path $brigadeStateDir) {
    Remove-Item $brigadeStateDir -Recurse -Force -ErrorAction SilentlyContinue
    Print-Pass "removed $brigadeStateDir"
  } else {
    Print-Info "no state to wipe"
  }
} else {
  Print-Info "skipping state wipe (pass -WipeState for a cold start)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Onboard — creates the workspace, persona files, BOOTSTRAP.md, identity, etc.
# ─────────────────────────────────────────────────────────────────────────────
if (-not $SkipOnboard) {
  Print-Section "3. Onboard"
  npm run brigade -- onboard --agent-id $AgentId
  if ($LASTEXITCODE -ne 0) {
    Print-Fail "onboard failed"
    exit 1
  }
  Print-Pass "onboard complete"
} else {
  Print-Info "skipping onboard (per -SkipOnboard)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Auth profile — env-var reference, never hardcoded
# ─────────────────────────────────────────────────────────────────────────────
Print-Section "4. Auth profile"
$authDir = Join-Path $brigadeStateDir "agents\$AgentId\agent"
$authPath = Join-Path $authDir "auth-profiles.json"
New-Item -ItemType Directory -Path $authDir -Force | Out-Null
$authJson = @"
{ "version": 1, "profiles": { "$Provider`:default": { "provider": "$Provider", "alias": "default", "type": "api_key", "key": "`${$envVarName}" } } }
"@
$authJson | Set-Content -Path $authPath -Encoding utf8
Print-Pass "wrote $authPath (key is `${$envVarName}, not a literal)"

# ─────────────────────────────────────────────────────────────────────────────
# Run-helper: invokes the brigade agent CLI, captures stdout + stderr.
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-Brigade {
  param([string]$Message, [string]$ExtraArgs = "")
  $stderrPath = New-TemporaryFile
  try {
    $cmd = "npm run --silent brigade -- agent --agent-id $AgentId --provider $Provider --model `"$Model`""
    if ($ExtraArgs) { $cmd += " $ExtraArgs" }
    $cmd += " --message `"$($Message -replace '"', '\"')`""
    if ($Verbose) { Write-Host "  $cmd" -ForegroundColor DarkGray }
    $stdout = Invoke-Expression "$cmd 2> `"$stderrPath`""
    $exit = $LASTEXITCODE
    $stderr = (Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue) ?? ""
    return @{ stdout = ($stdout -join "`n"); stderr = $stderr; exit = $exit }
  } finally {
    Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

# Each scenario tracks pass/fail; we don't bail on first failure.
$results = New-Object System.Collections.Generic.List[psobject]
function Run-Scenario { param([string]$Name, [scriptblock]$Block)
  Print-Section $Name
  try {
    $r = & $Block
    if ($r -eq $true) { Print-Pass $Name; $results.Add(@{ name = $Name; ok = $true }) }
    else              { Print-Fail "$Name — $r"; $results.Add(@{ name = $Name; ok = $false; reason = $r }) }
  } catch {
    Print-Fail "$Name — exception: $($_.Exception.Message)"
    $results.Add(@{ name = $Name; ok = $false; reason = $_.Exception.Message })
  }
}

# Helper: scan all sessions/*.jsonl for the bootstrap-delivered marker.
function Find-BootstrapMarker {
  $sessionsDir = Join-Path $brigadeStateDir "agents\$AgentId\sessions"
  if (-not (Test-Path $sessionsDir)) { return $null }
  $hits = Get-ChildItem $sessionsDir -Filter "*.jsonl" -ErrorAction SilentlyContinue |
          ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue } |
          Select-String "brigade:bootstrap-context:delivered" -SimpleMatch
  if ($hits) { return $hits | Select-Object -First 1 } else { return $null }
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Turn 1 — first-turn nudge fires, bootstrap-marker is written
# ─────────────────────────────────────────────────────────────────────────────
$markerBeforeTurn1 = Find-BootstrapMarker
Run-Scenario "5. Turn 1 — first-turn bootstrap nudge fires" {
  $r = Invoke-Brigade -Message "hi"
  if ($r.exit -ne 0) {
    return "non-zero exit $($r.exit). stderr tail: $(($r.stderr -split "`n")[-5..-1] -join ' | ')"
  }
  if (-not $r.stdout -or $r.stdout.Trim().Length -eq 0) {
    return "empty reply. stderr tail: $(($r.stderr -split "`n")[-5..-1] -join ' | ')"
  }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(120, $r.stdout.Trim().Length)))…"
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. Bootstrap marker landed in the JSONL transcript
# ─────────────────────────────────────────────────────────────────────────────
Run-Scenario "6. Bootstrap-delivery marker in JSONL" {
  $hit = Find-BootstrapMarker
  if (-not $hit) {
    return "no `brigade:bootstrap-context:delivered` line found in any sessions/*.jsonl"
  }
  if ($markerBeforeTurn1) {
    return "marker existed BEFORE turn 1 — wipe didn't take effect or session was reused"
  }
  Print-Info "marker file: $($hit.Path)"
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. Turn 2 — marker exists, first-turn nudge SHOULD NOT re-fire
# ─────────────────────────────────────────────────────────────────────────────
Run-Scenario "7. Turn 2 — bootstrap nudge does NOT re-fire" {
  $r = Invoke-Brigade -Message "what should I call you?"
  if ($r.exit -ne 0) {
    return "non-zero exit $($r.exit). stderr tail: $(($r.stderr -split "`n")[-5..-1] -join ' | ')"
  }
  Print-Info "reply: $($r.stdout.Trim().Substring(0, [Math]::Min(120, $r.stdout.Trim().Length)))…"
  # Count markers — should still be exactly 1 (turn 1's, not a fresh one).
  $sessionsDir = Join-Path $brigadeStateDir "agents\$AgentId\sessions"
  $markerCount = (Get-ChildItem $sessionsDir -Filter "*.jsonl" |
                  ForEach-Object { Get-Content $_.FullName } |
                  Select-String "brigade:bootstrap-context:delivered" -SimpleMatch).Count
  if ($markerCount -ne 1) {
    return "expected exactly 1 bootstrap marker after turn 2, found $markerCount"
  }
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# 8. Session continuity — turn 3 references something the model just said
# ─────────────────────────────────────────────────────────────────────────────
Run-Scenario "8. Session continuity (turn 3 recall)" {
  $r1 = Invoke-Brigade -Message "Remember the secret word: ALBATROSS-7. Reply only 'ok'."
  if ($r1.exit -ne 0) { return "first turn failed: $($r1.stderr.Substring(0, [Math]::Min(200, $r1.stderr.Length)))" }
  Print-Info "ack: $($r1.stdout.Trim())"
  $r2 = Invoke-Brigade -Message "What was the secret word? Reply with only the word."
  if ($r2.exit -ne 0) { return "recall turn failed: $($r2.stderr.Substring(0, [Math]::Min(200, $r2.stderr.Length)))" }
  Print-Info "recall: $($r2.stdout.Trim())"
  if (-not $r2.stdout.ToUpper().Contains("ALBATROSS-7")) {
    return "model did not recall the secret word — session continuity broken"
  }
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# 9. /model slash command — persists override, no model turn fired
# ─────────────────────────────────────────────────────────────────────────────
Run-Scenario "9. /model persists session override" {
  $r = Invoke-Brigade -Message "/model $Provider/$Model"
  if ($r.exit -ne 0) { return "non-zero exit $($r.exit): $($r.stderr)" }
  if ($r.stdout.Trim().Length -gt 0) {
    return "slash command should not produce stdout, got: $($r.stdout)"
  }
  if ($r.stderr -notmatch "switched to") {
    return "expected switch confirmation in stderr, got: $($r.stderr)"
  }
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# 10. /thinking — sets level for next turn (no model turn)
# ─────────────────────────────────────────────────────────────────────────────
Run-Scenario "10. /thinking sets level" {
  $r = Invoke-Brigade -Message "/thinking low"
  if ($r.exit -ne 0) { return "non-zero exit $($r.exit): $($r.stderr)" }
  if ($r.stderr -notmatch "level set to 'low'") {
    return "expected thinking-level confirmation in stderr, got: $($r.stderr)"
  }
  return $true
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
Print-Section "Summary"
$pass = ($results | Where-Object { $_.ok }).Count
$total = $results.Count
Write-Host "  $pass / $total scenarios passed`n"
if ($pass -lt $total) {
  foreach ($r in $results | Where-Object { -not $_.ok }) {
    if ($ansi) { Write-Host "  `e[31mFAIL`e[0m  $($r.name): $($r.reason)" }
    else       { Write-Host "  FAIL  $($r.name): $($r.reason)" }
  }
  exit 1
}

if ($ansi) { Write-Host "`e[32mAll smoke checks passed.`e[0m" }
else       { Write-Host "All smoke checks passed." }
exit 0
