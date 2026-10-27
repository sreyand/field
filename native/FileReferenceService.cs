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
        if (!File.Exists(registryPath)) return;
        var registry = JsonSerializer.Deserialize<ReferenceRegistry>(File.ReadAllText(registryPath), Json)
            ?? throw new InvalidDataException("The file reference registry is empty or invalid. Restore its backup before starting FIELD.");
        if (registry.Version != 1 || registry.References is null)
            throw new InvalidDataException("The file reference registry has an unsupported format.");
        var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var reference in registry.References)
        {
            if (reference is null || !Guid.TryParseExact(reference.ReferenceId, "N", out _) ||
                string.IsNullOrWhiteSpace(reference.Path) || string.IsNullOrWhiteSpace(reference.FileName) ||
                !System.IO.Path.IsPathFullyQualified(reference.Path) || reference.Size < 0 ||
                !new[] { "available", "missing", "unavailable", "inaccessible", "unsupported", "replaced" }.Contains(reference.Status) ||
                reference.Identity is { } identity && !ValidIdentity(identity) ||
                !references.TryAdd(reference.ReferenceId, reference))
                throw new InvalidDataException("The file reference registry contains an invalid or duplicate reference.");
            var target = reference.Identity is { } stable
                ? $"id:{stable.VolumeSerial}:{stable.FileId}:{stable.CreationTime}" : $"path:{reference.Path}";
            if (!targets.Add(target)) throw new InvalidDataException("The file reference registry contains a duplicate file identity.");
        }
    }

    public void Dispose() => registryLock.Dispose();

    private static bool ValidIdentity(FileIdentityRecord identity) =>
        identity.VolumeSerial is not null && Regex.IsMatch(identity.VolumeSerial, "^[a-f0-9]{16}$") &&
        identity.FileId is not null && Regex.IsMatch(identity.FileId, "^[a-f0-9]{32}$") &&
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

    public IReadOnlyList<NativeReference> Resolve(IEnumerable<string> ids)
    {
        lock (gate)
        {
            var result = new List<NativeReference>();
            var originals = new Dictionary<string, NativeReference>(StringComparer.Ordinal);
            var changed = false;
            foreach (var id in ids.Distinct(StringComparer.Ordinal))
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
