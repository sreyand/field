using Field.Native;
using System.IO;
using System.Windows.Media.Imaging;

namespace Field.Desktop;

internal static class ImagePreview
{
    private static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".ico" };

    public static object Create(NativeReference reference)
    {
        if (reference.Status != "available" || !Extensions.Contains(Path.GetExtension(reference.Path)))
            return new { available = false };
        try
        {
            using var stream = new FileStream(reference.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length > 64 * 1024 * 1024) return new { available = false };
            var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.DelayCreation, BitmapCacheOption.OnDemand);
            var frame = decoder.Frames[0];
            var width = frame.PixelWidth;
            var height = frame.PixelHeight;
            if (width < 1 || height < 1 || (long)width * height > 100_000_000) return new { available = false };
            stream.Position = 0;
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            if (width >= height && width > 1200) image.DecodePixelWidth = 1200;
            else if (height > 1200) image.DecodePixelHeight = 1200;
            image.EndInit();
            image.Freeze();
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using var output = new MemoryStream();
            encoder.Save(output);
            return new { available = true, width, height, dataUrl = "data:image/png;base64," + Convert.ToBase64String(output.ToArray()) };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException or FileFormatException or ArgumentException or System.Runtime.InteropServices.COMException)
        {
            return new { available = false };
        }
    }
}
