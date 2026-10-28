[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\desktop\Field.Desktop\field.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$absoluteOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($absoluteOutput)) | Out-Null
$source = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\assets\app-icon.png'))
$sizes = @(16, 32, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $green = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#80d754'))
    $memory = [System.IO.MemoryStream]::new()
    try {
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, $size, $size)
        $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames.Add($memory.ToArray())
    }
    finally {
        $memory.Dispose()
        $green.Dispose()
        $white.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$stream = [System.IO.File]::Create($absoluteOutput)
$writer = [System.IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = [uint32](6 + 16 * $sizes.Count)
    for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { [byte]0 } else { [byte]$sizes[$index] }
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$index].Length)
        $writer.Write($offset)
        $offset += [uint32]$frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
}
finally {
    $writer.Dispose()
    $stream.Dispose()
}
Write-Output $absoluteOutput

$source.Dispose()
