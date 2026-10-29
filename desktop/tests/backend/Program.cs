using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text;
using Microsoft.Data.Sqlite;
using Field.Native;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("The desktop backend checks require Windows.");
if (args.Length != 1 || !Path.IsPathFullyQualified(args[0])) throw new ArgumentException("Pass an absolute disposable fixture parent.");
var fixture = Path.Combine(Path.GetFullPath(args[0]), "field-backend-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(fixture);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var count = 0;
void Check(bool value, string label) { if (!value) throw new Exception("FAIL " + label); Console.WriteLine("PASS " + label); count++; }
async Task<JsonElement> Call(DesktopBackend backend, string method, object? parameters = null) =>
    JsonSerializer.SerializeToElement(await backend.HandleAsync(method, JsonSerializer.SerializeToElement(parameters ?? new { }, json)), json);
async Task<bool> Fails(DesktopBackend backend, string method, object parameters)
{
    try { await Call(backend, method, parameters); return false; }
    catch (Exception error) when (error is ArgumentException or InvalidDataException or InvalidOperationException or IOException or UnauthorizedAccessException or KeyNotFoundException) { return true; }
}
void Sql(string directory,string sql) { using var connection=new SqliteConnection("Data Source="+Path.Combine(directory,"library.sqlite")); connection.Open(); using var command=connection.CreateCommand(); command.CommandText=sql; command.ExecuteNonQuery(); }
string DiskState(string directory) { using var connection=new SqliteConnection("Data Source="+Path.Combine(directory,"library.sqlite")); connection.Open(); using var command=connection.CreateCommand(); command.CommandText="SELECT value FROM metadata WHERE key='revision' UNION ALL SELECT payload FROM items ORDER BY 1"; using var reader=command.ExecuteReader(); var result=new List<string>(); while(reader.Read())result.Add(reader.GetString(0)); return string.Join("\n",result); }
const string blockCommit="CREATE TRIGGER block_commit BEFORE UPDATE ON metadata WHEN NEW.key='revision' BEGIN SELECT RAISE(ABORT,'Injected commit failure'); END;";
JsonElement Snapshot(JsonNode node) => JsonSerializer.SerializeToElement(node, json);
var original = Path.Combine(fixture, "original.txt");
var moved = Path.Combine(fixture, "renamed.txt");
await File.WriteAllTextAsync(original, "FIELD native import fixture");
NativeReference native;
using (var legacy = new FileReferenceService(Path.Combine(fixture, "legacy-state"))) native = legacy.Track(original);
File.Move(original, moved);
var nativeNode = JsonSerializer.SerializeToNode(native, json)!;
nativeNode.AsObject().Remove("lastSeenUtc"); // Browser snapshots omit this host-only observation timestamp.
nativeNode["referenceId"] = native.ReferenceId.ToUpperInvariant();
nativeNode["identity"]!["volumeSerial"] = native.Identity!.VolumeSerial.ToUpperInvariant();
nativeNode["identity"]!["fileId"] = native.Identity.FileId.ToUpperInvariant();
nativeNode["identity"]!["creationTime"] = "0" + native.Identity.CreationTime;
var source = JsonNode.Parse("""
{"version":1,"fields":[{"id":"field-a","name":"Archive","color":"#6384ff","parent":null},{"id":"field-b","name":"Shared","color":"#80bca3","parent":null}],"items":[{"id":"file-item","kind":"file","title":"Custom file name","fileName":"original.txt","path":"","annotation":"keep this annotation"},{"id":"note-item","kind":"note","title":"Notes","body":"Original note"},{"id":"link-item","kind":"link","title":"Reference","url":"https://example.com/"},{"id":"drawing-item","kind":"drawing","title":"Sketch","drawing":"data:image/png;base64,iVBORw0KGgo="}],"memberships":[{"itemId":"file-item","fieldId":"field-a"},{"itemId":"file-item","fieldId":"field-b"},{"itemId":"note-item","fieldId":"field-a"},{"itemId":"link-item","fieldId":"field-b"},{"itemId":"drawing-item","fieldId":"field-b"}],"connections":[{"id":"edge-1","from":"field-a","to":"field-b","kind":"related","label":"Related"}]}
""")!;
source["items"]![0]!["path"] = original;
source["items"]![0]!["native"] = nativeNode;
var data = Path.Combine(fixture, "desktop-state");
string importedId;
using (var backend = new DesktopBackend(data))
{
    var info = await Call(backend, "app.info");
    Check(info.GetProperty("app").GetString() == "FIELD" && info.GetProperty("storage").GetString() == "native", "app identifies native storage");
    var fresh = await Call(backend, "library.load");
    Check(fresh.GetProperty("revision").GetInt32() == 0 && fresh.GetProperty("snapshot").GetProperty("items").GetArrayLength() == 0, "fresh catalogue is empty");
    var secondBlocked = false;
    try { using var second = new DesktopBackend(data); }
    catch (IOException) { secondBlocked = true; }
    Check(secondBlocked, "only one backend owns the data directory");
    var imported = await Call(backend, "library.import", new { snapshot = Snapshot(source), expectedRevision = 0 });
    var item = imported.GetProperty("snapshot").GetProperty("items")[0];
    importedId = item.GetProperty("native").GetProperty("referenceId").GetString()!;
    Check(importedId == native.ReferenceId, "import normalizes native ID casing without changing its target");
    Check(imported.GetProperty("revision").GetInt32() == 1 && item.GetProperty("id").GetString() == "file-item", "import commits without changing canonical item ID");
    Check(item.GetProperty("title").GetString() == "Custom file name" && item.GetProperty("annotation").GetString() == "keep this annotation", "import preserves names and extra user content");
    Check(imported.GetProperty("snapshot").GetProperty("memberships").GetArrayLength() == 5 && imported.GetProperty("snapshot").GetProperty("connections").GetArrayLength() == 1, "all content kinds, memberships, and connections survive import");
    var resolved = await Call(backend, "files.resolve", new { referenceIds = new[] { importedId } });
    var reference = resolved.GetProperty("references")[0];
    Check(reference.GetProperty("status").GetString() == "available" && reference.GetProperty("path").GetString() == moved, "imported stable identity follows a rename made before import");
    var trackedAgain = await Call(backend, "files.track", new { path = moved });
    Check(trackedAgain.GetProperty("reference").GetProperty("referenceId").GetString() == importedId, "tracking an imported file reuses its reference");
    Check(await Fails(backend, "library.import", new { snapshot = Snapshot(source), expectedRevision = 1 }), "import cannot replace a nonempty catalogue");
    Check(await Fails(backend, "library.save", new { snapshot = Snapshot(source), expectedRevision = 0 }), "stale revision cannot overwrite imported data");
    var invalid = source.DeepClone();
    invalid["memberships"]![0]!["fieldId"] = "absent";
    Check(await Fails(backend, "library.save", new { snapshot = Snapshot(invalid), expectedRevision = 1 }), "dangling memberships are rejected");
    invalid = source.DeepClone();
    invalid["fields"]![0]!["parent"] = "field-b";
    invalid["fields"]![1]!["parent"] = "field-a";
    Check(await Fails(backend, "library.save", new { snapshot = Snapshot(invalid), expectedRevision = 1 }), "cyclic field parents are rejected");
    var snapshot = JsonNode.Parse(imported.GetProperty("snapshot").GetRawText())!;
    snapshot["items"]![1]!["body"] = "Edited once";
    snapshot["items"]!.AsArray().Add(new JsonObject { ["id"] = "escaped-link", ["kind"] = "link", ["title"] = "Escaped path", ["url"] = "https://example.com/%61" });
    snapshot["items"]!.AsArray().Add(new JsonObject { ["id"] = "literal-link", ["kind"] = "link", ["title"] = "Literal path", ["url"] = "https://example.com/a" });
    var saved = await Call(backend, "library.save", new { snapshot = Snapshot(snapshot), expectedRevision = 1 });
    Check(saved.GetProperty("revision").GetInt32() == 2, "normal editing advances native revision");
    Check((await Call(backend, "library.load")).GetProperty("snapshot").GetProperty("items").GetArrayLength() == 6, "native storage preserves distinct escaped URL paths accepted by the UI");
    var diskBefore = DiskState(data);
    Sql(data, blockCommit);
    snapshot["items"]![1]!["body"] = "Must not commit";
    Check(await Fails(backend, "library.save", new { snapshot = Snapshot(snapshot), expectedRevision = 2 }), "disk write failure is reported");
    Sql(data, "DROP TRIGGER block_commit");
    var afterFailure = await Call(backend, "library.load");
    Check(afterFailure.GetProperty("revision").GetInt32() == 2 && afterFailure.GetProperty("snapshot").GetProperty("items")[1].GetProperty("body").GetString() == "Edited once", "failed write leaves in-memory catalogue unchanged");
    Check(DiskState(data) == diskBefore, "failed write leaves saved catalogue unchanged");
    Check(await Fails(backend, "files.open", new { referenceId = Guid.NewGuid().ToString("N") }), "unknown file references cannot launch a path");
    Check(await Fails(backend, "files.resolve", new { referenceIds = new[] { "invalid" } }), "malformed native reference IDs are rejected");
    Check(await Fails(backend, "unknown.operation", new { }), "bridge only accepts known operations");
}
using (var restored = new DesktopBackend(data))
{
    var saved = await Call(restored, "library.load");
    Check(saved.GetProperty("revision").GetInt32() == 2 && saved.GetProperty("snapshot").GetProperty("items")[1].GetProperty("body").GetString() == "Edited once", "catalogue survives backend restart");
    var resolved = await Call(restored, "files.resolve", new { referenceIds = new[] { importedId } });
    Check(resolved.GetProperty("references")[0].GetProperty("path").GetString() == moved, "adopted native references survive backend restart");
}
var failedImportData = Path.Combine(fixture, "failed-import-state");
using (var failedImport = new DesktopBackend(failedImportData))
{
    var block = Path.Combine(failedImportData, "file-references.json.tmp");
    Directory.CreateDirectory(block);
    Check(await Fails(failedImport, "library.import", new { snapshot = Snapshot(source), expectedRevision = 0 }), "reference registry write failure prevents catalogue import");
    Directory.Delete(block);
    var unchanged = await Call(failedImport, "library.load");
    Check(unchanged.GetProperty("revision").GetInt32() == 0 && unchanged.GetProperty("snapshot").GetProperty("items").GetArrayLength() == 0, "failed reference adoption leaves catalogue empty");
    var unresolved = await Call(failedImport, "files.resolve", new { referenceIds = new[] { native.ReferenceId } });
    Check(unresolved.GetProperty("references")[0].GetProperty("status").GetString() == "unregistered", "failed adoption rolls back reference memory");
    var retried = await Call(failedImport, "library.import", new { snapshot = Snapshot(source), expectedRevision = 0 });
    Check(retried.GetProperty("revision").GetInt32() == 1, "import succeeds after correcting a storage failure");
}
var corruptData = Path.Combine(fixture, "corrupt-state");
var failedLibraryData = Path.Combine(fixture, "failed-library-import-state");
using (var backend = new DesktopBackend(failedLibraryData))
{
    var existing = await Call(backend, "files.track", new { path = moved });
    var existingId = existing.GetProperty("reference").GetProperty("referenceId").GetString();
    Sql(failedLibraryData, blockCommit);
    Check(await Fails(backend, "library.import", new { snapshot = Snapshot(source), expectedRevision = 0 }), "library write failure after reference adoption is reported");
    var unchanged = await Call(backend, "library.load");
    Check(unchanged.GetProperty("revision").GetInt32() == 0 && unchanged.GetProperty("snapshot").GetProperty("items").GetArrayLength() == 0, "failed import commit never mutates the previous catalogue");
    Sql(failedLibraryData, "DROP TRIGGER block_commit");
    var retried = await Call(backend, "library.import", new { snapshot = Snapshot(source), expectedRevision = 0 });
    Check(retried.GetProperty("snapshot").GetProperty("items")[0].GetProperty("native").GetProperty("referenceId").GetString() == existingId, "import retry reconciles the browser reference to an existing native target");
}
Directory.CreateDirectory(corruptData);
var corruptPath = Path.Combine(corruptData, "library.json");
const string corrupt = "{\"version\":1,\"revision\":0,\"snapshot\":{\"version\":1,\"fields\":[]}}";
await File.WriteAllTextAsync(corruptPath, corrupt);
for (var attempt = 0; attempt < 2; attempt++)
{
    var rejected = false;
    try { using var invalid = new DesktopBackend(corruptData); }
    catch (InvalidDataException) { rejected = true; }
    Check(rejected, "invalid saved catalogue is rejected and constructor releases its lock");
}
Check(await File.ReadAllTextAsync(corruptPath) == corrupt, "invalid saved catalogue is never reset");
var importFile = Path.Combine(fixture, "browser-export.json");
var exportText = JsonSerializer.Serialize(new { format = "FIELD.library", version = 1, snapshot = Snapshot(source) }, json);
await File.WriteAllTextAsync(importFile, exportText, new UTF8Encoding(true));
var selectedLibrary = await SelectedLibraryFile.ReadAsync(importFile);
Check(selectedLibrary.Text == exportText && selectedLibrary.FileName == "browser-export.json", "owned import file reader accepts UTF-8 with a BOM and returns export text");
async Task<bool> RejectFile(string path)
{
    try { await SelectedLibraryFile.ReadAsync(path); return false; }
    catch (InvalidDataException) { return true; }
}
var invalidUtf8 = Path.Combine(fixture, "invalid-utf8.json");
await File.WriteAllBytesAsync(invalidUtf8, new byte[] { 0xFF, 0xFD, 0x00 });
Check(await RejectFile(invalidUtf8), "import reader rejects invalid UTF-8");
var wrongFormat = Path.Combine(fixture, "other.json");
await File.WriteAllTextAsync(wrongFormat, "{\"format\":\"other-app\",\"version\":1,\"snapshot\":{}}");
Check(await RejectFile(wrongFormat), "import reader rejects unrelated JSON formats");
await File.WriteAllTextAsync(wrongFormat, "{");
Check(await RejectFile(wrongFormat), "import reader rejects malformed JSON");
var oversized = Path.Combine(fixture, "oversized.json");
using (var tooLarge = File.Create(oversized)) tooLarge.SetLength(64L * 1024 * 1024 + 1);
Check(await RejectFile(oversized), "import reader bounds file bytes before returning data");
var textExtension = Path.Combine(fixture, "export.txt");
await File.WriteAllTextAsync(textExtension, exportText);
Check(await RejectFile(textExtension), "import reader requires a JSON export extension");
var pickerReadData = Path.Combine(fixture, "read-only-picker-state");
using (var backend = new DesktopBackend(pickerReadData))
{
    await SelectedLibraryFile.ReadAsync(importFile);
    var unchanged = await Call(backend, "library.load");
    Check(unchanged.GetProperty("revision").GetInt32() == 0 && unchanged.GetProperty("snapshot").GetProperty("items").GetArrayLength() == 0, "reading an import file does not commit catalogue changes");
}
Console.WriteLine($"{count} desktop backend checks passed. Fixtures: {fixture}");
