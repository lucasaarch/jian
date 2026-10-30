# Jian Remote Control — Windows computer-use helper
# JSON lines on stdin → JSON lines on stdout (same cmds as macOS/Linux helpers).
# Overlay: the Jian pointer sprite macOS embeds (assets/jian-pointer.png), in a topmost layered
# window with per-pixel alpha that clicks pass through.
# Input: SendInput with save/restore so agent clicks do not strand the user cursor.
# English-only errors.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The macOS canvas and tip, in points; this helper is not DPI aware, so Windows scales them.
$script:PointerSize = 60
$script:HotspotX = 12
$script:HotspotY = 12
$script:SessionAlpha = 0.94
$script:IdleAlpha = 0.18
$script:TipX = 0.0
$script:TipY = 0.0
$script:HasTip = $false
$script:OverlayForm = $null
$script:SessionActive = $false

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class JianInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern int ShowCursor(bool bShow);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
"@

# assets/jian-pointer.png (@3x master), embedded so the helper copied on its own still has it.
$script:PointerPngBase64 = @'
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
'@

# A layered window takes premultiplied pixels through UpdateLayeredWindow: the glow fades into
# the desktop instead of a keyed-out colour bleeding at its edge.
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class JianPointerWindow : Form {
  [StructLayout(LayoutKind.Sequential)] struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct SZ { public int W; public int H; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  struct BLEND { public byte Op; public byte Flags; public byte Alpha; public byte Format; }

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")]
  static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dst, ref PT pos, ref SZ size,
    IntPtr src, ref PT srcPos, int key, ref BLEND blend, int flags);

  const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOPMOST = 0x8;
  const int WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000, ULW_ALPHA = 2;

  readonly Bitmap sprite;
  byte alpha = 255;

  public JianPointerWindow(string pngBase64, int size) {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    TopMost = true;
    Size = new Size(size, size);
    using (var stream = new MemoryStream(Convert.FromBase64String(pngBase64)))
    using (var master = new Bitmap(stream)) {
      sprite = new Bitmap(size, size, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(sprite)) {
        g.Clear(Color.Transparent);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(master, new Rectangle(0, 0, size, size));
      }
    }
  }

  // Layered for per-pixel alpha, transparent so the agent's clicks reach what is beneath,
  // and never activated, so the owner's focus stays where it was.
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
      return cp;
    }
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    Render();
  }

  public void SetAlpha(double opacity) {
    alpha = (byte)Math.Round(Math.Max(0.0, Math.Min(1.0, opacity)) * 255);
    Render();
  }

  public void MoveTo(int x, int y) {
    Location = new Point(x, y);
    Render();
  }

  public void Render() {
    if (!IsHandleCreated) return;
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memory = CreateCompatibleDC(screen);
    // GDI+ hands the bitmap to GDI premultiplied, which is what ULW_ALPHA blends.
    IntPtr bitmap = sprite.GetHbitmap(Color.FromArgb(0));
    IntPtr previous = SelectObject(memory, bitmap);
    try {
      var pos = new PT { X = Left, Y = Top };
      var size = new SZ { W = sprite.Width, H = sprite.Height };
      var origin = new PT { X = 0, Y = 0 };
      var blend = new BLEND { Op = 0, Flags = 0, Alpha = alpha, Format = 1 };
      UpdateLayeredWindow(Handle, screen, ref pos, ref size, memory, ref origin, 0, ref blend, ULW_ALPHA);
    } finally {
      SelectObject(memory, previous);
      DeleteObject(bitmap);
      DeleteDC(memory);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  protected override void Dispose(bool disposing) {
    if (disposing) sprite.Dispose();
    base.Dispose(disposing);
  }
}
"@

function Write-Response($obj) {
  $json = ($obj | ConvertTo-Json -Compress -Depth 6)
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Write-Ok([hashtable]$extra = @{}) {
  $body = @{ ok = $true }
  foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] }
  Write-Response $body
}

function Write-Err([string]$message) {
  Write-Response @{ ok = $false; error = $message }
}

