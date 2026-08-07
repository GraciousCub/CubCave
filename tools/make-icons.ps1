<#
    Generates the PWA icon set from tools/icon-source.png.

        powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

    The source is a white glyph on opaque black. Drawing that directly would
    paste a black square over the app's background colour, so its luminance is
    converted into an alpha mask: the glyph becomes white-with-alpha and the
    background shows through cleanly at the edges.

    The mask is then cropped to the glyph's bounding box before scaling, so
    padding is measured against the artwork rather than the source canvas —
    otherwise a wide, short logo ends up looking tiny inside its square.

    Re-run after replacing tools/icon-source.png.
#>

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$source    = Join-Path $PSScriptRoot 'icon-source.png'
$outputDir = Join-Path $root 'icons'

if (-not (Test-Path $source)) { throw "Missing source image: $source" }
if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory $outputDir | Out-Null }

Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class CubCaveIcons
{
    // White glyph + alpha taken from luminance, plus the glyph's bounding box.
    public static Bitmap BuildMask(string path, out Rectangle bounds)
    {
        using (Bitmap src = new Bitmap(path))
        {
            int w = src.Width, h = src.Height;
            Rectangle rect = new Rectangle(0, 0, w, h);

            BitmapData sd = src.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            int stride = sd.Stride;
            byte[] buf = new byte[stride * h];
            Marshal.Copy(sd.Scan0, buf, 0, buf.Length);
            src.UnlockBits(sd);

            int minX = w, minY = h, maxX = -1, maxY = -1;

            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                for (int x = 0; x < w; x++)
                {
                    int i = row + x * 4;              // BGRA in memory
                    int b = buf[i], g = buf[i + 1], r = buf[i + 2], a = buf[i + 3];
                    int lum = (int)(0.299 * r + 0.587 * g + 0.114 * b);
                    int alpha = lum * a / 255;

                    buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255;
                    buf[i + 3] = (byte)alpha;

                    if (alpha > 8)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            bounds = (maxX < 0)
                ? new Rectangle(0, 0, w, h)
                : new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);

            Bitmap mask = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            BitmapData md = mask.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(buf, 0, md.Scan0, buf.Length);
            mask.UnlockBits(md);
            return mask;
        }
    }

    // widthFraction / heightFraction: how much of the square the glyph may fill.
    public static void Render(Bitmap mask, Rectangle bounds, string outPath,
                              int size, double widthFraction, double heightFraction,
                              int bgR, int bgG, int bgB)
    {
        using (Bitmap canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(canvas))
        {
            g.Clear(Color.FromArgb(255, bgR, bgG, bgB));
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;

            double scale = Math.Min(size * widthFraction / bounds.Width,
                                    size * heightFraction / bounds.Height);
            int dw = (int)Math.Round(bounds.Width * scale);
            int dh = (int)Math.Round(bounds.Height * scale);

            g.DrawImage(mask, new Rectangle((size - dw) / 2, (size - dh) / 2, dw, dh),
                        bounds, GraphicsUnit.Pixel);

            canvas.Save(outPath, ImageFormat.Png);
        }
    }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

# App background, matching --bg in css/styles.css
$bg = @(15, 18, 24)

$bounds = New-Object System.Drawing.Rectangle
$mask = [CubCaveIcons]::BuildMask($source, [ref]$bounds)
Write-Host ("glyph bounds: {0}x{1} at ({2},{3})" -f $bounds.Width, $bounds.Height, $bounds.X, $bounds.Y)

# name, size, width fraction, height fraction
#   maskable needs a wide margin: launchers crop it to a circle.
#   favicon runs larger, or the glyph disappears at 32px.
$targets = @(
    @('icon-192.png',            192, 0.78, 0.62),
    @('icon-512.png',            512, 0.78, 0.62),
    @('icon-maskable-512.png',   512, 0.58, 0.46),
    @('apple-touch-icon-180.png',180, 0.76, 0.60),
    @('favicon-32.png',           32, 0.88, 0.72)
)

foreach ($t in $targets) {
    $path = Join-Path $outputDir $t[0]
    [CubCaveIcons]::Render($mask, $bounds, $path, $t[1], $t[2], $t[3], $bg[0], $bg[1], $bg[2])
    Write-Host ("wrote icons/{0}  ({1}x{1})" -f $t[0], $t[1])
}

$mask.Dispose()
Write-Host "`nDone. Bump CACHE_VERSION in sw.js so the new icons are picked up."
