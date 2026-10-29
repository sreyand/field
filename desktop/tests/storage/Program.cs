using System.Text.Json;
using System.Text.Json.Nodes;
using Field.Native;
using Microsoft.Data.Sqlite;

var parent=Path.GetFullPath(args[0]);
var fixture=Path.Combine(parent,"storage-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(fixture);
var json=new JsonSerializerOptions(JsonSerializerDefaults.Web);var count=0;
void Check(bool pass,string name){if(!pass)throw new Exception("FAIL "+name);Console.WriteLine("PASS "+name);count++;}
bool Fails(Action action){try{action();return false;}catch(Exception e) when(e is IOException or InvalidDataException or InvalidOperationException or ArgumentException or JsonException or SqliteException){return true;}}
JsonElement Snapshot(JsonNode source)=>JsonSerializer.SerializeToElement(source,json);
var source=JsonNode.Parse("""
{"version":1,"fields":[{"id":"music","name":"Music","color":"#6384ff","parent":null,"folderSource":{"path":"C:\\Music","recursive":true}},{"id":"jazz","name":"Jazz","color":"#6384ff","parent":"music"}],"items":[{"id":"note","kind":"note","title":"Listening notes","body":"Miles Davis and modal harmony","annotation":"preserve custom annotation"},{"id":"url","kind":"link","title":"Reference","url":"https://example.com/jazz"}],"memberships":[{"itemId":"note","fieldId":"music"},{"itemId":"note","fieldId":"jazz"},{"itemId":"url","fieldId":"jazz"}],"connections":[{"id":"edge","kind":"related","from":"music","to":"jazz","label":"Influences"}]}
""")!;
var legacy=Path.Combine(fixture,"library.json");File.WriteAllText(legacy,JsonSerializer.Serialize(new{version=1,revision=7,snapshot=Snapshot(source)},json));var legacyBytes=File.ReadAllBytes(legacy);
long revision;
using(var store=new DesktopLibraryStore(fixture))
{
 var loaded=store.Load();Check(loaded.Revision==7,"migration preserves revision");Check(File.Exists(Path.Combine(fixture,"library.sqlite")),"catalogue uses SQLite");
 Check(File.ReadAllBytes(legacy).SequenceEqual(legacyBytes),"legacy catalogue kept byte-for-byte");
 Check(loaded.Snapshot.GetProperty("memberships").GetArrayLength()==3&&loaded.Snapshot.GetProperty("connections").GetArrayLength()==1,"migration preserves canonical memberships and connections");
 Check(loaded.Snapshot.GetProperty("fields")[0].GetProperty("folderSource").GetProperty("recursive").GetBoolean(),"custom field payload preserved");
 Check(loaded.Snapshot.GetProperty("items")[0].GetProperty("annotation").GetString()=="preserve custom annotation","custom item payload preserved");
 Check(store.QuerySearch("Miles").GetArrayLength()==1,"FTS searches note bodies");Check(store.QuerySearch("Jazz").GetArrayLength()>=2,"FTS searches fields and URLs");
 Check(store.QuerySearch("mod").GetArrayLength()==1,"search supports prefix matching");Check(store.QuerySearch("\" OR *").GetArrayLength()==0,"search input cannot inject FTS syntax");
 Check(Fails(()=>{using var second=new DesktopLibraryStore(fixture);}),"catalogue lock prevents second writer");
 var backups=store.ListBackups();Check(backups.Count>=1,"daily SQLite backup created");var first=backups[0].FileName;
 // A trigger proves unchanged rows are not rewritten during an unrelated edit.
 using(var probe=new SqliteConnection("Data Source="+Path.Combine(fixture,"library.sqlite")))
 {probe.Open();using var cmd=probe.CreateCommand();cmd.CommandText="CREATE TRIGGER unchanged_note BEFORE UPDATE ON items WHEN old.id='note' BEGIN SELECT RAISE(ABORT,'unchanged row rewritten'); END;";cmd.ExecuteNonQuery();}
 source["items"]![1]!["title"]="Updated reference";var saved=store.Save(Snapshot(source),7);revision=saved.Revision;
 Check(revision==8,"incremental save preserves untouched rows");Check(store.QuerySearch("Updated").GetArrayLength()==1,"search index updates transactionally");
 Check(Fails(()=>store.Save(Snapshot(source),7)),"stale revision rejected");
 var bad=source.DeepClone();bad["memberships"]![0]!["fieldId"]="missing";Check(Fails(()=>store.Save(Snapshot(bad),8)),"invalid membership rejected before commit");Check(store.Load().Revision==8,"validation failure preserves current revision");
 // The trigger deliberately aborts a SQL commit; neither database nor in-memory state may advance.
 var changed=source.DeepClone();changed["items"]![0]!["title"]="Blocked update";Check(Fails(()=>store.Save(Snapshot(changed),8)),"SQL failure does not escape as an unhandled native error");
 Check(store.Load().Revision==8&&store.Load().Snapshot.GetProperty("items")[0].GetProperty("title").GetString()=="Listening notes","SQL rollback preserves complete catalogue");
 using(var probe=new SqliteConnection("Data Source="+Path.Combine(fixture,"library.sqlite"))) {probe.Open();using var cmd=probe.CreateCommand();cmd.CommandText="DROP TRIGGER unchanged_note";cmd.ExecuteNonQuery();}
 Check(Fails(()=>store.RestoreBackup("..\\library.sqlite",8)),"restore rejects traversal");
 var restored=store.RestoreBackup(first,8);revision=restored.Revision;Check(revision==9,"restore keeps revision monotonic");Check(restored.Snapshot.GetProperty("items")[1].GetProperty("title").GetString()=="Reference","restore recovers selected consistent snapshot");
 Check(store.ListBackups().Any(backup=>backup.FileName.StartsWith("before-restore-")),"restore retains a safety backup of current state");
}
using(var reopened=new DesktopLibraryStore(fixture)){Check(reopened.Load().Revision==revision,"SQLite revision persists across restart");Check(reopened.QuerySearch("Miles").GetArrayLength()==1,"search index persists across restart");}
var corrupt=Path.Combine(parent,"corrupt-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(corrupt);File.WriteAllText(Path.Combine(corrupt,"library.json"),"broken");
Check(Fails(()=>{using var store=new DesktopLibraryStore(corrupt);}),"corrupt legacy catalogue is rejected");Check(!File.Exists(Path.Combine(corrupt,"library.sqlite")),"failed migration never installs an empty replacement");
var corruptDb=Path.Combine(parent,"corruptdb-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(corruptDb);File.WriteAllText(Path.Combine(corruptDb,"library.sqlite"),"broken database");
Check(Fails(()=>{using var store=new DesktopLibraryStore(corruptDb);}),"corrupt SQLite database is rejected without reset");
var backupDirectory=Path.Combine(corruptDb,"backups");Directory.CreateDirectory(backupDirectory);
var goodBackup=Directory.EnumerateFiles(Path.Combine(fixture,"backups"),"daily-*.sqlite").First();
File.Copy(goodBackup,Path.Combine(backupDirectory,"good.sqlite"));
File.WriteAllText(Path.Combine(backupDirectory,"bad.sqlite"),"broken backup");
File.WriteAllText(Path.Combine(corruptDb,"library.sqlite-wal"),"old journal");
File.WriteAllText(Path.Combine(corruptDb,"library.sqlite-shm"),"old shared state");
Check(Fails(()=>DesktopLibraryStore.Recover(corruptDb,"..\\good.sqlite")),"offline recovery rejects traversal");
Check(Fails(()=>DesktopLibraryStore.Recover(corruptDb,"bad.sqlite")),"offline recovery rejects corrupt backups");
Check(File.ReadAllText(Path.Combine(corruptDb,"library.sqlite"))=="broken database","invalid recovery leaves damaged database untouched");
DesktopLibraryStore.Recover(corruptDb,"good.sqlite");
Check(Directory.EnumerateFiles(corruptDb,"library.sqlite",SearchOption.AllDirectories).Any(path=>path.Contains("recovery-before-")),"offline recovery retains displaced database bytes");
Check(Directory.EnumerateFiles(corruptDb,"library.sqlite-wal",SearchOption.AllDirectories).Any(path=>path.Contains("recovery-before-")),"offline recovery retains old journal alongside original database");
using(var recovered=new DesktopLibraryStore(corruptDb)) {Check(recovered.Load().Snapshot.GetProperty("items").GetArrayLength()==2,"offline recovery restores selected catalogue");Check(Fails(()=>DesktopLibraryStore.Recover(corruptDb,"good.sqlite")),"offline recovery cannot replace an open catalogue");}
var scaled=Path.Combine(parent,"scaled-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(scaled);
using(var store=new DesktopLibraryStore(scaled))
{
 Check(store.ListBackups().Count==0,"fresh empty catalogue does not use an empty daily recovery slot");
 var large=JsonNode.Parse("""{"version":1,"fields":[{"id":"archive","name":"Archive","parent":null,"color":"#6384ff"}],"items":[],"memberships":[],"connections":[]}""")!.AsObject();
 for(var index=0;index<5000;index++) {var id="note-"+index;large["items"]!.AsArray().Add(new JsonObject { ["id"]=id,["kind"]="note",["title"]="Recording "+index,["body"]="A catalogue note with searchable musical context "+index });large["memberships"]!.AsArray().Add(new JsonObject { ["itemId"]=id,["fieldId"]="archive" });}
 var started=System.Diagnostics.Stopwatch.StartNew();store.Save(Snapshot(large),0);started.Stop();
 Check(store.QuerySearch("Recording 4999").GetArrayLength()==1,"indexed search returns a specific record in 5000-item catalogue");
 Check(store.ListBackups().Count==1,"first nonempty commit creates a populated daily backup");
 var daily=store.ListBackups()[0].FileName;var folder=Path.Combine(scaled,"backups");
 for(var day=1;day<=9;day++) File.Copy(Path.Combine(folder,daily),Path.Combine(folder,"daily-"+DateTime.UtcNow.AddDays(-day).ToString("yyyy-MM-dd")+".sqlite"));
 large["items"]![4999]!["body"]="Revised searchable context";store.Save(Snapshot(large),1);
 Check(store.ListBackups().Count(backup=>backup.FileName.StartsWith("daily-"))==7,"daily backup retention is bounded to seven snapshots");
 Check(store.QuerySearch("Revised").GetArrayLength()==1,"large-catalogue delta updates search results");
 Console.WriteLine("5000-item initial commit: "+started.ElapsedMilliseconds+" ms");
}
Console.WriteLine($"{count} storage checks passed; fixtures: {fixture}");
