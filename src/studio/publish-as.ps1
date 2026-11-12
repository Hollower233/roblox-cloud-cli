<#
  Bundled with rbx (rbx studio publish-as). Drives Roblox Studio "File > Publish As" in the background:
  UI Automation where Qt exposes controls, otherwise PrintWindow capture + Windows OCR + posted input.
  Shared helpers live in studio-ui.ps1 next to this file.
  Input: -ArgsB64 = base64(UTF-8 JSON {pid, group, experience, search, place, newPlace, dryRun, debugDir}).
  Output: progress lines on stderr, one "@@RESULT {json}" line on stdout. Keep this file ASCII-only.
#>
param([Parameter(Mandatory)][string]$ArgsB64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json
$Group = [string]$cfg.group; $Experience = [string]$cfg.experience; $SearchText = [string]$cfg.search
$NewPlace = [bool]$cfg.newPlace; $Place = if ($NewPlace) { '' } else { [string]$cfg.place }
$StudioPid = [int]$cfg.pid; $DryRun = [bool]$cfg.dryRun; $DebugDir = if ($cfg.debugDir) { [string]$cfg.debugDir } else { '' }
if ($DebugDir) { New-Item -ItemType Directory -Force $DebugDir | Out-Null }
$script:Stage = 'init'; $script:Clicked = $false; $script:MenuPath = $null; $script:ButtonText = $null; $dlg = [IntPtr]::Zero
$script:Watch = [Diagnostics.Stopwatch]::StartNew()
function Emit([bool]$ok, [string]$msg) {
  $r = [ordered]@{ ok = $ok; stage = $script:Stage; clicked = $script:Clicked; elapsedMs = [int]$script:Watch.ElapsedMilliseconds }
  if ($msg) { $r.message = $msg }; if ($script:MenuPath) { $r.menuPath = $script:MenuPath }; if ($script:ButtonText) { $r.button = $script:ButtonText }
  [Console]::Out.WriteLine('@@RESULT ' + ($r | ConvertTo-Json -Compress))
}
function Log($m) { [Console]::Error.WriteLine(("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m)) }
try {

. (Join-Path $PSScriptRoot 'studio-ui.ps1')

# ---------------- locate Studio + dialog ----------------
$script:Stage = 'locate-studio'
Find-Studio $StudioPid
function Get-Dialog { Get-ChildDialog 'Publish Experience' }

$dlg = Get-Dialog
if ($dlg -ne [IntPtr]::Zero) { Log 'Closing an already open Publish dialog'; [PA.W]::Close($dlg); Start-Sleep -Milliseconds 1200 }

# ---------------- open File > Publish As ----------------
$script:Stage = 'open-menu'
$res = Invoke-FileMenu 'Publish As'
if ($res -ne 'ok') { throw "Could not open File > Publish As: $res" }
Log "Triggered File > Publish As (via $script:MenuPath)"
$script:Stage = 'open-dialog'
$sw = [Diagnostics.Stopwatch]::StartNew()
do { Start-Sleep -Milliseconds 500; $dlg = Get-Dialog } while ($dlg -eq [IntPtr]::Zero -and $sw.ElapsedMilliseconds -lt 45000)
if ($dlg -eq [IntPtr]::Zero) { throw 'Publish Experience dialog did not open.' }

# The dialog is laid out at 1200x900 logical units * DPI scale. On mixed-DPI setups the engine may keep
# rendering at a stale size; nudge the window until the bottom buttons ("Cancel") are visible.
$lines = @()
for ($i = 0; $i -lt 4; $i++) {
  try { $lines = Wait-Text $dlg 'Choose an experience' 8000 'page1' } catch { $lines = @() }
  if ((Has $lines 'Choose an experience') -and (Has $lines 'Cancel')) { break }
  Log 'Dialog not fully rendered, forcing a resize'; [PA.W]::Nudge($dlg); Start-Sleep -Milliseconds 1200
}
if (-not ((Has $lines 'Choose an experience') -and (Has $lines 'Cancel'))) { throw 'Dialog never rendered completely. OCR: ' + (($lines | ForEach-Object Text) -join ' | ') }
$cs = [PA.W]::ClientSize($dlg); $script:S = $cs[0] / 1200.0
function S([double]$v) { [int][math]::Round($v * $script:S) }
Log ("Dialog page 1 ready (client {0}x{1}, scale {2:N2})" -f $cs[0], $cs[1], $script:S)

# ---------------- choose group ----------------
$script:Stage = 'choose-group'
$ddArea = { $_.X -lt (S 450) -and $_.Y -gt (S 80) -and $_.Y -lt (S 160) }
$dd = $lines | Where-Object $ddArea | Select-Object -First 1
if (-not $dd) { throw 'Group dropdown not found.' }
if ($dd.N -ne (Norm $Group)) {
  [PA.W]::Click($dlg, $dd.CX, $dd.CY); Start-Sleep -Milliseconds 700
  $found = $null; $lastSig = ''
  $list = { $_.X -lt (S 450) -and $_.Y -gt (S 160) -and $_.Y -lt (S 440) }
  for ($i = 0; $i -lt 25 -and -not $found; $i++) {
    $lines = @(Read-Window $dlg 'groups')
    $found = Find-One $lines $Group $list 'group'
    if ($found) { break }
    $sig = (($lines | Where-Object $list | ForEach-Object N) -join '|')
    if ($sig -eq $lastSig) { break }; $lastSig = $sig
    [PA.W]::Wheel($dlg, (S 220), (S 300), -120); Start-Sleep -Milliseconds 400
  }
  if (-not $found) { [PA.W]::Close($dlg); throw "Group '$Group' not found in dropdown." }
  [PA.W]::Click($dlg, $found.CX, $found.CY); Start-Sleep -Milliseconds 1500
  $lines = @(Read-Window $dlg 'group-selected')
  $dd = $lines | Where-Object $ddArea | Select-Object -First 1
  if (-not $dd -or $dd.N -ne (Norm $Group)) { [PA.W]::Close($dlg); throw "Group selection did not stick (dropdown shows '$($dd.Text)')." }
}
Log "Group: $Group"

# ---------------- choose experience (via search box) ----------------
$script:Stage = 'choose-experience'
$search = $lines | Where-Object { $_.X -gt (S 600) -and $_.Y -lt (S 160) -and $_.N.Contains('search') } | Select-Object -First 1
if ($search) { [PA.W]::Click($dlg, $search.CX, $search.CY); Start-Sleep -Milliseconds 300; [PA.W]::Type($dlg, $SearchText); Start-Sleep -Milliseconds 1500 }
$tile = $null
for ($i = 0; $i -lt 8 -and -not $tile; $i++) {
  $lines = @(Read-Window $dlg 'experiences')
  $tile = Find-One $lines $Experience { $_.Y -gt (S 170) -and $_.Y -lt (S 840) -and $_.N -notin @('private', 'public', 'limited') } 'experience'
  if (-not $tile) { Start-Sleep -Milliseconds 700 }
}
if (-not $tile) { [PA.W]::Close($dlg); throw "Experience '$Experience' not found under '$Group'." }
[PA.W]::Click($dlg, $tile.X + (S 83), $tile.Y - (S 110))   # thumbnail above the label
$lines = Wait-Text $dlg 'Overwrite or add a new place' 15000 'page2'
if (-not (Has $lines $Experience)) { [PA.W]::Close($dlg); throw "Page 2 is not for '$Experience': " + (($lines | ForEach-Object Text) -join ' | ') }
Log "Experience: $Experience"

# ---------------- choose place ----------------
$script:Stage = 'choose-place'
$rowArea = { $_.X -gt (S 150) -and $_.X -lt (S 700) -and $_.Y -gt (S 300) -and $_.Y -lt (S 820) }
if ($NewPlace) {
  $row = Find-One $lines 'Add as a new place' { $true } 'row'
} else {
  $row = Find-One $lines $Place $rowArea 'place'
  if (-not $row) {
    $ps = $lines | Where-Object { $_.X -gt (S 700) -and $_.Y -lt (S 160) -and $_.N.Contains('search') } | Select-Object -First 1
    if ($ps) { [PA.W]::Click($dlg, $ps.CX, $ps.CY); Start-Sleep -Milliseconds 300; [PA.W]::Type($dlg, $Place); Start-Sleep -Milliseconds 1200
      $lines = @(Read-Window $dlg 'place-search')
      $row = Find-One $lines $Place $rowArea 'place' }
  }
}
if (-not $row) { [PA.W]::Close($dlg); throw "Place '$Place' not found in '$Experience'." }
[PA.W]::Click($dlg, (S 37), $row.CY); Start-Sleep -Milliseconds 700

# verify radio is selected (white ring) and the action button is enabled (blue)
$off = [PA.W]::ClientOffset($dlg); $bmp = [PA.W]::Snap($dlg)
if ($DebugDir) { $script:Shot++; $bmp.Save((Join-Path $DebugDir ('{0:D2}-place-selected.png' -f $script:Shot))) }
$px = $bmp.GetPixel((S 44) + $off[0], $row.CY + $off[1])
$lines = @(Read-Window $dlg 'confirm')
$btnName = if ($NewPlace) { 'Create' } else { 'Overwrite' }
# bold white-on-blue text is sometimes misread, so take the right-most bottom-bar text that is not "Cancel"
$btn = $lines | Where-Object { $_.Y -gt (S 800) -and $_.X -gt (S 900) -and -not $_.N.Contains('cancei') -and -not $_.N.Contains('cancel') } | Sort-Object X -Descending | Select-Object -First 1
if ($btn) { Log "Action button OCR: '$($btn.Text)'"; $script:ButtonText = $btn.Text }
if (-not $btn) { $bmp.Dispose(); [PA.W]::Close($dlg); throw "$btnName button not found." }
# sample a strip left of the label (inside the button padding); OCR boxes can be a few px off
$blue = $false; $seen = @()
foreach ($dx in 4, 8, 12, 16, 20, 26) {
  $bp = $bmp.GetPixel([math]::Max(0, $btn.X - (S $dx) + $off[0]), $btn.CY + $off[1]); $seen += ('{0},{1},{2}' -f $bp.R, $bp.G, $bp.B)
  if ($bp.B -gt 180 -and $bp.R -lt 120) { $blue = $true; break }
}
$bmp.Dispose()
Log ("Button box x={0} y={1} w={2} h={3}; sampled {4}" -f $btn.X, $btn.Y, $btn.W, $btn.H, ($seen -join ' '))
if ($px.GetBrightness() -lt 0.6) { [PA.W]::Close($dlg); throw "Radio for '$($row.Text)' does not look selected." }
if (-not $blue) { [PA.W]::Close($dlg); throw "$btnName button does not look enabled." }
Log "Place: $($row.Text) selected; '$btnName' enabled"

if ($DryRun) { [PA.W]::Close($dlg); $dlg = [IntPtr]::Zero; Log 'DryRun: closed dialog without publishing.'; Remove-Item $script:Tmp -ErrorAction SilentlyContinue; $script:Stage = 'dry-run'; Emit $true ''; exit 0 }

# ---------------- publish ----------------
$script:Stage = 'publish'
[PA.W]::Click($dlg, $btn.CX, $btn.CY); $script:Clicked = $true
Log "Clicked $btnName, uploading..."
$sw = [Diagnostics.Stopwatch]::StartNew(); $ok = $false
do {
  Start-Sleep -Milliseconds 1000
  $lines = @(Read-Window $dlg 'result')
  if (Has $lines 'Successfully published') { $ok = $true; break }
  $err = $lines | Where-Object { $_.N -match 'fail|error|unabie|rejected' } | Select-Object -First 1
  if ($err) { throw "Publish failed: $($err.Text)" }
} while ($sw.ElapsedMilliseconds -lt 300000)
if (-not $ok) { throw 'Timed out waiting for publish result.' }
[PA.W]::Close($dlg); $dlg = [IntPtr]::Zero
Remove-Item $script:Tmp -ErrorAction SilentlyContinue
Log "Published to $Group / $Experience / $(if ($NewPlace) { '(new place)' } else { $Place }) in $([int]($sw.ElapsedMilliseconds/1000))s"
$script:Stage = 'done'
Emit $true ''
exit 0
} catch {
  $msg = $_.Exception.Message
  # Before the click nothing was published, so leave Studio as it was; after it, keep the dialog for inspection.
  try { if (-not $script:Clicked -and $dlg -ne [IntPtr]::Zero -and [PA.W]::IsWindow($dlg)) { [PA.W]::Close($dlg) } } catch {}
  try { if ($script:Tmp) { Remove-Item $script:Tmp -ErrorAction SilentlyContinue } } catch {}
  Log "Failed at $($script:Stage): $msg"
  Emit $false $msg
  exit 1
}
