using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Field.Native;

/// <summary>Structural validation at the native persistence boundary. The UI applies its canonical model too.</summary>
internal static class LibrarySnapshot
{
    public const int MaximumBytes = 64 * 1024 * 1024;
    private const long MaximumSafeInteger = 9007199254740991;
    private static readonly Regex Identifier = new("^[A-Za-z0-9][A-Za-z0-9_-]*$", RegexOptions.CultureInvariant);
    private static readonly Regex HexColor = new("^#[A-Fa-f0-9]{6}$", RegexOptions.CultureInvariant);

    public static JsonElement Empty() => JsonSerializer.SerializeToElement(new
    {
        version = 1,
        fields = Array.Empty<object>(), items = Array.Empty<object>(),
        memberships = Array.Empty<object>(), connections = Array.Empty<object>()
    });

    public static bool IsEmpty(JsonElement snapshot) =>
        new[] { "fields", "items", "memberships", "connections" }.All(name => snapshot.GetProperty(name).GetArrayLength() == 0);

    public static void Validate(JsonElement snapshot)
    {
        if (snapshot.ValueKind != JsonValueKind.Object || !snapshot.TryGetProperty("version", out var version) ||
            !version.TryGetInt32(out var schema) || schema != 1)
            throw new InvalidDataException("Unsupported FIELD library format.");
        foreach (var name in new[] { "fields", "items", "memberships", "connections" })
            if (!snapshot.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException($"Library {name} must be an array.");
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var field in snapshot.GetProperty("fields").EnumerateArray())
        {
            Object(field, "Field");
            var id = Id(field, "id");
            Text(field, "name");
            if (!HexColor.IsMatch(Text(field, "color"))) throw new InvalidDataException("Invalid field color.");
            string? parent = null;
            if (field.TryGetProperty("parent", out var parentValue) && parentValue.ValueKind != JsonValueKind.Null)
                parent = IdValue(parentValue);
            if (!parents.TryAdd(id, parent)) throw new InvalidDataException("Duplicate field ID.");
        }
        // A tri-color walk validates arbitrary ordering without recursion on deep hierarchies.
        var complete = new HashSet<string>(StringComparer.Ordinal);
        foreach (var start in parents.Keys)
        {
            var visiting = new HashSet<string>(StringComparer.Ordinal);
            for (string? id = start; id is not null && !complete.Contains(id);)
            {
                if (!parents.TryGetValue(id, out var parent)) throw new InvalidDataException("A parent field is missing.");
                if (!visiting.Add(id)) throw new InvalidDataException("Field hierarchy contains a cycle.");
                id = parent;
            }
            complete.UnionWith(visiting);
        }

        var itemIds = new HashSet<string>(StringComparer.Ordinal);
        var identities = new HashSet<string>(StringComparer.Ordinal);
        var nativeIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in snapshot.GetProperty("items").EnumerateArray())
        {
            Object(item, "Item");
            var id = Id(item, "id");
            if (!itemIds.Add(id)) throw new InvalidDataException("Duplicate item ID.");
            if (item.TryGetProperty("fields", out _)) throw new InvalidDataException("Items must use separate membership records.");
            Text(item, "title");
            var kind = Text(item, "kind");
            switch (kind)
            {
                case "link":
                    var url = Text(item, "url");
                    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
                        throw new InvalidDataException("Invalid library URL.");
                    // Browser URL normalization is authoritative; do not collapse escaped paths
                    // or meaningful query/fragment differences accepted by the canonical model.
                    if (!identities.Add("link:" + url)) throw new InvalidDataException("Duplicate canonical URL.");
                    break;
                case "note": Text(item, "body"); break;
                case "drawing":
                    var drawing = Text(item, "drawing");
                    if (!drawing.StartsWith("data:image/png;base64,", StringComparison.OrdinalIgnoreCase) ||
                        drawing.Length <= 22 || !drawing[22..].All(c => char.IsAsciiLetterOrDigit(c) || c is '+' or '/' or '='))
                        throw new InvalidDataException("Drawing must contain a PNG data URL.");
                    break;
                case "file":
                    var path = item.TryGetProperty("path", out var value) ? String(value, "File path") : "";
                    if (path.Length > 0) WindowsPath(path);
                    Text(item, "fileName");
                    if (item.TryGetProperty("size", out var size) && (!size.TryGetInt64(out var number) || number < 0 || number > MaximumSafeInteger))
                        throw new InvalidDataException("Invalid file size.");
                    if (item.TryGetProperty("native", out var native) && native.ValueKind != JsonValueKind.Null)
                    {
                        var reference = DeserializeReference(native);
                        if (!nativeIds.Add(reference.ReferenceId)) throw new InvalidDataException("Duplicate native reference ID.");
                        if (!string.Equals(WindowsPath(path), WindowsPath(reference.Path), StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("The file path and native reference do not match.");
                        if (!identities.Add(FileReferenceService.TargetKey(reference))) throw new InvalidDataException("Duplicate canonical file identity.");
                    }
                    else if (path.Length > 0 && !identities.Add("path:" + WindowsPath(path).ToLowerInvariant()))
                        throw new InvalidDataException("Duplicate canonical file path.");
                    break;
                default: throw new InvalidDataException("Unsupported item kind.");
            }
            if (kind != "file" && item.TryGetProperty("native", out var unexpected) && unexpected.ValueKind != JsonValueKind.Null)
                throw new InvalidDataException("Only files can contain native references.");
        }
        var pairs = new HashSet<(string Item, string Field)>();
        foreach (var membership in snapshot.GetProperty("memberships").EnumerateArray())
        {
            Object(membership, "Membership");
            var item = Id(membership, "itemId");
            var field = Id(membership, "fieldId");
            if (!itemIds.Contains(item) || !parents.ContainsKey(field)) throw new InvalidDataException("A membership target is missing.");
            if (!pairs.Add((item, field))) throw new InvalidDataException("Duplicate membership.");
        }
        var connectionIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var connection in snapshot.GetProperty("connections").EnumerateArray())
        {
            Object(connection, "Connection");
            if (!connectionIds.Add(Id(connection, "id"))) throw new InvalidDataException("Duplicate connection ID.");
            var from = Id(connection, "from");
            var to = Id(connection, "to");
            if (from == to || !parents.ContainsKey(from) || !parents.ContainsKey(to)) throw new InvalidDataException("Invalid field connection.");
            Text(connection, "label");
            if (connection.TryGetProperty("kind", out var connectionKind) && String(connectionKind, "Connection kind") != "related")
                throw new InvalidDataException("Unsupported connection kind.");
        }
    }

