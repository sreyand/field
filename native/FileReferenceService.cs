using System.Diagnostics;
using System.Text.Json;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Field.Native;

public sealed record NativeReference(string ReferenceId, FileIdentityRecord? Identity, string Path,
    string FileName, long? Size, string? ModifiedUtc, string Status, bool Recoverable,
    string? Message, string? LastSeenUtc);

internal sealed record ReferenceRegistry(int Version, List<NativeReference> References);

public sealed class FileReferenceService : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, NativeReference> references = new(StringComparer.Ordinal);
    private readonly string registryPath;
    private readonly FileStream registryLock;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public FileReferenceService(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        registryLock = new FileStream(System.IO.Path.Combine(dataDirectory, "file-references.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        registryPath = System.IO.Path.Combine(dataDirectory, "file-references.json");
        try { LoadRegistry(); }
        catch { registryLock.Dispose(); throw; }
    }

    private void LoadRegistry()
    {
        if (!File.Exists(registryPath)) return;
        var registry = JsonSerializer.Deserialize<ReferenceRegistry>(File.ReadAllText(registryPath), Json)
            ?? throw new InvalidDataException("The file reference registry is empty or invalid. Restore its backup before starting FIELD.");
        if (registry.Version != 1 || registry.References is null)
            throw new InvalidDataException("The file reference registry has an unsupported format.");
        var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var source in registry.References)
        {
            ValidateReference(source);
            var reference = NormalizeReference(source);
            if (!references.TryAdd(reference.ReferenceId, reference))
                throw new InvalidDataException("The file reference registry contains an invalid or duplicate reference.");
            var target = TargetKey(reference);
            if (!targets.Add(target)) throw new InvalidDataException("The file reference registry contains a duplicate file identity.");
        }
    }

    public void Dispose() => registryLock.Dispose();

    internal static void ValidateReference(NativeReference? reference)
    {
        if (reference is null || !Guid.TryParseExact(reference.ReferenceId, "N", out _) ||
            string.IsNullOrWhiteSpace(reference.Path) || reference.Path.Length > 32760 || reference.Path.Contains('\0') ||
            string.IsNullOrWhiteSpace(reference.FileName) || reference.FileName.IndexOfAny(new[] { '\\', '/', '\0' }) >= 0 ||
            !System.IO.Path.IsPathFullyQualified(reference.Path) || reference.Size < 0 || reference.Size > 9007199254740991 ||
            !new[] { "available", "missing", "unavailable", "inaccessible", "unsupported", "replaced", "unresolved" }.Contains(reference.Status) ||
            reference.Identity is { } identity && !ValidIdentity(identity))
            throw new InvalidDataException("The file reference registry contains an invalid reference.");
        if (reference.ModifiedUtc is not null &&
            (!DateTimeOffset.TryParse(reference.ModifiedUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var modified) ||
             modified.Offset != TimeSpan.Zero || !(reference.ModifiedUtc.EndsWith("Z", StringComparison.OrdinalIgnoreCase) || reference.ModifiedUtc.EndsWith("+00:00", StringComparison.Ordinal))))
            throw new InvalidDataException("Invalid native file timestamp.");
    }

    internal static string TargetKey(NativeReference reference) => reference.Identity is { } identity
        ? $"id:{identity.VolumeSerial.ToLowerInvariant()}:{identity.FileId.ToLowerInvariant()}:{long.Parse(identity.CreationTime, CultureInfo.InvariantCulture)}"
        : "path:" + NormalizePath(reference.Path).ToLowerInvariant();

    private static NativeReference NormalizeReference(NativeReference reference) => reference with
    {
        ReferenceId = reference.ReferenceId.ToLowerInvariant(),
        Identity = reference.Identity is { } identity ? identity with
        {
            VolumeSerial = identity.VolumeSerial.ToLowerInvariant(),
            FileId = identity.FileId.ToLowerInvariant(),
            CreationTime = long.Parse(identity.CreationTime, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture)
        } : null
    };

    private static string NormalizePath(string path)
    {
        path = path.Replace('/', '\\');
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path[8..];
        else if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) && path.Length > 6 && path[5] == ':') path = path[4..];
        return System.IO.Path.GetFullPath(path);
    }

    /// <summary>Restores native targets during browser-library import without reading file contents.</summary>
    public IReadOnlyDictionary<string, string> Adopt(IEnumerable<NativeReference> imported)
    {
        var incoming = imported.ToArray();
        foreach (var reference in incoming) ValidateReference(reference);
        lock (gate)
        {
            var originals = new Dictionary<string, NativeReference>(references, StringComparer.Ordinal);
            var mapped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var changed = false;
            try
            {
                foreach (var source in incoming)
                {
                    var reference = NormalizeReference(source);
                    if (references.TryGetValue(reference.ReferenceId, out var sameId) &&
                        !string.Equals(TargetKey(reference), TargetKey(sameId), StringComparison.Ordinal))
                        throw new InvalidDataException("A native reference ID already belongs to another file.");
                    var existing = references.Values.FirstOrDefault(candidate => TargetKey(candidate) == TargetKey(reference));
                    if (existing is not null)
                    {
                        mapped[source.ReferenceId] = existing.ReferenceId;
                        continue;
                    }
                    var probe = reference.Identity is { } identity
                        ? NativeFileIdentity.Resolve(identity, reference.Path)
                        : NativeFileIdentity.Inspect(reference.Path);
                    var restored = FromProbe(reference.ReferenceId, probe, reference.Path, reference);
                    // Path-only imports keep path semantics rather than silently claiming a new stable identity.
                    if (reference.Identity is null) restored = restored with { Identity = null, Recoverable = false };
                    references.Add(restored.ReferenceId, restored);
                    mapped[source.ReferenceId] = restored.ReferenceId;
                    changed = true;
                }
                if (changed) Save();
                return mapped;
            }
            catch
            {
                references.Clear();
                foreach (var (id, reference) in originals) references.Add(id, reference);
                throw;
            }
        }
    }

    private static bool ValidIdentity(FileIdentityRecord identity) =>
        identity.VolumeSerial is not null && Regex.IsMatch(identity.VolumeSerial, "^[a-fA-F0-9]{16}$") &&
        identity.FileId is not null && Regex.IsMatch(identity.FileId, "^[a-fA-F0-9]{32}$") &&
        identity.VolumePath is not null && System.IO.Path.IsPathFullyQualified(identity.VolumePath) &&
        identity.CreationTime is not null && long.TryParse(identity.CreationTime, NumberStyles.None, CultureInfo.InvariantCulture, out var creation) && creation >= 0;

    public NativeReference Track(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 32760)
            throw new ArgumentException("Enter an absolute Windows file path.");
        var probe = NativeFileIdentity.Inspect(path);
        if (probe.Status != "available" || string.IsNullOrWhiteSpace(probe.Path))
            throw new ArgumentException(probe.Message ?? "Choose an available file.");
        lock (gate)
        {
            var existing = references.Values.FirstOrDefault(reference => SameTarget(reference, probe));
            var updated = FromProbe(existing?.ReferenceId ?? Guid.NewGuid().ToString("N"), probe,
                existing?.Path ?? path, existing);
            references[updated.ReferenceId] = updated;
            try { Save(); }
            catch
            {
                if (existing is null) references.Remove(updated.ReferenceId);
                else references[existing.ReferenceId] = existing;
                throw;
            }
            return updated;
        }
    }

    /// <summary>Registers a complete folder scan with one durable registry write and indexed identity matching.</summary>
    public IReadOnlyList<NativeReference> TrackMany(IEnumerable<string> paths)
    {
        lock (gate)
        {
            var original = new Dictionary<string, NativeReference>(references, StringComparer.Ordinal);
            var targets = references.Values.ToDictionary(TargetKey, value => value, StringComparer.OrdinalIgnoreCase);
            var pathOnly = references.Values.Where(value => value.Identity is null).ToDictionary(value => NormalizePath(value.Path), value => value, StringComparer.OrdinalIgnoreCase);
            var result = new List<NativeReference>();
            try
            {
                foreach (var path in paths)
                {
                    var probe = NativeFileIdentity.Inspect(path);
                    if (probe.Status != "available" || string.IsNullOrWhiteSpace(probe.Path)) continue;
                    var provisional = FromProbe("", probe, path, null);
                    targets.TryGetValue(TargetKey(provisional), out var existing);
                    if (existing is null) pathOnly.TryGetValue(NormalizePath(probe.Path), out existing);
                    var updated = FromProbe(existing?.ReferenceId ?? Guid.NewGuid().ToString("N"), probe, existing?.Path ?? path, existing);
                    references[updated.ReferenceId] = updated;
                    targets[TargetKey(updated)] = updated;
                    result.Add(updated);
                }
                if (references.Count != original.Count || result.Any(record => !original.TryGetValue(record.ReferenceId, out var previous) || previous != record)) Save();
                return result;
            }
            catch
            {
                references.Clear();
                foreach (var pair in original) references.Add(pair.Key, pair.Value);
                throw;
            }
        }
    }

    public IReadOnlyList<NativeReference> Resolve(IEnumerable<string> ids)
    {
        lock (gate)
        {
            var result = new List<NativeReference>();
            var originals = new Dictionary<string, NativeReference>(StringComparer.Ordinal);
            var changed = false;
            foreach (var id in ids.Select(id => id.ToLowerInvariant()).Distinct(StringComparer.Ordinal))
            {
                if (!references.TryGetValue(id, out var previous))
                {
                    result.Add(new NativeReference(id, null, "", "", null, null, "unregistered", false,
                        "Relink this file.", null));
                    continue;
                }
                var probe = previous.Identity is null
                    ? NativeFileIdentity.Inspect(previous.Path)
                    : NativeFileIdentity.Resolve(previous.Identity, previous.Path);
                var current = FromProbe(id, probe, previous.Path, previous);
                if (current != previous)
                {
                    originals[id] = previous;
                    references[id] = current;
                    changed = true;
                }
                result.Add(current);
            }
            if (changed)
            {
                try { Save(); }
                catch
                {
                    foreach (var (id, original) in originals) references[id] = original;
                    throw;
                }
            }
            return result;
        }
    }

    public void Open(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Unknown file reference.");
        id = id.ToLowerInvariant();
        lock (gate)
        {
            if (!references.ContainsKey(id)) throw new KeyNotFoundException("Relink this file.");
            var reference = Resolve(new[] { id })[0];
            if (reference.Status != "available") throw new InvalidOperationException(reference.Message ?? "This file is unavailable.");
            Process.Start(new ProcessStartInfo(reference.Path) { UseShellExecute = true });
        }
    }

    private static bool SameTarget(NativeReference reference, FileProbe probe)
    {
        if (probe.Identity is { } identity && reference.Identity is { } previous)
            return identity.VolumeSerial.Equals(previous.VolumeSerial, StringComparison.OrdinalIgnoreCase) &&
                identity.FileId.Equals(previous.FileId, StringComparison.OrdinalIgnoreCase) &&
                identity.CreationTime == previous.CreationTime;
        return probe.Identity is null && reference.Identity is null &&
            string.Equals(reference.Path, probe.Path, StringComparison.OrdinalIgnoreCase);
    }

    private static NativeReference FromProbe(string id, FileProbe probe, string lastPath, NativeReference? previous)
    {
        var available = probe.Status == "available";
        var path = available && !string.IsNullOrWhiteSpace(probe.Path) ? probe.Path : lastPath;
        var fileName = available && !string.IsNullOrWhiteSpace(probe.FileName)
            ? probe.FileName : previous?.FileName ?? System.IO.Path.GetFileName(path);
        // A failure never changes the original identity or adopts a replacement's metadata.
        var result = new NativeReference(id, available ? probe.Identity : previous?.Identity ?? probe.Identity,
            path, fileName, available ? probe.Size : previous?.Size,
            available ? probe.ModifiedUtc : previous?.ModifiedUtc,
            probe.Status, probe.Recoverable, probe.Message, previous?.LastSeenUtc);
        if (available && (previous is null || result != previous))
            result = result with { LastSeenUtc = DateTimeOffset.UtcNow.ToString("O") };
        return result;
    }

    private void Save()
    {
        var temporary = registryPath + ".tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new ReferenceRegistry(1, references.Values.ToList()), Json);
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
        File.Move(temporary, registryPath, overwrite: true);
    }
}
