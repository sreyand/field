using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Field.Native;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace Field.Desktop;

internal sealed partial class FieldWindow : Window
{
    private const string ApplicationUri = "https://field.local/index.html";
    private const string SecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> Methods = new(StringComparer.Ordinal)
    {
        "app.info", "app.theme", "files.track", "files.resolve", "files.pick", "files.open", "files.preview", "library.load", "library.save", "library.import", "library.pickImport", "folders.pick", "folders.attach", "folders.sync", "folders.detach", "library.search", "library.backups", "library.restore"
    };
    private static readonly HashSet<string> Assets = new(StringComparer.Ordinal)
    {
        "/index.html", "/styles.css", "/appearance.js", "/drawing.js", "/library-model.js", "/library-storage.js", "/library-ui.js",
        "/desktop-client.js", "/library-transfer.js", "/context-menu.js", "/map-geometry.js", "/image-previews.js", "/assets/app-icon.png", "/native-client.js", "/app.js", "/assets/field-logo.png",
        "/assets/fonts/dm-sans-latin-variable.woff2", "/assets/fonts/OFL.txt"
    };
    private readonly DesktopOptions options;
    private readonly DesktopBackend backend;
    private readonly WebView2 web = new();
    private readonly Grid layout = new();
    private readonly TextBlock loading = new() { Text = "Opening FIELD…", FontSize = 14, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly HashSet<string> outstanding = new(StringComparer.Ordinal);
    private bool closing;
    private bool closeAllowed;
    private long documentVersion;

    public FieldWindow(DesktopOptions options, DesktopBackend backend)
    {
        this.options = options;
        this.backend = backend;
        Title = "FIELD";
        Width = 1280;
        Height = 820;
        MinWidth = 640;
        MinHeight = 480;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(16, 18, 21));
        Foreground = Brushes.White;
        Icon = new BitmapImage(new Uri("pack://application:,,,/field.ico"));
        web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 16, 18, 21);
        web.Visibility = Visibility.Hidden;
        layout.Children.Add(web);
        layout.Children.Add(loading);
        Content = layout;
        Loaded += Initialize;
        Closing += WindowClosing;
    }

    public void BringToFront()
    {
        if (closing) return;
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Show();
        Activate();
    }

    private async void Initialize(object sender, RoutedEventArgs e)
    {
        Loaded -= Initialize;
        if (closing) return;
        try
        {
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(options.DataDirectory, "WebView2"));
            if (closing) return;
            await web.EnsureCoreWebView2Async(environment);
            if (closing) return;
            var core = web.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("field.local", options.AssetsDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ResourceRequested;
            core.NavigationStarting += NavigationStarting;
            core.FrameNavigationStarting += (_, args) => args.Cancel = true;
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (args.IsUserInitiated) OpenExternal(args.Uri);
            };
            core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += MessageReceived;
            core.DownloadStarting += DownloadStarting;
            core.NavigationCompleted += (_, args) =>
            {
                if (closing) return;
                if (!args.IsSuccess)
                {
                    loading.Text = "FIELD could not load its interface. Close and reopen the app.";
                    loading.Visibility = Visibility.Visible;
                    return;
                }
                loading.Visibility = Visibility.Collapsed;
                web.Visibility = Visibility.Visible;
            };
            core.ProcessFailed += (_, args) =>
            {
                if (closing) return;
                loading.Text = "FIELD's interface stopped. Close and reopen the app.";
                loading.Visibility = Visibility.Visible;
            };
            core.Navigate(ApplicationUri);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (closing) return;
            MessageBox.Show(this, "Microsoft Edge WebView2 Runtime is required. Install the Evergreen Runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\nThen reopen FIELD.", "FIELD", MessageBoxButton.OK, MessageBoxImage.Information);
            Close();
        }
        catch (Exception error)
        {
            if (closing) return;
            MessageBox.Show(this, error.Message, "FIELD could not open", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private void NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsDocument(e.Uri)) { documentVersion++; return; }
        e.Cancel = true;
        if (e.IsUserInitiated) OpenExternal(e.Uri);
    }

    private void ResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (closing) return;
        var core = web.CoreWebView2;
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri) || !IsOrigin(uri) || e.Request.Method != "GET")
        {
            // Data/blob resources are produced inside the trusted page and do not use disk mapping.
            if (uri?.Scheme is "data" or "blob") return;
            e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "Content-Type: text/plain\r\n");
            return;
        }
        var relative = uri.AbsolutePath == "/" ? "/index.html" : uri.AbsolutePath;
        if (!Assets.Contains(relative))
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain\r\n");
            return;
        }
        var file = Path.Combine(options.AssetsDirectory, relative.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
        try
        {
            var bytes = File.ReadAllBytes(file);
            var type = Path.GetExtension(file) switch
            {
                ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
                ".png" => "image/png", ".woff2" => "font/woff2", _ => "text/plain; charset=utf-8"
            };
            e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(bytes, writable: false), 200, "OK",
                $"Content-Type: {type}\r\nContent-Security-Policy: {SecurityPolicy}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain\r\n");
        }
    }

    private async void MessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (closing || !IsDocument(e.Source) || !IsDocument(web.CoreWebView2.Source)) return;
        string? id = null;
        var registered = false;
        var version = documentVersion;
        try
        {
            var source = e.WebMessageAsJson;
            if (source.Length > 90 * 1024 * 1024) throw new ArgumentException("This library is too large for this alpha.");
            using var request = JsonDocument.Parse(source, new JsonDocumentOptions { MaxDepth = 128 });
            var message = request.RootElement;
            if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.String)
                return;
            id = idValue.GetString();
            if (id is null || !RequestId().IsMatch(id) || !outstanding.Add(id)) return;
            registered = true;
            if (!message.TryGetProperty("method", out var methodValue) || methodValue.ValueKind != JsonValueKind.String ||
                methodValue.GetString() is not { } method || !Methods.Contains(method))
                throw new ArgumentException("Unknown FIELD operation.");
            var parameters = message.TryGetProperty("params", out var value) ? value.Clone() : JsonSerializer.SerializeToElement(new { });
            if (parameters.ValueKind != JsonValueKind.Object) throw new ArgumentException("Invalid operation parameters.");
            if (method == "app.theme")
            {
                if (!parameters.TryGetProperty("theme", out var preference) || preference.ValueKind != JsonValueKind.String || preference.GetString() is not ("dark" or "light"))
                    throw new ArgumentException("Invalid theme.");
                ApplyTheme(preference.GetString() == "dark");
                Reply(version, new { id, ok = true, result = new { } });
                return;
            }
            if (method == "folders.pick")
            {
                var dialog = new OpenFolderDialog { Title = "Link a folder to FIELD", Multiselect = false };
                var selected = dialog.ShowDialog(this) == true ? dialog.FolderName : null;
                Reply(version, new { id, ok = true, result = selected is null ? (object)new { cancelled = true } : new { path = selected } });
                return;
            }
            if (outstanding.Count > 32) throw new InvalidOperationException("FIELD is busy. Try again in a moment.");
            await operations.WaitAsync();
            try
            {
                if (closing) return;
                var owner = new WindowInteropHelper(this).Handle;
                var result = await Task.Run(async () => {
                    if (method != "files.preview") return await backend.HandleAsync(method, parameters, owner);
                    if (!parameters.TryGetProperty("referenceId", out var refId) || refId.ValueKind != JsonValueKind.String || !Guid.TryParseExact(refId.GetString(), "N", out _))
                        throw new ArgumentException("Unknown file reference.");
                    var resolved = await backend.HandleAsync("files.resolve", JsonSerializer.SerializeToElement(new { referenceIds = new[] { refId.GetString() } }));
                    var reference = JsonSerializer.SerializeToElement(resolved, Json).GetProperty("references")[0].Deserialize<NativeReference>(Json)!;
                    return ImagePreview.Create(reference);
                });
                Reply(version, new { id, ok = true, result });
            }
            finally { operations.Release(); }
        }
        catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or KeyNotFoundException or Microsoft.Data.Sqlite.SqliteException)
        {
            if (id is not null) Reply(version, new { id, ok = false, error = new { message = error.Message, code = "REQUEST_FAILED" } });
        }
        finally { if (registered) outstanding.Remove(id!); }
    }

    private void Reply(long version, object response)
    {
        if (closing || version != documentVersion || !IsDocument(web.CoreWebView2.Source)) return;
        try { web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, Json)); }
        catch (COMException) { /* ProcessFailed already provides the recovery UI. */ }
    }

    private void DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var deferral = e.GetDeferral();
        e.Handled = true;
        try
        {
            if (closing || !IsDocument(web.CoreWebView2.Source)) { e.Cancel = true; return; }
            var name = Path.GetFileName(e.ResultFilePath);
            var extension = Path.GetExtension(name).ToLowerInvariant();
            if (extension is not (".json" or ".png")) { e.Cancel = true; return; }
            var dialog = new SaveFileDialog
            {
                Title = "Save from FIELD", FileName = name, DefaultExt = extension,
                Filter = extension == ".json" ? "FIELD library (*.json)|*.json" : "PNG image (*.png)|*.png",
                AddExtension = true, OverwritePrompt = true, CheckPathExists = true
            };
            if (dialog.ShowDialog(this) != true) { e.Cancel = true; return; }
            e.ResultFilePath = dialog.FileName;
        }
        catch (Exception error) when (error is ArgumentException or IOException or UnauthorizedAccessException)
        {
            e.Cancel = true;
            MessageBox.Show(this, error.Message, "FIELD could not save the file", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally { deferral.Complete(); }
    }

    private void WindowClosing(object? sender, CancelEventArgs e)
    {
        if (closeAllowed) return;
        e.Cancel = true;
        if (closing) return;
        closing = true;
        IsEnabled = false;
        // WPF must finish cancelling this Closing event before Close can be called again.
        // WaitAsync can complete synchronously when no native operation is running.
        Dispatcher.BeginInvoke(new Action(CompleteClose));
    }

    private async void CompleteClose()
    {
        // Complete an in-flight atomic save before releasing file locks and disposing the WebView.
        await operations.WaitAsync();
        try { web.Dispose(); }
        finally
        {
            operations.Release();
            closeAllowed = true;
            Close();
        }
    }

    private void ApplyTheme(bool dark)
    {
        Background = new SolidColorBrush(dark ? Color.FromRgb(16, 18, 21) : Color.FromRgb(252, 252, 250));
        var enabled = dark ? 1 : 0;
        _ = DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref enabled, sizeof(int));
    }

    private static bool IsOrigin(Uri uri) => uri.Scheme == "https" && uri.Host.Equals("field.local", StringComparison.OrdinalIgnoreCase) &&
        uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo);
    private static bool IsDocument(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri) && IsOrigin(uri) &&
        uri.AbsolutePath is "/" or "/index.html" && string.IsNullOrEmpty(uri.Query);
    private static void OpenExternal(string target)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,96}$", RegexOptions.CultureInvariant)]
    private static partial Regex RequestId();
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, uint attribute, ref int value, int size);
}
