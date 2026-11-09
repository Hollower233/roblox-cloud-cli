<#
  Bundled with rbx (rbx studio publish-as). Drives Roblox Studio "File > Publish As" in the background:
  UI Automation where Qt exposes controls, otherwise PrintWindow capture + Windows OCR + posted input.
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
try {

# ---------------- Win32 helpers ----------------
if (-not ('PA.W' -as [type])) {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Text; using System.Collections.Generic;
namespace PA {
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Title(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
  public static List<IntPtr> TopWindows(uint pid){ var l=new List<IntPtr>(); EnumWindows((h,x)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero); return l; }
  // offset of client origin inside the window image
  public static int[] ClientOffset(IntPtr h){ R r; GetWindowRect(h,out r); P p=new P(); ClientToScreen(h,ref p); return new int[]{p.X-r.L,p.Y-r.T}; }
  public static Bitmap Snap(IntPtr h){ R r; GetWindowRect(h,out r); var b=new Bitmap(Math.Max(1,r.Ri-r.L),Math.Max(1,r.B-r.T)); using(var g=Graphics.FromImage(b)){ var dc=g.GetHdc(); PrintWindow(h,dc,2); g.ReleaseHdc(dc);} return b; }
  static IntPtr XY(int x,int y){ return (IntPtr)(((y&0xFFFF)<<16)|(x&0xFFFF)); }
  public static void Click(IntPtr h,int x,int y){ var l=XY(x,y); PostMessage(h,0x200,IntPtr.Zero,l); System.Threading.Thread.Sleep(40); PostMessage(h,0x201,(IntPtr)1,l); System.Threading.Thread.Sleep(60); PostMessage(h,0x202,IntPtr.Zero,l); }
  public static void Key(IntPtr h,int vk){ PostMessage(h,0x100,(IntPtr)vk,(IntPtr)1); System.Threading.Thread.Sleep(30); PostMessage(h,0x101,(IntPtr)vk,unchecked((IntPtr)(int)0xC0000001)); }
  public static void Type(IntPtr h,string s){ foreach(char c in s){ PostMessage(h,0x102,(IntPtr)c,(IntPtr)1); System.Threading.Thread.Sleep(25);} }
  public static void Wheel(IntPtr h,int cx,int cy,int delta){ P p=new P{X=cx,Y=cy}; ClientToScreen(h,ref p); PostMessage(h,0x200,IntPtr.Zero,XY(cx,cy)); PostMessage(h,0x20A,(IntPtr)((delta&0xFFFF)<<16),XY(p.X,p.Y)); }
  public static void Close(IntPtr h){ PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero); }
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  public static int[] ClientSize(IntPtr h){ R r; GetClientRect(h,out r); return new int[]{r.Ri,r.B}; }
  // resize by 1px and back (no move, no activation) so the engine re-creates its surface at the real size
  public static void Nudge(IntPtr h){ R r; GetWindowRect(h,out r); int w=r.Ri-r.L, ht=r.B-r.T; uint f=0x0002|0x0004|0x0010; SetWindowPos(h,IntPtr.Zero,0,0,w+1,ht,f); System.Threading.Thread.Sleep(300); SetWindowPos(h,IntPtr.Zero,0,0,w,ht,f); }
}}
"@
}
[PA.W]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

# ---------------- OCR ----------------
Add-Type -AssemblyName System.Runtime.WindowsRuntime, UIAutomationClient, UIAutomationTypes
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $script:AsTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
$script:Ocrs = @()
foreach ($lang in 'zh-Hans-CN', 'en-US') { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang)); if ($e) { $script:Ocrs += $e } }
if (-not $script:Ocrs) { $script:Ocrs = @([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()) }
$script:Tmp = Join-Path $env:TEMP ("studio-publish-as-" + [guid]::NewGuid().ToString('N') + '.png')
$script:Shot = 0

function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  $t = $s.ToLowerInvariant() -replace '[^\p{L}\p{N}]', ''
  $t = $t.Replace('l', 'i').Replace('0', 'o').Replace('1', 'i').Replace('|', 'i')
  return $t
}

