using System.IO;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace Field.Desktop;

internal sealed class StartupView : Grid
{
    private readonly Image wordmark = new() { Width = 160, Height = 57, Stretch = Stretch.Uniform };
    private readonly Grid spinner = new() { Width = 20, Height = 20, Margin = new Thickness(0, 22, 0, 0), RenderTransform = new RotateTransform(0, 10, 10) };
    private readonly Ellipse track = new() { Width = 16, Height = 16, StrokeThickness = 1.6, Opacity = .14 };
    private readonly System.Windows.Shapes.Path arc = new() { Data = Geometry.Parse("M 10,2 A 8,8 0 1 1 3.072,6"), StrokeThickness = 1.6, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round };
    private readonly TextBlock error = new() { Visibility = Visibility.Collapsed, MaxWidth = 380, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, FontSize = 13, Margin = new Thickness(0, 22, 0, 0) };
    private readonly string logoPath;
    private bool failed;

    public StartupView(string logoPath)
    {
        this.logoPath = logoPath;
        AutomationProperties.SetName(this, "FIELD is loading");
        AutomationProperties.SetName(wordmark, "FIELD");
        AutomationProperties.SetLiveSetting(error, AutomationLiveSetting.Polite);
        spinner.Children.Add(track);
        spinner.Children.Add(arc);
        var content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(wordmark);
        content.Children.Add(spinner);
        content.Children.Add(error);
        Children.Add(content);
        SetTheme(true);
        IsVisibleChanged += (_, _) => UpdateAnimation();
        Unloaded += (_, _) => Stop();
    }

    public void SetTheme(bool dark)
    {
        var ink = dark ? Color.FromRgb(232, 234, 237) : Color.FromRgb(36, 38, 43);
        wordmark.Source = Wordmark(logoPath, ink);
        track.Stroke = arc.Stroke = error.Foreground = new SolidColorBrush(ink);
    }

    // Same full-wordmark viewport as the sidebar. Preserve the original green dot.
    internal static BitmapSource Wordmark(string path, Color ink)
    {
        using var file = File.OpenRead(path);
        var bitmap = BitmapDecoder.Create(file, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames[0];
        var cropped = new CroppedBitmap(bitmap, new Int32Rect(68, 145, 294, 104));
        var converted = new FormatConvertedBitmap(cropped, PixelFormats.Bgra32, null, 0);
        var stride = converted.PixelWidth * 4;
        var pixels = new byte[stride * converted.PixelHeight];
        converted.CopyPixels(pixels, stride, 0);
        for (var i = 0; i < pixels.Length; i += 4)
        {
            if (pixels[i + 1] > pixels[i + 2] + 15 && pixels[i + 1] > pixels[i] + 15) continue;
            pixels[i + 3] = (byte)(255 - Math.Max(pixels[i], Math.Max(pixels[i + 1], pixels[i + 2])));
            pixels[i] = ink.B; pixels[i + 1] = ink.G; pixels[i + 2] = ink.R;
        }
        var source = BitmapSource.Create(converted.PixelWidth, converted.PixelHeight, 96, 96, PixelFormats.Bgra32, null, pixels, stride);
        source.Freeze();
        return source;
    }

    public void ShowError(string message)
    {
        failed = true;
        Stop();
        spinner.Visibility = Visibility.Collapsed;
        error.Text = message;
        error.Visibility = Visibility.Visible;
        AutomationProperties.SetName(this, message);
        Visibility = Visibility.Visible;
    }

    public void Stop() => ((RotateTransform)spinner.RenderTransform).BeginAnimation(RotateTransform.AngleProperty, null);

    private void UpdateAnimation()
    {
        Stop();
        if (!IsVisible || failed || !SystemParameters.ClientAreaAnimation) return;
        ((RotateTransform)spinner.RenderTransform).BeginAnimation(RotateTransform.AngleProperty,
            new DoubleAnimation(0, 360, TimeSpan.FromMilliseconds(550)) { RepeatBehavior = RepeatBehavior.Forever });
    }
}