function Get-PrimaryBounds {
  [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

function Ease-OutCubic([double]$t) {
  $x = [Math]::Min(1.0, [Math]::Max(0.0, $t))
  return 1.0 - [Math]::Pow(1.0 - $x, 3)
}

function Ensure-Overlay {
  if ($script:OverlayForm -ne $null) { return }
  $script:OverlayForm = New-Object JianPointerWindow -ArgumentList $script:PointerPngBase64, $script:PointerSize
}

function Position-Overlay {
  if ($script:OverlayForm -eq $null) { return }
  $x = [int]($script:TipX - $script:HotspotX)
  $y = [int]($script:TipY - $script:HotspotY)
  $script:OverlayForm.MoveTo($x, $y)
}

function Ensure-Session {
  Ensure-Overlay
  if (-not $script:HasTip) {
    $b = Get-PrimaryBounds
    $script:TipX = $b.Width / 2
    $script:TipY = $b.Height / 2
    $script:HasTip = $true
  }
  Position-Overlay
  if (-not $script:OverlayForm.Visible) {
    $script:OverlayForm.Show()
  }
  $script:OverlayForm.SetAlpha($script:SessionAlpha)
  $script:SessionActive = $true
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Idle {
  Ensure-Session
  $script:OverlayForm.SetAlpha($script:IdleAlpha)
  [System.Windows.Forms.Application]::DoEvents()
}

function End-Session {
  if ($script:OverlayForm -ne $null) {
    $script:OverlayForm.Hide()
  }
  $script:SessionActive = $false
  $script:HasTip = $false
  [System.Windows.Forms.Application]::DoEvents()
}

function Move-Tip([double]$x, [double]$y) {
  $script:TipX = $x
  $script:TipY = $y
  $script:HasTip = $true
  Ensure-Overlay
  if ($script:SessionActive -or $true) {
    if (-not $script:OverlayForm.Visible) { $script:OverlayForm.Show() }
  }
  Position-Overlay
  [System.Windows.Forms.Application]::DoEvents()
}

function Animate-Overlay([double]$tx, [double]$ty) {
  Ensure-Session
  $sx = $script:TipX
  $sy = $script:TipY
  $dx = $tx - $sx
  $dy = $ty - $sy
  $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
  if ($distance -lt 1.5) {
    Move-Tip $tx $ty
    return
  }
  $duration = [Math]::Min(0.11, [Math]::Max(0.028, $distance * 0.00025))
  $steps = [Math]::Max(1, [int][Math]::Ceiling($duration * 60))
  $stepSleep = $duration / $steps
  for ($i = 1; $i -le $steps; $i++) {
    $t = Ease-OutCubic ($i / $steps)
    Move-Tip ($sx + $dx * $t) ($sy + $dy * $t)
    if ($i -lt $steps) { Start-Sleep -Milliseconds ([Math]::Max(1, [int]($stepSleep * 1000))) }
  }
  Move-Tip $tx $ty
}

function Get-CursorPos {
  $p = New-Object JianInput+POINT
  [void][JianInput]::GetCursorPos([ref]$p)
  return @($p.X, $p.Y)
}

function Warp-Cursor([int]$x, [int]$y) {
  [void][JianInput]::SetCursorPos($x, $y)
}

function With-PreservedCursor([scriptblock]$body) {
  $saved = Get-CursorPos
  [void][JianInput]::ShowCursor($false)
  try {
    & $body
  } finally {
    Warp-Cursor $saved[0] $saved[1]
    Start-Sleep -Milliseconds 8
    [void][JianInput]::ShowCursor($true)
  }
}

function Send-MouseClick([string]$button, [int]$count) {
  $down = if ($button -eq 'right') { [JianInput]::MOUSEEVENTF_RIGHTDOWN } else { [JianInput]::MOUSEEVENTF_LEFTDOWN }
  $up = if ($button -eq 'right') { [JianInput]::MOUSEEVENTF_RIGHTUP } else { [JianInput]::MOUSEEVENTF_LEFTUP }
  for ($i = 0; $i -lt $count; $i++) {
    $inputs = @(
      New-Object JianInput+INPUT
      New-Object JianInput+INPUT
    )
    $inputs[0].type = [JianInput]::INPUT_MOUSE
    $inputs[0].U.mi.dwFlags = $down
    $inputs[1].type = [JianInput]::INPUT_MOUSE
    $inputs[1].U.mi.dwFlags = $up
    [void][JianInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 40 }
  }
}

function Click-At([double]$x, [double]$y, [string]$button, [int]$count) {
  Animate-Overlay $x $y
  With-PreservedCursor {
    Warp-Cursor ([int]$x) ([int]$y)
    Send-MouseClick $button $count
  }
}

function Drag-To([double]$fx, [double]$fy, [double]$tx, [double]$ty) {
  Animate-Overlay $fx $fy
  With-PreservedCursor {
    Warp-Cursor ([int]$fx) ([int]$fy)
    $down = New-Object JianInput+INPUT
    $down.type = [JianInput]::INPUT_MOUSE
    $down.U.mi.dwFlags = [JianInput]::MOUSEEVENTF_LEFTDOWN
    [void][JianInput]::SendInput(1, @($down), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
    $distance = [Math]::Sqrt(($tx - $fx) * ($tx - $fx) + ($ty - $fy) * ($ty - $fy))
    $steps = [Math]::Max(6, [Math]::Min(14, [int]($distance / 40) + 6))
    for ($i = 1; $i -le $steps; $i++) {
      $t = Ease-OutCubic ($i / $steps)
      $px = $fx + ($tx - $fx) * $t
      $py = $fy + ($ty - $fy) * $t
      Move-Tip $px $py
      Warp-Cursor ([int]$px) ([int]$py)
      Start-Sleep -Milliseconds 6
    }
    $up = New-Object JianInput+INPUT
    $up.type = [JianInput]::INPUT_MOUSE
    $up.U.mi.dwFlags = [JianInput]::MOUSEEVENTF_LEFTUP
    [void][JianInput]::SendInput(1, @($up), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
  }
  Move-Tip $tx $ty
}

function Scroll-At([double]$x, [double]$y, [string]$direction, [int]$amount) {
  Animate-Overlay $x $y
  $wheel = 0
  $hwheel = 0
  switch ($direction) {
    'up' { $wheel = 120 }
    'down' { $wheel = -120 }
    'left' { $hwheel = -120 }
    'right' { $hwheel = 120 }
  }
  With-PreservedCursor {
    Warp-Cursor ([int]$x) ([int]$y)
    for ($i = 0; $i -lt [Math]::Max(1, $amount); $i++) {
      $inp = New-Object JianInput+INPUT
      $inp.type = [JianInput]::INPUT_MOUSE
      if ($wheel -ne 0) {
        $inp.U.mi.dwFlags = [JianInput]::MOUSEEVENTF_WHEEL
        $inp.U.mi.mouseData = [uint32]([int32]$wheel)
      } else {
        $inp.U.mi.dwFlags = [JianInput]::MOUSEEVENTF_HWHEEL
        $inp.U.mi.mouseData = [uint32]([int32]$hwheel)
      }
      [void][JianInput]::SendInput(1, @($inp), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
      Start-Sleep -Milliseconds 12
    }
  }
}

function Type-Text([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq "`n" -or $ch -eq "`r") {
      Post-Key 0x0D
      continue
    }
    if ($ch -eq "`t") {
      Post-Key 0x09
      continue
    }
    $inputs = @(
      New-Object JianInput+INPUT
      New-Object JianInput+INPUT
    )
    $inputs[0].type = [JianInput]::INPUT_KEYBOARD
    $inputs[0].U.ki.wScan = [uint16][int][char]$ch
    $inputs[0].U.ki.dwFlags = [JianInput]::KEYEVENTF_UNICODE
    $inputs[1].type = [JianInput]::INPUT_KEYBOARD
    $inputs[1].U.ki.wScan = [uint16][int][char]$ch
    $inputs[1].U.ki.dwFlags = [JianInput]::KEYEVENTF_UNICODE -bor [JianInput]::KEYEVENTF_KEYUP
    [void][JianInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
    Start-Sleep -Milliseconds 2
  }
}

function Post-Key([ushort]$vk, [uint32]$flags = 0) {
  $down = New-Object JianInput+INPUT
  $down.type = [JianInput]::INPUT_KEYBOARD
  $down.U.ki.wVk = $vk
  $down.U.ki.dwFlags = $flags
  $up = New-Object JianInput+INPUT
  $up.type = [JianInput]::INPUT_KEYBOARD
  $up.U.ki.wVk = $vk
  $up.U.ki.dwFlags = $flags -bor [JianInput]::KEYEVENTF_KEYUP
  [void][JianInput]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
}

function Parse-And-PostKey([string]$keySpec) {
  $parts = $keySpec.Split('+') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ }
  if (-not $parts) { return $false }
  $mods = @()
  $key = $null
  foreach ($part in $parts) {
    switch ($part) {
      { $_ -in @('cmd','command','meta','super','win','windows') } { $mods += 0x5B; break }
      { $_ -in @('ctrl','control') } { $mods += 0x11; break }
      { $_ -in @('alt','option','opt') } { $mods += 0x12; break }
      'shift' { $mods += 0x10; break }
      default {
        if ($null -ne $key) { return $false }
        $key = $part
      }
    }
  }
  if ($null -eq $key) { return $false }
  $named = @{
    return = 0x0D; enter = 0x0D; tab = 0x09; escape = 0x1B; esc = 0x1B
    delete = 0x2E; backspace = 0x08; space = 0x20
    up = 0x26; down = 0x28; left = 0x25; right = 0x27
    home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
  }
  $vk = $null
  if ($named.ContainsKey($key)) { $vk = [ushort]$named[$key] }
  elseif ($key.Length -eq 1) {
    $scan = [JianInput]::VkKeyScan([char]$key[0])
    if ($scan -eq -1) { return $false }
    $vk = [ushort]($scan -band 0xFF)
  }
  elseif ($key.StartsWith('f') -and $key.Substring(1) -match '^\d+$') {
    $n = [int]$key.Substring(1)
    if ($n -ge 1 -and $n -le 12) { $vk = [ushort](0x70 + $n - 1) }
  }
  if ($null -eq $vk) { return $false }
  foreach ($m in $mods) {
    $down = New-Object JianInput+INPUT
    $down.type = [JianInput]::INPUT_KEYBOARD
    $down.U.ki.wVk = [ushort]$m
    [void][JianInput]::SendInput(1, @($down), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
  }
  Post-Key $vk
  for ($i = $mods.Count - 1; $i -ge 0; $i--) {
    $up = New-Object JianInput+INPUT
    $up.type = [JianInput]::INPUT_KEYBOARD
    $up.U.ki.wVk = [ushort]$mods[$i]
    $up.U.ki.dwFlags = [JianInput]::KEYEVENTF_KEYUP
    [void][JianInput]::SendInput(1, @($up), [System.Runtime.InteropServices.Marshal]::SizeOf([type][JianInput+INPUT]))
  }
  return $true
}

function Geometry-Response {
  $b = Get-PrimaryBounds
  return @{
    ok = $true
    originX = 0
    originY = 0
    pointWidth = [double]$b.Width
    pointHeight = [double]$b.Height
    pixelWidth = [double]$b.Width
    pixelHeight = [double]$b.Height
    scaleFactor = 1.0
  }
}

function Handle-Command($obj) {
  $cmd = [string]$obj.cmd
  switch ($cmd) {
    'ping' { Write-Ok; break }
    'geometry' { Write-Response (Geometry-Response); break }
    'ensureSession' { Ensure-Session; Write-Ok; break }
    'setIdle' { Set-Idle; Write-Ok; break }
    'endSession' { End-Session; Write-Ok; break }
    'move' {
      Animate-Overlay ([double]$obj.pointX) ([double]$obj.pointY)
      Write-Ok
      break
    }
    'click' {
      $button = if ($obj.button) { [string]$obj.button } else { 'left' }
      $count = if ($obj.count) { [int]$obj.count } else { 1 }
      Click-At $script:TipX $script:TipY $button.ToLowerInvariant() $count
      Write-Ok
      break
    }
    'clickAt' {
      $button = if ($obj.button) { [string]$obj.button } else { 'left' }
      $count = if ($obj.count) { [int]$obj.count } else { 1 }
      Click-At ([double]$obj.pointX) ([double]$obj.pointY) $button.ToLowerInvariant() $count
      Write-Ok
      break
    }
    'drag' {
      Drag-To ([double]$obj.fromX) ([double]$obj.fromY) ([double]$obj.toX) ([double]$obj.toY)
      Write-Ok
      break
    }
    'type' {
      Type-Text ([string]$obj.text)
      Write-Ok
      break
    }
    'key' {
      if (Parse-And-PostKey ([string]$obj.key)) { Write-Ok }
      else { Write-Err ("unrecognized key: " + $obj.key) }
      break
    }
    'scroll' {
      Scroll-At ([double]$obj.pointX) ([double]$obj.pointY) ([string]$obj.direction).ToLowerInvariant() ([int]$obj.amount)
      Write-Ok
      break
    }
    default { Write-Err ("unknown cmd: " + $cmd) }
  }
}

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  try {
    $obj = $line | ConvertFrom-Json
    Handle-Command $obj
  } catch {
    [Console]::Error.WriteLine("computer-helper: $($_.Exception.Message)")
    Write-Err $_.Exception.Message
  }
  [System.Windows.Forms.Application]::DoEvents()
}

End-Session
if ($script:OverlayForm -ne $null) {
  $script:OverlayForm.Close()
  $script:OverlayForm.Dispose()
}
