using System.Text.Json;
using System.Text.Json.Nodes;

namespace Field.Native;

internal sealed class FolderSyncService : IDisposable
{
    private const int MaximumFiles = 100_000;
    private readonly DesktopLibraryStore library;
    private readonly FileReferenceService files;
    private readonly string dataDirectory;
    private readonly Dictionary<string, WatchedFolder> watched = new(StringComparer.Ordinal);
    private WatchedFolder[] notificationStates = Array.Empty<WatchedFolder>();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private sealed class WatchedFolder : IDisposable
    {
        public required string Path;
        public FileSystemWatcher? Watcher;
        public int Dirty = 1;
        public DateTime LastScan = DateTime.MinValue;
        public void Dispose() => Watcher?.Dispose();
    }

    public FolderSyncService(DesktopLibraryStore library, FileReferenceService files, string dataDirectory)
    { this.library = library; this.files = files; this.dataDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataDirectory)); }

    public object Attach(string fieldId, string path, long revision)
    {
        var current = Current(revision);
        path = NormalizeFolder(path);
        if (!Directory.Exists(path)) throw new ArgumentException("Choose an available Windows folder.");
        if (Inside(path, dataDirectory)) throw new ArgumentException("FIELD's app data cannot be linked as a source folder.");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Choose the folder's original location instead of a junction or symbolic link.");
        var candidate = JsonNode.Parse(current.Snapshot.GetRawText())!.AsObject();
        var field = candidate["fields"]!.AsArray().OfType<JsonObject>().FirstOrDefault(value => value["id"]!.GetValue<string>() == fieldId)
            ?? throw new ArgumentException("The field no longer exists.");
        field["folder"] = new JsonObject { ["path"] = path, ["excludedItemIds"] = new JsonArray(), ["itemIds"] = new JsonArray() };
        return Synchronize(current, candidate, true);
    }

    public object Detach(string fieldId, long revision)
    {
        var current = Current(revision);
        var candidate = JsonNode.Parse(current.Snapshot.GetRawText())!.AsObject();
        var field = candidate["fields"]!.AsArray().OfType<JsonObject>().FirstOrDefault(value => value["id"]!.GetValue<string>() == fieldId)
            ?? throw new ArgumentException("The field no longer exists.");
        field.Remove("folder");
        var saved = library.Save(JsonSerializer.SerializeToElement(candidate, Json), revision);
        UpdateWatchers(candidate);
        return new { revision = saved.Revision, snapshot = saved.Snapshot, folders = Array.Empty<object>() };
    }

    public object Sync(long revision, bool force)
    {
        var current = Current(revision);
        return Synchronize(current, JsonNode.Parse(current.Snapshot.GetRawText())!.AsObject(), force);
    }

    private LibraryEnvelope Current(long revision)
    {
        var current = library.Load();
        if (current.Revision != revision) throw new InvalidOperationException("The library changed. Reload FIELD before refreshing folders.");
        return current;
    }

    private object Synchronize(LibraryEnvelope current, JsonObject candidate, bool force)
    {
        UpdateWatchers(candidate);
        var items = candidate["items"]!.AsArray();
        var memberships = candidate["memberships"]!.AsArray();
        var byId = items.OfType<JsonObject>().ToDictionary(item => item["id"]!.GetValue<string>(), StringComparer.Ordinal);
        var byIdentity = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        var byReferenceId = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        var legacyPaths = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in byId.Values.Where(item => item["kind"]?.GetValue<string>() == "file"))
        {
            if (item["native"] is JsonObject native)
            {
                byIdentity[FileReferenceService.TargetKey(LibrarySnapshot.DeserializeReference(JsonSerializer.SerializeToElement(native, Json)))] = item;
                byReferenceId[native["referenceId"]!.GetValue<string>()] = item;
            }
            else if (item["path"]?.GetValue<string>() is { Length: > 0 } path) legacyPaths[FilePathKey(path)] = item;
        }
        var pairs = memberships.OfType<JsonObject>().Select(value => (value["itemId"]!.GetValue<string>(), value["fieldId"]!.GetValue<string>())).ToHashSet();
        var statuses = new List<object>();
        foreach (var field in candidate["fields"]!.AsArray().OfType<JsonObject>())
        {
            if (field["folder"] is not JsonObject folder) continue;
            var id = field["id"]!.GetValue<string>();
            var path = NormalizeFolder(folder["path"]?.GetValue<string>() ?? "");
            var state = watched[id];
            if (!force && Volatile.Read(ref state.Dirty) == 0 && DateTime.UtcNow - state.LastScan < TimeSpan.FromSeconds(60))
            {
                statuses.Add(new { fieldId = id, path, status = folder["status"]?.GetValue<string>() ?? "available", message = folder["message"]?.GetValue<string>(), added = 0, updated = 0 });
                continue;
            }
            Interlocked.Exchange(ref state.Dirty, 0);
            state.LastScan = DateTime.UtcNow;
            var added = 0;
            var updated = 0;
            try
            {
                var paths = Enumerate(path);
                var references = files.TrackMany(paths);
                var excluded = (folder["excludedItemIds"] as JsonArray)?.Select(value => value!.GetValue<string>()).ToHashSet(StringComparer.Ordinal) ?? new();
                var sourceItems = (folder["itemIds"] as JsonArray)?.Select(value => value!.GetValue<string>()).ToHashSet(StringComparer.Ordinal) ?? new();
                foreach (var reference in references)
                {
                    var key = FileReferenceService.TargetKey(reference);
                    if (!byIdentity.TryGetValue(key, out var item) && !byReferenceId.TryGetValue(reference.ReferenceId, out item) && !legacyPaths.TryGetValue(FilePathKey(reference.Path), out item))
                    {
                        item = new JsonObject { ["id"] = "item-" + Guid.NewGuid().ToString("N"), ["kind"] = "file", ["title"] = reference.FileName, ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                        items.Add(item);
                        byId.Add(item["id"]!.GetValue<string>(), item);
                        added++;
                    }
                    var before = item.ToJsonString();
                    ApplyReference(item, reference);
                    if (before != item.ToJsonString()) updated++;
                    byIdentity[key] = item;
                    byReferenceId[reference.ReferenceId] = item;
                    legacyPaths.Remove(FilePathKey(reference.Path));
                    var itemId = item["id"]!.GetValue<string>();
                    sourceItems.Add(itemId);
                    if (!excluded.Contains(itemId) && pairs.Add((itemId, id))) memberships.Add(new JsonObject { ["itemId"] = itemId, ["fieldId"] = id });
                }
                var known = sourceItems.Where(byId.ContainsKey).Select(itemId => byId[itemId]).Where(item => item["native"] is JsonObject).ToArray();
                var resolved = files.Resolve(known.Select(item => item["native"]!["referenceId"]!.GetValue<string>()));
                var indexed = resolved.ToDictionary(reference => reference.ReferenceId, StringComparer.OrdinalIgnoreCase);
                foreach (var item in known)
                    if (indexed.TryGetValue(item["native"]!["referenceId"]!.GetValue<string>(), out var reference) && reference.Status != "unregistered") ApplyReference(item, reference);
                folder["itemIds"] = new JsonArray(sourceItems.OrderBy(value => value, StringComparer.Ordinal).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
                folder["status"] = "available";
                folder.Remove("message");
                statuses.Add(new { fieldId = id, path, status = "available", message = (string?)null, added, updated });
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or System.ComponentModel.Win32Exception)
            {
                folder["status"] = "unavailable";
                folder["message"] = error.Message;
                statuses.Add(new { fieldId = id, path, status = "unavailable", message = error.Message, added = 0, updated = 0 });
            }
        }
        var snapshot = JsonSerializer.SerializeToElement(candidate, Json);
        LibraryEnvelope saved;
        try { saved = JsonNode.DeepEquals(candidate, JsonNode.Parse(current.Snapshot.GetRawText())) ? current : library.Save(snapshot, current.Revision); }
        catch { foreach (var state in watched.Values) Interlocked.Exchange(ref state.Dirty, 1); throw; }
        return new { revision = saved.Revision, snapshot = saved.Snapshot, folders = statuses };
    }

    private static void ApplyReference(JsonObject item, NativeReference reference)
    {
        var previousName = item["fileName"]?.GetValue<string>();
        if (reference.Status == "available" && item["title"]?.GetValue<string>() == previousName) item["title"] = reference.FileName;
        var native = JsonSerializer.SerializeToNode(reference, Json)!.AsObject();
        native.Remove("lastSeenUtc");
        item["native"] = native;
        item["path"] = reference.Path;
        item["fileName"] = reference.FileName;
        if (reference.Size is long size) item["size"] = size;
        if (reference.ModifiedUtc is not null) item["modifiedUtc"] = reference.ModifiedUtc;
    }

    private List<string> Enumerate(string root)
    {
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException("The linked folder is unavailable. Existing items are kept.");
        var pending = new Stack<string>();
        pending.Push(root);
        var result = new List<string>();
        while (pending.TryPop(out var directory))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                if (Inside(entry, dataDirectory)) continue;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
                else result.Add(entry);
                if (result.Count > MaximumFiles) throw new IOException("This folder exceeds the current 100,000-file scan limit. Link a smaller folder; existing items are kept.");
            }
        }
        return result;
    }

    private void UpdateWatchers(JsonObject snapshot)
    {
        var sources = snapshot["fields"]!.AsArray().OfType<JsonObject>().Where(field => field["folder"] is JsonObject)
            .ToDictionary(field => field["id"]!.GetValue<string>(), field => NormalizeFolder(field["folder"]!["path"]!.GetValue<string>()), StringComparer.Ordinal);
        foreach (var id in watched.Keys.ToArray())
            if (!sources.TryGetValue(id, out var path) || !string.Equals(path, watched[id].Path, StringComparison.OrdinalIgnoreCase)) { watched[id].Dispose(); watched.Remove(id); }
        foreach (var (id, path) in sources)
            if (!watched.ContainsKey(id)) watched[id] = new WatchedFolder { Path = path };
        bool Covered(string id, string path) => sources.Any(other => other.Key != id && Inside(path, other.Value) &&
            (!string.Equals(path, other.Value, StringComparison.OrdinalIgnoreCase) || string.CompareOrdinal(other.Key, id) < 0));
        // Windows cannot rename an ancestor while a separate child-folder watcher owns a handle.
        // One recursive watcher covers overlapping sources and fans notifications out to their states.
        foreach (var (id, state) in watched)
            if (Covered(id, state.Path) && state.Watcher is not null) { state.Watcher.Dispose(); state.Watcher = null; }
        Volatile.Write(ref notificationStates, watched.Values.ToArray());
        foreach (var (id, path) in sources)
        {
            var state = watched[id];
            if (Covered(id, path) || state.Watcher is not null || !Directory.Exists(path)) continue;
            try
            {
                var watcher = new FileSystemWatcher(path) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
                void Mark(string changed)
                {
                    if (Inside(changed, dataDirectory)) return;
                    foreach (var source in Volatile.Read(ref notificationStates))
                        if (Inside(changed, source.Path) || Inside(source.Path, changed)) Interlocked.Exchange(ref source.Dirty, 1);
                }
                FileSystemEventHandler dirty = (_, args) => Mark(args.FullPath);
                watcher.Created += dirty; watcher.Deleted += dirty; watcher.Changed += dirty;
                watcher.Renamed += (_, args) => { Mark(args.OldFullPath); Mark(args.FullPath); };
                watcher.Error += (_, _) => { foreach (var source in Volatile.Read(ref notificationStates)) Interlocked.Exchange(ref source.Dirty, 1); };
                watcher.EnableRaisingEvents = true;
                state.Watcher = watcher;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { Interlocked.Exchange(ref state.Dirty, 1); }
        }
    }

    private static string NormalizeFolder(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0') || !Path.IsPathFullyQualified(path)) throw new ArgumentException("Choose an absolute Windows folder path.");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }
    private static string FilePathKey(string path)
    {
        path = path.Replace('/', '\\');
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path[8..];
        else if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) && path.Length > 6 && path[5] == ':') path = path[4..];
        return Path.GetFullPath(path);
    }
    private static bool Inside(string candidate, string parent) => string.Equals(candidate, parent, StringComparison.OrdinalIgnoreCase) || candidate.StartsWith(Path.EndsInDirectorySeparator(parent) ? parent : parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    public void Dispose() { Volatile.Write(ref notificationStates, Array.Empty<WatchedFolder>()); foreach (var state in watched.Values) state.Dispose(); watched.Clear(); }
}