# OCR with the Chinese engine (CJK names) and the English engine (UI text), merged.
# Returns lines in CLIENT coordinates: Text, N (normalized), X, Y, W, H, CX, CY
function Read-Window([IntPtr]$h, [string]$tag = 'shot') {
  $bmp = [PA.W]::Snap($h)
  $bmp.Save($script:Tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($DebugDir) { $script:Shot++; $bmp.Save((Join-Path $DebugDir ('{0:D2}-{1}.png' -f $script:Shot, $tag))) }
  $bmp.Dispose()
  $off = [PA.W]::ClientOffset($h)
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($script:Tmp)) ([Windows.Storage.StorageFile])
  $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $out = New-Object System.Collections.Generic.List[object]
  try {
    $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $b = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    foreach ($eng in $script:Ocrs) {
      $r = Await ($eng.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
      foreach ($l in $r.Lines) {
        $x1 = 1e9; $y1 = 1e9; $x2 = -1; $y2 = -1
        foreach ($w in @($l.Words)) { $br = $w.BoundingRect; $x1 = [math]::Min($x1, $br.X); $y1 = [math]::Min($y1, $br.Y); $x2 = [math]::Max($x2, $br.X + $br.Width); $y2 = [math]::Max($y2, $br.Y + $br.Height) }
        $x = [int]$x1 - $off[0]; $y = [int]$y1 - $off[1]; $wd = [int]($x2 - $x1); $ht = [int]($y2 - $y1)
        $o = [pscustomobject]@{ Text = $l.Text; N = (Norm $l.Text); X = $x; Y = $y; W = $wd; H = $ht; CX = $x + [int]($wd / 2); CY = $y + [int]($ht / 2) }
        # skip a line whose centre falls inside a line we already have (same text seen by both engines)
        $dup = $false; foreach ($p in $out) { if ($o.CX -ge $p.X -and $o.CX -le $p.X + $p.W -and $o.CY -ge $p.Y -and $o.CY -le $p.Y + $p.H) { $dup = $true; break } }
        if (-not $dup) { $out.Add($o) }
      }
    }
  } finally { $s.Dispose() }
  return $out.ToArray()
}
function Has($lines, [string]$needle) { $n = Norm $needle; [bool]($lines | Where-Object { $_.N.Contains($n) }) }
function Wait-Text([IntPtr]$h, [string]$needle, [int]$timeoutMs = 15000, [string]$tag = 'wait') {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  do { $lines = @(Read-Window $h $tag); if (Has $lines $needle) { return ,$lines }; Start-Sleep -Milliseconds 400 } while ($sw.ElapsedMilliseconds -lt $timeoutMs)
  throw "Timed out waiting for '$needle'. Last OCR: " + (($lines | ForEach-Object Text) -join ' | ')
}
# exact normalized match first, then unique contains match
function Find-One($lines, [string]$name, [scriptblock]$filter = { $true }, [string]$what = 'item') {
  $n = Norm $name
  $cand = @($lines | Where-Object $filter)
  $hit = @($cand | Where-Object { $_.N -eq $n })
  if ($hit.Count -eq 0) { $hit = @($cand | Where-Object { $_.N.Contains($n) -or ($_.N.Length -ge 4 -and $n.StartsWith($_.N)) }) }
  if ($hit.Count -gt 1) { throw "Ambiguous $what '$name': " + (($hit | ForEach-Object Text) -join ' | ') }
  if ($hit.Count -eq 1) { return $hit[0] }
  return $null
}
function Log($m) { [Console]::Error.WriteLine(("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m)) }

# ---------------- locate Studio + dialog ----------------
$script:Stage = 'locate-studio'
$procs = @(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue)
if ($StudioPid) { $procs = @($procs | Where-Object Id -eq $StudioPid) }
if ($procs.Count -ne 1) { throw "Studio process $StudioPid not found." }
$proc = $procs[0]
$main = [PA.W]::TopWindows([uint32]$proc.Id) | Where-Object { [PA.W]::Cls($_) -like '*MainWindow*' -or [PA.W]::Title($_) -like '*Roblox Studio' } | Select-Object -First 1
if (-not $main) { throw 'Studio main window not found.' }
Log "Studio pid=$($proc.Id) window='$([PA.W]::Title($main))'"

$A = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
function Get-Dialog {
  $m = $A::FromHandle($main)
  $d = $m.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Publish Experience')))
  if ($d) { return [IntPtr]$d.Current.NativeWindowHandle }
  return [IntPtr]::Zero
}

$dlg = Get-Dialog
if ($dlg -ne [IntPtr]::Zero) { Log 'Closing an already open Publish dialog'; [PA.W]::Close($dlg); Start-Sleep -Milliseconds 1200 }

# ---------------- open File > Publish As ----------------
$script:Stage = 'open-menu'
# Qt menus ignore posted mouse clicks, so: UIA-expand File, OCR the popup, move the highlight with
# posted Up/Down keys (verified by pixel brightness), then Enter. The whole step is retried.
$fileItem = $A::FromHandle($main).FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'File')))
if (-not $fileItem) { throw 'File menu not found via UIA.' }
$ec = $fileItem.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
function Get-Popups { @([PA.W]::TopWindows([uint32]$proc.Id) | Where-Object { [PA.W]::Cls($_) -like '*Popup*' }) }
function Close-Menus { foreach ($pp in Get-Popups) { [PA.W]::Key($pp, 0x1B) }; try { $ec.Collapse() } catch {}; Start-Sleep -Milliseconds 400 }
function Get-Highlight($popup, $items) {
  $off = [PA.W]::ClientOffset($popup)
  for ($try = 0; $try -lt 8; $try++) {   # PrintWindow on a popup sometimes returns an all-black frame
    $bmp = [PA.W]::Snap($popup); $best = -1; $bv = -1.0; $vals = @()
    for ($i = 0; $i -lt $items.Count; $i++) { $v = $bmp.GetPixel(6 + $off[0], $items[$i].CY + $off[1]).GetBrightness(); $vals += $v; if ($v -gt $bv) { $bv = $v; $best = $i } }
    $bmp.Dispose()
    if ($bv -gt 0.05) { break }
    Start-Sleep -Milliseconds 150
  }
  if ($bv -le 0.05) { return -2 }
  $sorted = @($vals | Sort-Object -Descending)
  if ($sorted.Count -gt 1 -and ($sorted[0] - $sorted[1]) -lt 0.03) { return -1 }
  return $best
}
function Invoke-PublishAs {
  Close-Menus
  $ec.Expand(); $popup = $null
  for ($i = 0; $i -lt 15 -and -not $popup; $i++) {
    Start-Sleep -Milliseconds 200
    $pops = Get-Popups
    if ($pops.Count -gt 1) { return 'extra popup open' }
    if ($pops.Count -eq 1) { $popup = $pops[0] }
  }
  if (-not $popup) { return 'popup did not appear' }
  # preferred path: UIA Invoke on the menu item (Qt sometimes stops exposing menu items; then fall back)
  $uiaItem = $fileItem.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Publish As')))
  if ($uiaItem) {
    try { $uiaItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $script:MenuPath = 'UIA'; return 'ok' } catch {}
  }
  $script:MenuPath = 'keyboard+OCR'
  Start-Sleep -Milliseconds 300
  # PrintWindow on a fresh popup can return a black or half-painted frame; re-read before giving up
  for ($r = 0; $r -lt 6; $r++) {
    $menuLines = @(Read-Window $popup 'menu')
    if (Has $menuLines 'Download a Copy') { break }
    if ((Get-Popups).Count -ne 1) { return 'menu closed while reading' }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Has $menuLines 'Download a Copy')) { return 'popup is not the File menu: ' + (($menuLines | ForEach-Object Text) -join ' | ') }
  $items = @($menuLines | Where-Object { $_.X -lt 150 } | Sort-Object Y)
  $idx = -1; for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].N -eq (Norm 'Publish As')) { $idx = $i; break } }
  if ($idx -lt 0) { return 'Publish As not in menu' }
  for ($round = 0; $round -lt 12; $round++) {
    if ((Get-Popups).Count -ne 1) { return 'menu changed while navigating' }
    $cur = Get-Highlight $popup $items
    if ($cur -eq $idx) { [PA.W]::Key($popup, 0x0D); return 'ok' }
    if ($cur -eq -2) { continue }
    if ($cur -lt 0) { $steps = $idx + 1; $vk = 0x28 } elseif ($cur -lt $idx) { $steps = $idx - $cur; $vk = 0x28 } else { $steps = $cur - $idx; $vk = 0x26 }
    for ($i = 0; $i -lt $steps; $i++) { [PA.W]::Key($popup, $vk); Start-Sleep -Milliseconds 60 }
    Start-Sleep -Milliseconds 250
  }
  return 'could not highlight Publish As'
}
$res = ''
for ($attempt = 1; $attempt -le 4; $attempt++) {
  $res = Invoke-PublishAs
  if ($res -eq 'ok') { break }
  Log "Menu attempt $attempt failed: $res"
}
if ($res -ne 'ok') { Close-Menus; throw "Could not open File > Publish As: $res" }
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
