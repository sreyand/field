using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Field.Native;

public sealed record LibraryEnvelope(long Revision, JsonElement Snapshot);
internal sealed record SavedLibrary(int Version, long Revision, JsonElement Snapshot);
public sealed record CatalogueBackup(string FileName, string CreatedUtc, long Bytes);

/// <summary>Transactional SQLite catalogue. Snapshot APIs preserve canonical IDs and existing clients.</summary>
public sealed class DesktopLibraryStore : IDisposable
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = false };
    private const long MaximumRevision = 9007199254740991;
    private readonly object gate = new();
    private readonly string databasePath;
    private readonly string backupDirectory;
    private readonly FileStream libraryLock;
    private SqliteConnection database = null!;
    private LibraryEnvelope current = new(0, LibrarySnapshot.Empty());
    private bool disposed;
    public string? BackupWarning { get; private set; }

    public DesktopLibraryStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        databasePath = Path.Combine(dataDirectory, "library.sqlite");
        backupDirectory = Path.Combine(dataDirectory, "backups");
        libraryLock = new FileStream(Path.Combine(dataDirectory,"library.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        try
        {
            if (!File.Exists(databasePath))
            {
                var legacy=Path.Combine(dataDirectory,"library.json");
                // Validate before creating the database; retain the original catalogue and a migration copy.
                var initial=File.Exists(legacy) ? ReadLegacy(legacy) : current;
                var temporary=databasePath+".migrating-"+Guid.NewGuid().ToString("N");
                using(var connection=Connect(temporary,SqliteOpenMode.ReadWriteCreate))
                {
                    SqliteCatalogue.Initialize(connection);
                    SqliteCatalogue.Write(connection,initial.Snapshot,initial.Revision);
                    LibrarySnapshot.Validate(SqliteCatalogue.Read(connection).Snapshot);
                }
                if(File.Exists(legacy))
                {
                    Directory.CreateDirectory(backupDirectory);
                    File.Copy(legacy,Path.Combine(backupDirectory,"legacy-"+Stamp()+".json"));
                }
                File.Move(temporary,databasePath);
            }
            database=Connect(databasePath,SqliteOpenMode.ReadWrite);
            ValidateDatabase(database);
            current=SqliteCatalogue.Read(database);
            SqliteCatalogue.Execute(database,"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
            EnsureDailyBackup();
        }
        catch { database?.Dispose(); libraryLock.Dispose(); throw; }
    }

    public LibraryEnvelope Load()
    {
        lock(gate) { ThrowIfDisposed(); return new(current.Revision,current.Snapshot.Clone()); }
    }
    public LibraryEnvelope Save(JsonElement snapshot,long expectedRevision)
    {
        lock(gate)
        {
            ThrowIfDisposed(); CheckRevision(expectedRevision); LibrarySnapshot.Validate(snapshot);
            if(current.Revision==MaximumRevision) throw new InvalidOperationException("Library revision limit reached.");
            if(Encoding.UTF8.GetByteCount(snapshot.GetRawText())>LibrarySnapshot.MaximumBytes) throw new InvalidDataException("The library exceeds this alpha's 64 MB limit.");
            EnsureDailyBackup();
            var revision=current.Revision+1;
            try { SqliteCatalogue.Write(database,snapshot,revision); }
            catch(SqliteException error) { throw new IOException("The catalogue could not be saved. Your previous catalogue is intact.",error); }
            current=new(revision,snapshot.Clone());
            // The first nonempty commit of a new library also gets a daily recovery copy.
            // A backup failure after commit must not falsely report that the save failed.
            try { EnsureDailyBackup(); BackupWarning=null; }
            catch(Exception error) when(error is IOException or UnauthorizedAccessException or SqliteException) { BackupWarning="The catalogue was saved, but its automatic backup could not be created: "+error.Message; }
            return new(revision,snapshot.Clone());
        }
    }
    public void CheckImport(long expectedRevision)
    {
        lock(gate)
        {
            ThrowIfDisposed(); CheckRevision(expectedRevision);
            if(!LibrarySnapshot.IsEmpty(current.Snapshot)) throw new InvalidOperationException("Import requires an empty desktop library. Your existing library has not been changed.");
        }
    }
    public JsonElement QuerySearch(string query,int limit=100)
    {
        lock(gate)
        {
            ThrowIfDisposed(); limit=Math.Clamp(limit,1,500);
            var terms=(query??"").Split((char[]?)null,StringSplitOptions.RemoveEmptyEntries).Take(12).Select(term=>"\""+term.Replace("\"","\"\"")+"\"*").ToArray();
            if(terms.Length==0) return JsonSerializer.SerializeToElement(Array.Empty<object>());
            using var command=database.CreateCommand();
            command.CommandText="SELECT kind,id,title,substr(preview,1,180) FROM search_documents WHERE search_documents MATCH $query ORDER BY rank LIMIT $limit";
            command.Parameters.AddWithValue("$query",string.Join(" AND ",terms)); command.Parameters.AddWithValue("$limit",limit);
            using var reader=command.ExecuteReader(); var found=new List<object>();
            while(reader.Read()) found.Add(new {kind=reader.GetString(0),id=reader.GetString(1),title=reader.GetString(2),preview=reader.GetString(3)});
            return JsonSerializer.SerializeToElement(found,Json);
        }
    }
    public IReadOnlyList<CatalogueBackup> ListBackups()
    {
        lock(gate)
        {
            ThrowIfDisposed();
            return Directory.Exists(backupDirectory) ? Directory.EnumerateFiles(backupDirectory,"*.sqlite").Select(path=>new FileInfo(path)).OrderByDescending(file=>file.LastWriteTimeUtc).Select(file=>new CatalogueBackup(file.Name,file.LastWriteTimeUtc.ToString("O"),file.Length)).ToArray() : Array.Empty<CatalogueBackup>();
        }
    }
    public LibraryEnvelope RestoreBackup(string fileName,long expectedRevision)
    {
        lock(gate)
        {
            ThrowIfDisposed(); CheckRevision(expectedRevision);
            if(string.IsNullOrWhiteSpace(fileName)||fileName!=Path.GetFileName(fileName)||fileName.IndexOfAny(new[]{'/', '\\', ':'})>=0||!fileName.EndsWith(".sqlite",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Choose a FIELD catalogue backup.");
            var path=Path.Combine(backupDirectory,fileName);
            if(!File.Exists(path)) throw new FileNotFoundException("This catalogue backup is unavailable.");
            LibraryEnvelope saved;
            using(var source=Connect(path,SqliteOpenMode.ReadOnly)) { ValidateDatabase(source); saved=SqliteCatalogue.Read(source); }
            CreateBackup("before-restore-"+Stamp()+".sqlite");
            return Save(saved.Snapshot,expectedRevision);
        }
    }
    public void Dispose()
    {
        lock(gate) { if(disposed)return; disposed=true; database.Dispose(); libraryLock.Dispose(); }
    }
    /// <summary>Explicit recovery while the catalogue cannot open. Every displaced database file is retained.</summary>
    public static void Recover(string dataDirectory,string backupFileName)
    {
        if(!Path.IsPathFullyQualified(dataDirectory)) throw new ArgumentException("Choose FIELD's app data directory.");
        if(string.IsNullOrWhiteSpace(backupFileName)||backupFileName!=Path.GetFileName(backupFileName)||backupFileName.IndexOfAny(new[]{'/', '\\', ':'})>=0||!backupFileName.EndsWith(".sqlite",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Choose a FIELD catalogue backup.");
        var root=Path.GetFullPath(dataDirectory);
        using var recoveryLock=new FileStream(Path.Combine(root,"library.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var source=Path.Combine(root,"backups",backupFileName);
        if(!File.Exists(source)||new FileInfo(source).Length>512L*1024*1024) throw new InvalidDataException("This catalogue backup is unavailable or exceeds the recovery limit.");
        var temporary=Path.Combine(root,"recovery-"+Stamp()+".sqlite");
        File.Copy(source,temporary);
        // Validate the exact copied bytes before moving any current database or journal file.
        using(var verify=Connect(temporary,SqliteOpenMode.ReadOnly)) ValidateDatabase(verify);
        var displaced=Path.Combine(root,"recovery-before-"+Stamp());
        Directory.CreateDirectory(displaced);
        var database=Path.Combine(root,"library.sqlite");
        var journals=new List<(string Original,string Saved)>();
        try
        {
            foreach(var suffix in new[]{"-wal","-shm"})
            {
                var candidate=database+suffix;
                if(!File.Exists(candidate)) continue;
                var saved=Path.Combine(displaced,"library.sqlite"+suffix);
                File.Move(candidate,saved); journals.Add((candidate,saved));
            }
            // ReplaceFile atomically installs the new catalogue and retains the original database.
            if(File.Exists(database)) File.Replace(temporary,database,Path.Combine(displaced,"library.sqlite"));
            else File.Move(temporary,database);
        }
        catch
        {
            foreach(var journal in journals) if(File.Exists(journal.Saved)&&!File.Exists(journal.Original)) File.Move(journal.Saved,journal.Original);
            throw;
        }
    }
    private static SqliteConnection Connect(string path,SqliteOpenMode mode)
    {
        var connection=new SqliteConnection(new SqliteConnectionStringBuilder {DataSource=path,Mode=mode,Pooling=false,ForeignKeys=true}.ToString());
        try { connection.Open(); return connection; } catch { connection.Dispose(); throw; }
    }
    private static void ValidateDatabase(SqliteConnection connection)
    {
        using var command=connection.CreateCommand(); command.CommandText="PRAGMA quick_check";
        if(!Equals(command.ExecuteScalar(),"ok")) throw new InvalidDataException("The catalogue database is damaged. Restore a backup before continuing.");
        command.CommandText="PRAGMA user_version";
        if(Convert.ToInt64(command.ExecuteScalar())!=1) throw new InvalidDataException("Unsupported FIELD catalogue database version.");
        _=SqliteCatalogue.Read(connection);
    }
    private static LibraryEnvelope ReadLegacy(string path)
    {
        if(new FileInfo(path).Length>LibrarySnapshot.MaximumBytes) throw new InvalidDataException("The saved library exceeds this alpha's 64 MB limit.");
        var saved=JsonSerializer.Deserialize<SavedLibrary>(File.ReadAllBytes(path),Json)??throw new InvalidDataException("Invalid legacy catalogue; it has not been overwritten.");
        if(saved.Version!=1||saved.Revision<0||saved.Revision>MaximumRevision) throw new InvalidDataException("Invalid legacy catalogue revision.");
        LibrarySnapshot.Validate(saved.Snapshot); return new(saved.Revision,saved.Snapshot.Clone());
    }
    private void EnsureDailyBackup()
    {
        if(LibrarySnapshot.IsEmpty(current.Snapshot)) return;
        var name="daily-"+DateTime.UtcNow.ToString("yyyy-MM-dd")+".sqlite";
        if(!File.Exists(Path.Combine(backupDirectory,name))) CreateBackup(name);
        foreach(var old in Directory.EnumerateFiles(backupDirectory,"daily-*.sqlite").OrderByDescending(Path.GetFileName,StringComparer.Ordinal).Skip(7).ToArray()) File.Delete(old);
    }
    private void CreateBackup(string name)
    {
        Directory.CreateDirectory(backupDirectory);
        var final=Path.Combine(backupDirectory,name); var temporary=final+".writing-"+Guid.NewGuid().ToString("N");
        using(var destination=Connect(temporary,SqliteOpenMode.ReadWriteCreate)) database.BackupDatabase(destination);
        File.Move(temporary,final);
    }
    private static string Stamp()=>DateTime.UtcNow.ToString("yyyyMMddHHmmssfff")+"-"+Guid.NewGuid().ToString("N")[..8];
    private void CheckRevision(long expected) { if(expected!=current.Revision) throw new InvalidOperationException("The library changed in another window. Reload FIELD before saving."); }
    private void ThrowIfDisposed()=>ObjectDisposedException.ThrowIf(disposed,this);
}
