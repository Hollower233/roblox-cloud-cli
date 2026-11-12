<#
  Bundled with rbx (rbx studio save). Drives Roblox Studio "File > Save to Roblox with Notes" in the background:
  opens the "Save with version notes" dialog (File menu via UIA, then keyboard+OCR, then the Ctrl+Alt+S
  hotkey in the foreground), types the title and details with posted input, checks the Save button, saves.
  The dialog is an engine-rendered plugin widget, so its fields are found by OCR of their placeholders.
  Shared helpers live in studio-ui.ps1 next to this file.
  Input: -ArgsB64 = base64(UTF-8 JSON {pid, title, details, dryRun, debugDir}).
  Output: progress lines on stderr, one "@@RESULT {json}" line on stdout. Keep this file ASCII-only.
#>
param([Parameter(Mandatory)][string]$ArgsB64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json
$NoteTitle = [string]$cfg.title; $NoteDetails = if ($cfg.details) { [string]$cfg.details } else { '' }
$StudioPid = [int]$cfg.pid; $DryRun = [bool]$cfg.dryRun; $DebugDir = if ($cfg.debugDir) { [string]$cfg.debugDir } else { '' }
if ($DebugDir) { New-Item -ItemType Directory -Force $DebugDir | Out-Null }
$script:Stage = 'init'; $script:Clicked = $false; $script:MenuPath = $null; $script:TitleOcr = $null; $script:DetailsOcr = $null
$script:PrevForeground = [IntPtr]::Zero; $dlg = [IntPtr]::Zero
$script:Watch = [Diagnostics.Stopwatch]::StartNew()
function Emit([bool]$ok, [string]$msg) {
  $r = [ordered]@{ ok = $ok; stage = $script:Stage; clicked = $script:Clicked; elapsedMs = [int]$script:Watch.ElapsedMilliseconds }
  if ($msg) { $r.message = $msg }; if ($script:MenuPath) { $r.menuPath = $script:MenuPath }
  if ($null -ne $script:TitleOcr) { $r.titleOcr = $script:TitleOcr }; if ($null -ne $script:DetailsOcr) { $r.detailsOcr = $script:DetailsOcr }
  [Console]::Out.WriteLine('@@RESULT ' + ($r | ConvertTo-Json -Compress))
}
function Log($m) { [Console]::Error.WriteLine(("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m)) }
$DialogName = 'Save with version notes'
$MenuItem = 'Save to Roblox with Notes'
try {

. (Join-Path $PSScriptRoot 'studio-ui.ps1')

function Get-NotesDialog { Get-ChildDialog $DialogName }
function Wait-NotesDialog([int]$timeoutMs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  do { $h = Get-NotesDialog; if ($h -ne [IntPtr]::Zero) { return $h }; Start-Sleep -Milliseconds 400 } while ($sw.ElapsedMilliseconds -lt $timeoutMs)
  return [IntPtr]::Zero
}
function Wait-NotesGone([int]$timeoutMs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  do { if ((Get-NotesDialog) -eq [IntPtr]::Zero) { return $true }; Start-Sleep -Milliseconds 400 } while ($sw.ElapsedMilliseconds -lt $timeoutMs)
  return $false
}
# Multi-line text: lines typed as WM_CHAR, line breaks as a posted Enter key.
function Send-Text([IntPtr]$h, [string]$text) {
  $parts = $text -split "`n"
  for ($i = 0; $i -lt $parts.Count; $i++) {
    if ($i -gt 0) { [PA.W]::Key($h, 0x0D); Start-Sleep -Milliseconds 60 }
    if ($parts[$i]) { [PA.W]::Type($h, $parts[$i]) }
  }
}
# Labels, Cancel and the OCR lines inside each field; throws when the dialog layout is not recognized.
function Get-Layout($lines) {
  $tLabel = Find-One $lines 'Version title' { $_.N.StartsWith('version') } 'title label'
  $dLabel = Find-One $lines 'Version details' { $_.N.StartsWith('version') } 'details label'
  $cnl = $lines | Where-Object { $_.N -eq 'cancei' -or $_.N -eq 'cancel' } | Sort-Object Y -Descending | Select-Object -First 1
  if (-not $tLabel -or -not $dLabel -or -not $cnl -or $dLabel.Y -le $tLabel.Y -or $cnl.Y -le $dLabel.Y) { throw 'Dialog layout not recognized. OCR: ' + (($lines | ForEach-Object Text) -join ' | ') }
  [pscustomobject]@{
    Cancel = $cnl
    TitleLines = @($lines | Where-Object { $_.Y -gt $tLabel.Y + $tLabel.H -and $_.Y + $_.H -lt $dLabel.Y } | Sort-Object Y, X)
    DetailLines = @($lines | Where-Object { $_.Y -gt $dLabel.Y + $dLabel.H -and $_.Y + $_.H -lt $cnl.Y - 4 } | Sort-Object Y, X)
  }
}
function Test-Hint($fieldLines, [string[]]$keys) { $n = (($fieldLines | ForEach-Object N) -join ''); foreach ($k in $keys) { if ($n.Contains((Norm $k))) { return $true } }; return $false }
function Test-TitleHint($fieldLines) { Test-Hint $fieldLines @('what changed', 'changed in this', 'escribe what') }
function Test-DetailsHint($fieldLines) { Test-Hint $fieldLines @('more information', 'add more inf', 'information ab') }
function Restore-Focus { try { if ($script:PrevForeground -ne [IntPtr]::Zero) { [PA.W]::Restore($script:PrevForeground) } } catch {} }

# ---------------- locate Studio ----------------
$script:Stage = 'locate-studio'
Find-Studio $StudioPid
$dlg = Get-NotesDialog
if ($dlg -ne [IntPtr]::Zero) {
  Log 'Closing an already open Save with version notes dialog (its unsaved text is discarded)'
  [PA.W]::Close($dlg)
  if (-not (Wait-NotesGone 5000)) { throw 'An already open Save with version notes dialog did not close.' }
  $dlg = [IntPtr]::Zero
}

# ---------------- open File > Save to Roblox with Notes ----------------
$script:Stage = 'open-dialog'
$res = Invoke-FileMenu $MenuItem 2
if ($res.StartsWith('DISABLED:')) { throw $res.Substring(10) }
if ($res -eq 'ok') { $dlg = Wait-NotesDialog 6000 }
if ($dlg -eq [IntPtr]::Zero -and $script:MenuPath -eq 'UIA') {
  Log 'UIA Invoke did not open the dialog; using keyboard navigation'
  $res = Invoke-FileMenu $MenuItem 3 -NoUia
  if ($res.StartsWith('DISABLED:')) { throw $res.Substring(10) }
  if ($res -eq 'ok') { $dlg = Wait-NotesDialog 10000 }
}
if ($dlg -eq [IntPtr]::Zero) {
  Log "File menu path failed ($res); pressing Ctrl+Alt+S in the foreground"
  Close-Menus
  $res = Send-StudioChord ([byte[]](0x11, 0x12)) 0x53
  if ($res -ne 'ok') { throw "Could not open $DialogName`: $res" }
  $dlg = Wait-NotesDialog 10000
}
if ($dlg -eq [IntPtr]::Zero) { throw "$DialogName dialog did not open." }
Log "Opened $DialogName (via $script:MenuPath)"

# ---------------- wait for the dialog to render ----------------
$lines = @()
for ($i = 0; $i -lt 4; $i++) {
  try { $lines = Wait-Text $dlg 'Version title' 8000 'dialog' } catch { $lines = @() }
  if ((Has $lines 'Version title') -and (Has $lines 'Cancel')) { break }
  Log 'Dialog not fully rendered, forcing a resize'; [PA.W]::Nudge($dlg); Start-Sleep -Milliseconds 1000
}
if (-not ((Has $lines 'Version title') -and (Has $lines 'Cancel'))) { throw 'Dialog never rendered completely. OCR: ' + (($lines | ForEach-Object Text) -join ' | ') }
# Fields are located by layout (between the labels and the Cancel row); placeholders are only fuzzy-matched
# because OCR mangles the grey placeholder text ('>escribe what changed', 'abOL t the changes').
$layout = Get-Layout $lines
$titleHint = @($layout.TitleLines)
$detailsHint = @($layout.DetailLines)
if ($titleHint.Count -ne 1 -or -not (Test-TitleHint $titleHint)) { throw 'Version title field is not empty or not recognized. OCR: ' + (($lines | ForEach-Object Text) -join ' | ') }
if ($detailsHint.Count -ne 1 -or -not (Test-DetailsHint $detailsHint)) { throw 'Version details field is not empty or not recognized. OCR: ' + (($lines | ForEach-Object Text) -join ' | ') }
$titleHint = $titleHint[0]; $detailsHint = $detailsHint[0]

# ---------------- type title + details ----------------
$script:Stage = 'fill'
[PA.W]::Click($dlg, $titleHint.CX, $titleHint.CY); Start-Sleep -Milliseconds 400
Send-Text $dlg $NoteTitle; Start-Sleep -Milliseconds 500
if ($NoteDetails) { [PA.W]::Click($dlg, $detailsHint.CX, $detailsHint.CY); Start-Sleep -Milliseconds 400; Send-Text $dlg $NoteDetails }
Start-Sleep -Milliseconds 700
$lines = @(Read-Window $dlg 'filled')
$layout = Get-Layout $lines
$cancel = $layout.Cancel
$titleLines = @($layout.TitleLines); $detailLines = @($layout.DetailLines)
$script:TitleOcr = (($titleLines | ForEach-Object Text) -join ' ')
$script:DetailsOcr = (($detailLines | ForEach-Object Text) -join "`n")
if (Test-TitleHint $titleLines) { throw 'Title was not typed (placeholder still shown).' }
if (-not $script:TitleOcr) { throw 'Title field looks empty after typing.' }
if ($NoteDetails -and (Test-DetailsHint $detailLines)) { throw 'Details were not typed (placeholder still shown).' }
Log "Title OCR: $script:TitleOcr"

# ---------------- check Save is enabled ----------------
# White-on-blue "Save" is often missed by OCR once enabled, so find the button by colour: scan the Cancel row
# to the right of Cancel for the bright-blue run (the disabled button is a dim blue and does not pass).
$off = [PA.W]::ClientOffset($dlg); $bmp = [PA.W]::Snap($dlg)
if ($DebugDir) { $script:Shot++; $bmp.Save((Join-Path $DebugDir ('{0:D2}-save-check.png' -f $script:Shot))) }
$cw = [PA.W]::ClientSize($dlg)[0]; $runStart = -1; $runEnd = -1
for ($x = $cancel.X + $cancel.W + 4; $x -lt $cw; $x++) {
  $bp = $bmp.GetPixel($x + $off[0], $cancel.CY + $off[1])
  $isBlue = $bp.B -gt 200 -and $bp.R -lt 120 -and $bp.G -lt 160
  if ($isBlue) { if ($runStart -lt 0) { $runStart = $x }; $runEnd = $x } elseif ($runStart -ge 0 -and ($x - $runEnd) -gt 30) { break }
}
$bmp.Dispose()
if ($runStart -lt 0 -or ($runEnd - $runStart) -lt 10) { throw 'Save button not found or not enabled.' }
$save = [pscustomobject]@{ CX = [int](($runStart + $runEnd) / 2); CY = $cancel.CY }
Log ("Save button enabled at x={0}..{1} y={2}" -f $runStart, $runEnd, $cancel.CY)

if ($DryRun) {
  $script:Stage = 'dry-run'
  [PA.W]::Click($dlg, $cancel.CX, $cancel.CY)
  if (-not (Wait-NotesGone 5000)) { [PA.W]::Close($dlg) }
  $dlg = [IntPtr]::Zero
  Log 'DryRun: cancelled the dialog without saving.'
  Remove-Tmp; Restore-Focus; Emit $true ''; exit 0
}

# ---------------- save ----------------
$script:Stage = 'save'
[PA.W]::Click($dlg, $save.CX, $save.CY); $script:Clicked = $true
Log 'Clicked Save, waiting for the dialog to close...'
if (-not (Wait-NotesGone 120000)) {
  $lines = @(Read-Window $dlg 'after-save')
  throw 'Dialog is still open after Save. OCR: ' + (($lines | ForEach-Object Text) -join ' | ')
}
$dlg = [IntPtr]::Zero
Remove-Tmp; Restore-Focus
$script:Stage = 'done'
Log "Save submitted in $([int]($script:Watch.ElapsedMilliseconds/1000))s"
Emit $true ''
exit 0
} catch {
  $msg = $_.Exception.Message
  # Before the click nothing was saved, so cancel the dialog; after it, keep the dialog for inspection.
  try { if (-not $script:Clicked -and $dlg -ne [IntPtr]::Zero -and [PA.W]::IsWindow($dlg)) { [PA.W]::Close($dlg) } } catch {}
  try { Close-Menus } catch {}
  try { Remove-Tmp } catch {}
  try { Restore-Focus } catch {}
  Log "Failed at $($script:Stage): $msg"
  Emit $false $msg
  exit 1
}
