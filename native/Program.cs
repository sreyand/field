using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Field.Native;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("FIELD's file runtime requires Windows.");
var options = HostOptions.Parse(args);
var origin = $"http://127.0.0.1:{options.Port}";
if (options.Open && await ExistingHost.TryOpen(origin, options.Root)) return;

var builder = WebApplication.CreateSlimBuilder();
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(server =>
{
    server.Listen(IPAddress.Loopback, options.Port);
    server.Limits.MaxRequestBodySize = 131072;
    server.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
});
builder.Services.ConfigureHttpJsonOptions(json => json.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();
using var files = new FileReferenceService(options.DataDirectory);
var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
var expectedHost = $"127.0.0.1:{options.Port}";
var staticFiles = new HashSet<string>(StringComparer.Ordinal)
{
    "/index.html", "/styles.css", "/appearance.js", "/drawing.js", "/library-model.js",
    "/library-storage.js", "/native-client.js", "/desktop-client.js", "/library-transfer.js", "/context-menu.js", "/map-geometry.js", "/app.js", "/assets/field-logo.png",
    "/assets/fonts/dm-sans-latin-variable.woff2", "/assets/fonts/OFL.txt"
};

app.Use(async (context, next) =>
{
    var response = context.Response;
    response.Headers["X-Content-Type-Options"] = "nosniff";
    response.Headers["Referrer-Policy"] = "no-referrer";
    response.Headers["Cache-Control"] = "no-store";
    response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    if (!string.Equals(context.Request.Host.Value, expectedHost, StringComparison.Ordinal))
    {
        response.StatusCode = 403;
        return;
    }
    var requestOrigin = context.Request.Headers.Origin.ToString();
    var nullOrigin = requestOrigin == "null";
    if (requestOrigin.Length != 0 && requestOrigin != origin && !nullOrigin)
    {
        response.StatusCode = 403;
        return;
    }
    var authorized = SecureEquals(context.Request.Headers["X-Field-Token"].ToString(), token);
    if (HttpMethods.IsOptions(context.Request.Method))
    {
        if (!context.Request.Path.StartsWithSegments("/api") || !nullOrigin ||
            context.Request.Headers["Access-Control-Request-Method"] != "POST" && context.Request.Headers["Access-Control-Request-Method"] != "GET")
        {
            response.StatusCode = 403;
            return;
        }
        var requested = context.Request.Headers["Access-Control-Request-Headers"].ToString().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (requested.Any(header => !header.Equals("x-field-token", StringComparison.OrdinalIgnoreCase) && !header.Equals("content-type", StringComparison.OrdinalIgnoreCase)))
        {
            response.StatusCode = 403;
            return;
        }
        response.Headers["Access-Control-Allow-Origin"] = "null";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Field-Token";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST";
        response.Headers["Vary"] = "Origin";
        response.StatusCode = 204;
        return;
    }
    if (!nullOrigin && context.Request.Headers["Sec-Fetch-Site"] == "cross-site" && !authorized)
    {
        response.StatusCode = 403;
        return;
    }
    if (nullOrigin && authorized)
    {
        response.Headers["Access-Control-Allow-Origin"] = "null";
        response.Headers["Vary"] = "Origin";
    }
    if ((nullOrigin || context.Request.Path.StartsWithSegments("/api") &&
        context.Request.Path != "/api/health" && context.Request.Path != "/api/session") && !authorized)
    {
        response.StatusCode = 401;
        await response.WriteAsJsonAsync(new { error = "Runtime session expired. Reopen FIELD.cmd." });
        return;
    }
    try { await next(context); }
    catch (BadHttpRequestException error)
    {
        if (response.HasStarted) throw;
        response.StatusCode = error.StatusCode;
        await response.WriteAsJsonAsync(new { error = "Invalid request." });
    }
    catch (Exception error) when (error is ArgumentException or KeyNotFoundException or InvalidOperationException or System.ComponentModel.Win32Exception)
    {
        if (response.HasStarted) throw;
        response.StatusCode = error is KeyNotFoundException ? 404 : 400;
        await response.WriteAsJsonAsync(new { error = error.Message });
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException)
    {
        if (response.HasStarted) throw;
        response.StatusCode = 500;
        await response.WriteAsJsonAsync(new { error = "FIELD could not save its file references. Check the local data directory and try again." });
    }
});

app.MapGet("/api/health", () => new { app = "FIELD", version = 2 });
app.MapGet("/api/session", () => new { app = "FIELD", available = true, platform = "windows", version = 2, token });
app.MapPost("/api/files/track", (TrackRequest request) => new { reference = files.Track(request.Path ?? "") });
app.MapPost("/api/files/resolve", (ResolveRequest request) =>
{
    if (request.ReferenceIds is null || request.ReferenceIds.Length > 500 ||
        request.ReferenceIds.Any(id => !Guid.TryParseExact(id, "N", out _)))
        throw new ArgumentException("Choose up to 500 valid file references.");
    return new { references = files.Resolve(request.ReferenceIds) };
});
app.MapPost("/api/files/pick", async () =>
{
    var selected = await NativeFilePicker.Pick();
    return selected is null ? Results.Json(new { cancelled = true }) : Results.Json(new { reference = files.Track(selected) });
});
app.MapPost("/api/files/open", (OpenRequest request) =>
{
    files.Open(request.ReferenceId ?? "");
    return new { opened = true };
});
app.MapGet("/{**path}", async (HttpContext context) =>
{
    var path = context.Request.Path.Value == "/" ? "/index.html" : context.Request.Path.Value!;
    if (!staticFiles.Contains(path)) { context.Response.StatusCode = 404; return; }
    var fullPath = Path.Combine(options.Root, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
    if (!File.Exists(fullPath)) { context.Response.StatusCode = 404; return; }
    context.Response.ContentType = Path.GetExtension(path) switch
    {
        ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8", ".png" => "image/png", ".woff2" => "font/woff2",
        _ => "text/plain; charset=utf-8"
    };
    await context.Response.SendFileAsync(fullPath);
});

try
{
    await app.StartAsync();
    Console.WriteLine($"FIELD runtime: {origin}");
    if (options.Open) ExistingHost.Open(options.Root, options.Port, token);
    await app.WaitForShutdownAsync();
}
catch (IOException error)
{
    Console.Error.WriteLine($"FIELD could not start on port {options.Port}: {error.Message}");
    Environment.ExitCode = 1;
}

static bool SecureEquals(string value, string expected)
{
    var bytes = Encoding.UTF8.GetBytes(value);
    return bytes.Length == expected.Length && CryptographicOperations.FixedTimeEquals(bytes, Encoding.UTF8.GetBytes(expected));
}

internal sealed record TrackRequest(string? Path);
internal sealed record ResolveRequest(string[]? ReferenceIds);
internal sealed record OpenRequest(string? ReferenceId);

internal sealed record HostOptions(int Port, string Root, string DataDirectory, bool Open)
{
    public static HostOptions Parse(string[] args)
    {
        var port = 4321;
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FIELD");
        var open = false;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--port":
                    if (++index >= args.Length || !int.TryParse(args[index], out port) || port < 1024 || port > 65535)
                        throw new ArgumentException("Choose a port between 1024 and 65535.");
                    break;
                case "--root":
                    if (++index >= args.Length) throw new ArgumentException("--root requires the FIELD directory.");
                    root = Path.GetFullPath(args[index]);
                    break;
                case "--data-dir":
                    if (++index >= args.Length) throw new ArgumentException("--data-dir requires a directory.");
                    data = Path.GetFullPath(args[index]);
                    break;
                case "--open": open = true; break;
                default: throw new ArgumentException($"Unknown option: {args[index]}");
            }
        }
        if (!File.Exists(Path.Combine(root, "index.html"))) throw new ArgumentException("The FIELD interface was not found. Use --root with its directory.");
        return new HostOptions(port, root, data, open);
    }
}

internal static class ExistingHost
{
    public static async Task<bool> TryOpen(string origin, string root)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        try
        {
            var health = await client.GetFromJsonAsync<JsonElement>(origin + "/api/health");
            if (!health.TryGetProperty("app", out var app) || app.GetString() != "FIELD" ||
                !health.TryGetProperty("version", out var version) || version.GetInt32() != 2) return false;
            var session = await client.GetFromJsonAsync<JsonElement>(origin + "/api/session");
            var token = session.GetProperty("token").GetString();
            if (token is null || token.Length != 64) return false;
            Open(root, new Uri(origin).Port, token);
            return true;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
        catch (JsonException) { return false; }
        catch (KeyNotFoundException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    public static void Open(string root, int port, string token)
    {
        var configuration = JsonSerializer.SerializeToUtf8Bytes(new { port, token });
        var fragment = Convert.ToBase64String(configuration).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var uri = new Uri(Path.Combine(root, "index.html")).AbsoluteUri + "#field-runtime=" + fragment;
        Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
    }
}
