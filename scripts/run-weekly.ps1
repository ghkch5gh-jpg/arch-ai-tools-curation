# AI Design Stack WEEKLY recipe generator - called by Windows Task Scheduler ~Mon 09:30 KST.
# Replaces the old daily churn: one deep 실전 레시피 per week. index.md(도감) is NOT regenerated
# here - the 도감 is rebuilt only when the tool catalog changes (scripts/build-directory.mjs).
# ASCII-only on purpose: the repo lives under a Korean path.
$ErrorActionPreference = 'Continue'

# Scheduled tasks run with a minimal PATH - point at node / git / npm-global (codex) explicitly.
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Users\myh43\AppData\Roaming\npm;$env:Path"

$repo = Join-Path ([Environment]::GetFolderPath('Desktop')) 'work\_inspect\arch-ai-tools-curation'
Set-Location $repo
$log = Join-Path $repo 'weekly.log'

function Log($m) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m |
    Out-File -FilePath $log -Append -Encoding utf8
}

Log "==== start ===="
git pull --quiet origin main *>> $log

# Recipes deserve stronger reasoning; build-recipe.mjs honors CODEX_REASONING_EFFORT.
$env:CODEX_REASONING_EFFORT = 'high'
node scripts/build-recipe.mjs *>> $log
if ($LASTEXITCODE -ne 0) { Log "recipe generator failed (exit $LASTEXITCODE)"; exit 1 }

git add -A *>> $log
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m ("recipe: " + (Get-Date -Format 'yyyy-MM-dd')) *>> $log
  git push origin main *>> $log
  Log "pushed"
} else {
  Log "no changes (this week's recipe already exists)"
}