    internal static NativeReference DeserializeReference(JsonElement value)
    {
        Object(value, "Native file reference");
        if (!value.TryGetProperty("identity", out _) || !value.TryGetProperty("recoverable", out var recoverable) ||
            recoverable.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("Invalid native file reference.");
        NativeReference reference;
        try { reference = value.Deserialize<NativeReference>(DesktopLibraryStore.Json) ?? throw new JsonException(); }
        catch (JsonException error) { throw new InvalidDataException("Invalid native file reference.", error); }
        FileReferenceService.ValidateReference(reference);
        return reference;
    }

    internal static string WindowsPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0')) throw new InvalidDataException("Invalid Windows file path.");
        var normalized = path.Replace('/', '\\');
        if (normalized.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) normalized = @"\\" + normalized[8..];
        else if (normalized.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) && normalized.Length > 6 && normalized[5] == ':') normalized = normalized[4..];
        if (normalized.StartsWith(@"\\.\", StringComparison.Ordinal) || normalized.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            !Path.IsPathFullyQualified(normalized)) throw new InvalidDataException("Invalid Windows file path.");
        return Path.GetFullPath(normalized);
    }

    private static void Object(JsonElement element, string label)
    {
        if (element.ValueKind != JsonValueKind.Object) throw new InvalidDataException($"{label} must be an object.");
        var properties = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
            if (!properties.Add(property.Name) || property.Name is "__proto__" or "constructor" or "prototype")
                throw new InvalidDataException("Invalid or duplicate record property.");
    }
    private static string Id(JsonElement element, string key) => IdValue(Required(element, key));
    private static string IdValue(JsonElement element)
    {
        var value = String(element, "ID");
        if (!Identifier.IsMatch(value)) throw new InvalidDataException("Invalid library ID.");
        return value;
    }
    private static string Text(JsonElement element, string key)
    {
        var value = String(Required(element, key), key);
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException($"{key} is required.");
        return value;
    }
    private static JsonElement Required(JsonElement element, string key) => element.TryGetProperty(key, out var value) ? value :
        throw new InvalidDataException($"{key} is required.");
    private static string String(JsonElement element, string label) => element.ValueKind == JsonValueKind.String ? element.GetString()! :
        throw new InvalidDataException($"{label} must be text.");
}
