<#
  Syncs extension/ into the OneDrive-mirrored unpacked Chrome extension.

  IMPORTANT (found 2026-09-07, cost a repeated daily debugging loop before
  this script existed): "Link gen tool addon" contains TWO copies of the
  extension files:
    - directly in its ROOT (this is the actual folder Chrome's
      chrome://extensions "Load unpacked" points at, confirmed live)
    - inside its "extension" subfolder (a leftover/secondary copy)
  Syncing only one of the two silently leaves the other stale - Chrome
  keeps loading the stale version even after "reload extension" + F5,
  which looks exactly like a caching problem but isn't. ALWAYS sync BOTH
  paths together (this script does both) so it never matters again which
  one is actually live.

  Usage: powershell -File sync-onedrive.ps1
  Exits non-zero if any hash mismatch remains after sync (should never
  happen; a non-zero exit means investigate before trusting the release).
#>
$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'extension'
$mirrorBase = 'C:\Users\basz04\OneDrive - Betsson Group\Documents\Link gen tool addon'
$dstRoot = $mirrorBase
$dstSubfolder = Join-Path $mirrorBase 'extension'

function Sync-And-Verify($src, $dst, $label, [switch]$Mirror) {
  Write-Host "--- Syncing to $label ($dst) ---"
  if ($Mirror) { robocopy $src $dst /MIR /NFL /NDL /NJH /NJS | Out-Null }
  else { robocopy $src $dst /E /NFL /NDL /NJH /NJS | Out-Null }

  $diffs = 0
  Get-ChildItem $src -File | ForEach-Object {
    $dstFile = Join-Path $dst $_.Name
    if (-not (Test-Path $dstFile)) { Write-Host "MISSING: $($_.Name)"; $diffs++; return }
    $h1 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    $h2 = (Get-FileHash $dstFile -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { Write-Host "DIFF: $($_.Name)"; $diffs++ }
  }
  Write-Host "$label diffs: $diffs"
  return $diffs
}

# IMPORTANT: the root sync must NOT use /MIR (= /PURGE). Robocopy would
# see the "extension" subfolder as an "*EXTRA Dir" (it doesn't exist under
# the flat repo extension/ source) and DELETE it - confirmed live with
# `robocopy ... /MIR /L` showing "*EXTRA Dir ... \extension\" plus all 10
# files marked for deletion. Plain /E copies/overwrites files without
# deleting anything extra in the destination.
$diffsRoot = Sync-And-Verify $src $dstRoot 'OneDrive ROOT (the one Chrome actually loads)'
$diffsSub = Sync-And-Verify $src $dstSubfolder 'OneDrive extension subfolder (secondary copy)' -Mirror

$rootVersion = (Get-Content (Join-Path $dstRoot 'manifest.json') -Raw | ConvertFrom-Json).version
$subVersion = (Get-Content (Join-Path $dstSubfolder 'manifest.json') -Raw | ConvertFrom-Json).version
$repoVersion = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "repo version: $repoVersion | OneDrive root: $rootVersion | OneDrive extension subfolder: $subVersion"

if ($diffsRoot -ne 0 -or $diffsSub -ne 0 -or $rootVersion -ne $repoVersion -or $subVersion -ne $repoVersion) {
  Write-Host "SYNC FAILED - do not trust chrome://extensions to show the new version yet."
  exit 1
}
Write-Host "SYNC OK - both OneDrive copies match the repo exactly. Now reload the extension in chrome://extensions and refresh open tabs."
exit 0
