# make-icon.ps1 - generate DSH Desktop icons (PNG set + multi-size ICO)
# Usage:  pwsh -ExecutionPolicy Bypass -File scripts/make-icon.ps1
# NOTE: keep this file ASCII-only to avoid encoding issues with Windows PowerShell.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $root "ui\assets"
$buildDir = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

function New-DshPng($size, $outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $radius = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 79, 140, 255),
    [System.Drawing.Color]::FromArgb(255, 124, 92, 255),
    45.0)
  $g.FillPath($brush, $path)

  $dot = [int]($size * 0.30)
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.FillEllipse($dotBrush, [int]($size * 0.28), [int]($size * 0.30), $dot, $dot)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [int]($size * 0.09))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, [int]($size * 0.30), [int]($size * 0.62), [int]($size * 0.70), [int]($size * 0.62))

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("PNG generated: {0} ({1}x{1})" -f $outPath, $size)
}

$sizes = @(16, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
  $p = Join-Path $buildDir ("icon-{0}.png" -f $s)
  New-DshPng $s $p
  $pngs += $p
}

Copy-Item (Join-Path $buildDir "icon-256.png") (Join-Path $assetDir "icon.png") -Force
Copy-Item (Join-Path $buildDir "icon-32.png") (Join-Path $assetDir "icon-32.png") -Force

# Build multi-size ICO (Vista+ PNG-compressed entries)
$icoPath = Join-Path $buildDir "icon.ico"
$count = $pngs.Count
$offset = 6 + 16 * $count
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$count)

foreach ($s in $sizes) {
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $buildDir ("icon-{0}.png" -f $s)))
  $w = if ($s -ge 256) { 0 } else { $s }
  $h = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$w)
  $bw.Write([byte]$h)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$bytes.Length)
  $bw.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($s in $sizes) {
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $buildDir ("icon-{0}.png" -f $s)))
  $bw.Write($bytes)
}
$bw.Flush()
$bw.Close()
$fs.Close()
Write-Host ("ICO generated: {0} ({1} sizes)" -f $icoPath, $count)