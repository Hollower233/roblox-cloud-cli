<#
  Shared helpers for the bundled Studio UI scripts (publish-as.ps1, save-notes.ps1); dot-source it from them.
  UI Automation where Qt exposes controls, otherwise PrintWindow capture + Windows OCR + posted input.
  The caller defines Log before dot-sourcing and may set $DebugDir. Keep this file ASCII-only.
#>

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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

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
  // foreground-only fallbacks: real keyboard input goes to whatever window is active
  public static bool Activate(IntPtr h){ if(IsIconic(h)) ShowWindow(h,9); SetForegroundWindow(h); System.Threading.Thread.Sleep(250); return GetForegroundWindow()==h; }
  public static void Restore(IntPtr h){ if(h!=IntPtr.Zero && IsWindow(h)) SetForegroundWindow(h); }
  public static void Chord(byte[] mods, byte vk){ foreach(var m in mods) keybd_event(m,0,0,UIntPtr.Zero); keybd_event(vk,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(40); keybd_event(vk,0,2,UIntPtr.Zero); for(int i=mods.Length-1;i>=0;i--) keybd_event(mods[i],0,2,UIntPtr.Zero); }
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
$script:Tmp = Join-Path $env:TEMP ("studio-ui-" + [guid]::NewGuid().ToString('N') + '.png')
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
function Remove-Tmp { try { if ($script:Tmp) { Remove-Item $script:Tmp -ErrorAction SilentlyContinue } } catch {} }

# ---------------- Studio + File menu ----------------
$A = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
# Sets $script:StudioProc / $script:StudioMain for the editor process.
function Find-Studio([int]$ProcessId) {
  $procs = @(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue)
  if ($ProcessId) { $procs = @($procs | Where-Object Id -eq $ProcessId) }
  if ($procs.Count -ne 1) { throw "Studio process $ProcessId not found." }
  $script:StudioProc = $procs[0]
  $script:StudioMain = [PA.W]::TopWindows([uint32]$script:StudioProc.Id) | Where-Object { [PA.W]::Cls($_) -like '*MainWindow*' -or [PA.W]::Title($_) -like '*Roblox Studio' } | Select-Object -First 1
  if (-not $script:StudioMain) { throw 'Studio main window not found.' }
  Log "Studio pid=$($script:StudioProc.Id) window='$([PA.W]::Title($script:StudioMain))'"
}
# A dialog that is a direct UIA child of the Studio main window, by title; Zero when absent or hidden.
function Get-ChildDialog([string]$Name) {
  $d = $A::FromHandle($script:StudioMain).FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $Name)))
  if ($d) { $h = [IntPtr]$d.Current.NativeWindowHandle; if ($h -ne [IntPtr]::Zero -and [PA.W]::IsWindowVisible($h)) { return $h } }
  return [IntPtr]::Zero
}
function Get-Popups { @([PA.W]::TopWindows([uint32]$script:StudioProc.Id) | Where-Object { [PA.W]::Cls($_) -like '*Popup*' }) }
function Close-Menus {
  foreach ($pp in Get-Popups) { [PA.W]::Key($pp, 0x1B) }
  try { if ($script:FileEc) { $script:FileEc.Collapse() } } catch {}
  Start-Sleep -Milliseconds 400
}
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
# One attempt at File > $Item. Qt menus ignore posted mouse clicks, so: UIA-expand File, try UIA Invoke on the
# item (unless -NoUia), else OCR the popup, move the highlight with posted Up/Down keys (verified by pixel
# brightness), then Enter. Returns 'ok' or the reason it failed; sets $script:MenuPath.
function Invoke-FileMenuOnce([string]$Item, [switch]$NoUia) {
  if (-not $script:FileItem) {
    $script:FileItem = $A::FromHandle($script:StudioMain).FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'File')))
    if (-not $script:FileItem) { throw 'File menu not found via UIA.' }
    $script:FileEc = $script:FileItem.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  }
  Close-Menus
  $script:FileEc.Expand(); $popup = $null
  for ($i = 0; $i -lt 15 -and -not $popup; $i++) {
    Start-Sleep -Milliseconds 200
    $pops = Get-Popups
    if ($pops.Count -gt 1) { return 'extra popup open' }
    if ($pops.Count -eq 1) { $popup = $pops[0] }
  }
  if (-not $popup) { return 'popup did not appear' }
  $uiaItem = $script:FileItem.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $Item)))
  # greyed out (e.g. during Play Test, or not a Roblox place): no fallback can help
  if ($uiaItem -and -not $uiaItem.Current.IsEnabled) { Close-Menus; return "DISABLED: File > $Item is disabled (is Studio in Play Test, or is this not a Roblox place?)" }
  if (-not $NoUia) {
    # preferred path: UIA Invoke on the menu item (Qt sometimes stops exposing menu items, or ignores Invoke)
    if ($uiaItem) {
      try { $uiaItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $script:MenuPath = 'UIA'; return 'ok' } catch {}
    }
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
  $idx = -1; for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].N -eq (Norm $Item)) { $idx = $i; break } }
  if ($idx -lt 0) { return "$Item not in menu" }
  for ($round = 0; $round -lt 12; $round++) {
    if ((Get-Popups).Count -ne 1) { return 'menu changed while navigating' }
    $cur = Get-Highlight $popup $items
    if ($cur -eq $idx) { [PA.W]::Key($popup, 0x0D); return 'ok' }
    if ($cur -eq -2) { continue }
    if ($cur -lt 0) { $steps = $idx + 1; $vk = 0x28 } elseif ($cur -lt $idx) { $steps = $idx - $cur; $vk = 0x28 } else { $steps = $cur - $idx; $vk = 0x26 }
    for ($i = 0; $i -lt $steps; $i++) { [PA.W]::Key($popup, $vk); Start-Sleep -Milliseconds 60 }
    Start-Sleep -Milliseconds 250
  }
  return "could not highlight $Item"
}
function Invoke-FileMenu([string]$Item, [int]$Attempts = 4, [switch]$NoUia) {
  $res = ''
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $res = Invoke-FileMenuOnce $Item -NoUia:$NoUia
    if ($res -eq 'ok' -or $res.StartsWith('DISABLED:')) { break }
    Log "Menu attempt $attempt failed: $res"
  }
  if ($res -ne 'ok') { Close-Menus }
  return $res
}
# Foreground fallback: activate Studio and press a real key chord. Remembers the previous foreground window
# in $script:PrevForeground so the caller can hand focus back. Returns 'ok' or the reason it failed.
function Send-StudioChord([byte[]]$Mods, [byte]$Vk) {
  $script:PrevForeground = [PA.W]::GetForegroundWindow()
  if (-not [PA.W]::Activate($script:StudioMain)) {
    try { $A::FromHandle($script:StudioMain).SetFocus() } catch {}
    Start-Sleep -Milliseconds 250
    if ([PA.W]::GetForegroundWindow() -ne $script:StudioMain) { return 'could not bring Studio to the foreground' }
  }
  [PA.W]::Chord($Mods, $Vk)
  $script:MenuPath = 'hotkey'
  return 'ok'
}
