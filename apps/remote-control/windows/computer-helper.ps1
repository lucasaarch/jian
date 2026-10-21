# Jian Remote Control — Windows computer-use helper
# JSON lines on stdin → JSON lines on stdout (same cmds as macOS/Linux helpers).
# Overlay: topmost transparent WinForms pointer (geometric white + blue glow).
# Input: SendInput with save/restore so agent clicks do not strand the user cursor.
# English-only errors.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:PointerSize = 36
$script:HotspotX = 2
$script:HotspotY = 2
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
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Size = New-Object System.Drawing.Size($script:PointerSize, $script:PointerSize)
  $form.BackColor = [System.Drawing.Color]::Magenta
  $form.TransparencyKey = [System.Drawing.Color]::Magenta
  $form.Opacity = 0.94
  $form.Enabled = $false
  $form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $pts = @(
      (New-Object System.Drawing.Point(2, 2)),
      (New-Object System.Drawing.Point(2, 26)),
      (New-Object System.Drawing.Point(10, 20)),
      (New-Object System.Drawing.Point(15, 32)),
      (New-Object System.Drawing.Point(20, 30)),
      (New-Object System.Drawing.Point(13, 17)),
      (New-Object System.Drawing.Point(22, 17))
    )
    $glowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 58, 122, 214))
    $glowPts = @(
      (New-Object System.Drawing.Point(3, 4)),
      (New-Object System.Drawing.Point(3, 28)),
      (New-Object System.Drawing.Point(11, 22)),
      (New-Object System.Drawing.Point(16, 34)),
      (New-Object System.Drawing.Point(21, 32)),
      (New-Object System.Drawing.Point(14, 19)),
      (New-Object System.Drawing.Point(23, 19))
    )
    $g.FillPolygon($glowBrush, $glowPts)
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 250, 250, 248))
    $g.FillPolygon($fill, $pts)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 23, 23, 22), 1.1)
    $g.DrawPolygon($pen, $pts)
    $glowBrush.Dispose(); $fill.Dispose(); $pen.Dispose()
  })
  $script:OverlayForm = $form
}

function Position-Overlay {
  if ($script:OverlayForm -eq $null) { return }
  $x = [int]($script:TipX - $script:HotspotX)
  $y = [int]($script:TipY - $script:HotspotY)
  $script:OverlayForm.Location = New-Object System.Drawing.Point($x, $y)
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
  $script:OverlayForm.Opacity = 0.94
  $script:OverlayForm.Invalidate()
  $script:SessionActive = $true
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Idle {
  Ensure-Session
  $script:OverlayForm.Opacity = 0.18
  [System.Windows.Forms.Application]::DoEvents()
}

function End-Session {
  if ($script:OverlayForm -ne $null) {
    $script:OverlayForm.Hide()
    $script:OverlayForm.Opacity = 0
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
  $script:OverlayForm.Invalidate()
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
