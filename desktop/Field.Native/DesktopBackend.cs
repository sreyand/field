using System.Text.Json;
using System.Text.Json.Nodes;

namespace Field.Native;

/// <summary>Narrow native API called only by the desktop host's validated local page.</summary>
public sealed class DesktopBackend : IDisposable
{
    private readonly DesktopLibraryStore library;
    private readonly FileReferenceService files;
    private readonly SemaphoreSlim operations = new(1, 1);
    private bool disposed;

    public DesktopBackend(string dataDirectory)
    {
        library = new(dataDirectory);
        try { files = new(dataDirectory); }
        catch { library.Dispose(); throw; }
    }

    public async Task<object?> HandleAsync(string method, JsonElement args, nint ownerWindow = default)
    {
        await operations.WaitAsync().ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (args.ValueKind != JsonValueKind.Object) throw new ArgumentException("Request parameters must be an object.");
            switch (method)
            {
                case "app.info": return new { app = "FIELD", version = "0.1.2-alpha", platform = "windows", storage = "native" };
                case "files.track": return new { reference = files.Track(Text(args, "path")) };
                case "files.resolve":
                    if (!args.TryGetProperty("referenceIds", out var ids) || ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() > 500)
                        throw new ArgumentException("Choose up to 500 registered file references.");
                    var references = ids.EnumerateArray().Select(id => ValidReferenceId(id.GetString())).ToArray();
                    return new { references = files.Resolve(references) };
                case "files.pick":
                    var selected = await NativeFilePicker.Pick(ownerWindow).ConfigureAwait(false);
                    return selected is null ? new { cancelled = true } : new { reference = files.Track(selected) };
                case "files.open": files.Open(ValidReferenceId(Text(args, "referenceId"))); return new { opened = true };
                case "library.load": return library.Load();
                case "library.pickImport":
                    var importPath = await NativeFilePicker.Pick(ownerWindow, "FIELD libraries (*.json)\0*.json\0\0", "Import FIELD library").ConfigureAwait(false);
                    return importPath is null ? new { cancelled = true } : await SelectedLibraryFile.ReadAsync(importPath).ConfigureAwait(false);
                case "library.save":
                    var saved = library.Save(Snapshot(args), Revision(args));
                    return new { revision = saved.Revision };
                case "library.import": return Import(Snapshot(args), Revision(args));
                default: throw new ArgumentException("Unknown FIELD operation.");
            }
        }
        finally { operations.Release(); }
    }

    private LibraryEnvelope Import(JsonElement snapshot, long expectedRevision)
    {
        library.CheckImport(expectedRevision);
        LibrarySnapshot.Validate(snapshot);
        // Adopt stable IDs before committing the catalogue. A failed catalogue save can leave only
        // harmless extra reference metadata; it never changes the previous library or original files.
        var importedReferences = snapshot.GetProperty("items").EnumerateArray()
            .Where(item => item.TryGetProperty("native", out var native) && native.ValueKind != JsonValueKind.Null)
            .Select(item => LibrarySnapshot.DeserializeReference(item.GetProperty("native"))).ToArray();
        var adopted = files.Adopt(importedReferences);
        var transformed = JsonNode.Parse(snapshot.GetRawText())!.AsObject();
        foreach (var item in transformed["items"]!.AsArray().OfType<JsonObject>())
            if (item["native"] is JsonObject native && native["referenceId"]?.GetValue<string>() is { } id)
                native["referenceId"] = adopted[id];
        return library.Save(JsonSerializer.SerializeToElement(transformed, DesktopLibraryStore.Json), expectedRevision);
    }

    public void Dispose()
    {
        operations.Wait();
        try { if (disposed) return; disposed = true; files.Dispose(); library.Dispose(); }
        finally { operations.Release(); }
    }

    private static JsonElement Snapshot(JsonElement args) => args.TryGetProperty("snapshot", out var snapshot) ? snapshot :
        throw new ArgumentException("A library snapshot is required.");
    private static long Revision(JsonElement args) => args.TryGetProperty("expectedRevision", out var revision) && revision.TryGetInt64(out var value) && value >= 0 ? value :
        throw new ArgumentException("A valid expected revision is required.");
    private static string Text(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString()! :
        throw new ArgumentException($"{key} is required.");
    private static string ValidReferenceId(string? id) => Guid.TryParseExact(id, "N", out _) ? id!.ToLowerInvariant() :
        throw new ArgumentException("Unknown file reference.");
}
