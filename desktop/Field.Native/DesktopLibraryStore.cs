using System.Text.Json;

namespace Field.Native;

public sealed record LibraryEnvelope(long Revision, JsonElement Snapshot);
internal sealed record SavedLibrary(int Version, long Revision, JsonElement Snapshot);

/// <summary>App-owned catalogue. Every commit flushes before replacing the previous JSON file.</summary>
public sealed class DesktopLibraryStore : IDisposable
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false, PropertyNameCaseInsensitive = false };
    private readonly object gate = new();
    private readonly string path;
    private readonly FileStream libraryLock;
    private LibraryEnvelope current = new(0, LibrarySnapshot.Empty());
    private bool disposed;

    public DesktopLibraryStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        path = Path.Combine(dataDirectory, "library.json");
        libraryLock = new FileStream(Path.Combine(dataDirectory, "library.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        try
        {
            if (!File.Exists(path)) return;
            if (new FileInfo(path).Length > LibrarySnapshot.MaximumBytes) throw new InvalidDataException("The saved library exceeds this alpha's 64 MB limit.");
            var saved = JsonSerializer.Deserialize<SavedLibrary>(File.ReadAllBytes(path), Json)
                ?? throw new InvalidDataException("The saved library is invalid and has not been overwritten.");
            if (saved.Version != 1 || saved.Revision < 0 || saved.Revision > 9007199254740991)
                throw new InvalidDataException("The saved library is invalid and has not been overwritten.");
            LibrarySnapshot.Validate(saved.Snapshot);
            current = new(saved.Revision, saved.Snapshot.Clone());
        }
        catch { libraryLock.Dispose(); throw; }
    }

    public LibraryEnvelope Load()
    {
        lock (gate) { ThrowIfDisposed(); return new(current.Revision, current.Snapshot.Clone()); }
    }

    public LibraryEnvelope Save(JsonElement snapshot, long expectedRevision)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            CheckRevision(expectedRevision);
            LibrarySnapshot.Validate(snapshot);
            if (current.Revision == 9007199254740991) throw new InvalidOperationException("Library revision limit reached.");
            var saved = new SavedLibrary(1, current.Revision + 1, snapshot.Clone());
            var bytes = JsonSerializer.SerializeToUtf8Bytes(saved, Json);
            if (bytes.Length > LibrarySnapshot.MaximumBytes) throw new InvalidDataException("The library exceeds this alpha's 64 MB limit.");
            var temporary = path + ".tmp";
            using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
            current = new(saved.Revision, saved.Snapshot);
            return new(current.Revision, current.Snapshot.Clone());
        }
    }

    public void CheckImport(long expectedRevision)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            CheckRevision(expectedRevision);
            if (!LibrarySnapshot.IsEmpty(current.Snapshot))
                throw new InvalidOperationException("Import requires an empty desktop library. Your existing library has not been changed.");
        }
    }

    public void Dispose()
    {
        lock (gate) { if (disposed) return; disposed = true; libraryLock.Dispose(); }
    }

    private void CheckRevision(long expectedRevision)
    {
        if (expectedRevision != current.Revision)
            throw new InvalidOperationException("The library changed in another window. Reload FIELD before saving.");
    }
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(disposed, this);
}
