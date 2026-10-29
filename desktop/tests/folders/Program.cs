using System.Text.Json;
using System.Text.Json.Nodes;
using Field.Native;

var root = Path.Combine(Path.GetFullPath(args[0]), "folders-" + Guid.NewGuid().ToString("N"));
var data = Path.Combine(root, "data");
var source = Path.Combine(root, "collection");
var nested = Path.Combine(source, "nested");
Directory.CreateDirectory(nested);
var album = Path.Combine(source, "album.txt");
var note = Path.Combine(source, "note.txt");
File.WriteAllText(album, "album"); File.WriteAllText(note, "note"); File.WriteAllText(Path.Combine(nested,"credits.json"), "{}");
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var count = 0;
void Check(bool ok, string label) { if (!ok) throw new Exception("FAIL " + label); Console.WriteLine("PASS " + label); count++; }
async Task<JsonObject> Call(DesktopBackend backend, string method, object args) => JsonSerializer.SerializeToNode(await backend.HandleAsync(method, JsonSerializer.SerializeToElement(args, json)), json)!.AsObject();
JsonArray Items(JsonObject envelope) => envelope["snapshot"]!["items"]!.AsArray();
long Revision(JsonObject envelope) => envelope["revision"]!.GetValue<long>();
JsonObject FileItem(JsonObject envelope, string name) => Items(envelope).OfType<JsonObject>().Single(item => item["fileName"]!.GetValue<string>() == name);
string Id(JsonObject item) => item["id"]!.GetValue<string>();
bool Member(JsonObject envelope, string item, string field) => envelope["snapshot"]!["memberships"]!.AsArray().OfType<JsonObject>().Any(pair => pair["itemId"]!.GetValue<string>() == item && pair["fieldId"]!.GetValue<string>() == field);
long revision;
string albumId;
using (var backend = new DesktopBackend(data))
{
 var tracked = await Call(backend,"files.track",new{path=album});
 var reference = tracked["reference"]!.DeepClone();
 var snapshot = JsonNode.Parse("""{"version":1,"fields":[{"id":"music","name":"Music","color":"#6384ff","parent":null},{"id":"shared","name":"Shared","color":"#80bca3","parent":null}],"items":[],"memberships":[],"connections":[]}""")!.AsObject();
 snapshot["items"]!.AsArray().Add(new JsonObject { ["id"]="curated",["kind"]="file",["title"]="Curated album",["annotation"]="Keep this note",["path"]=album,["fileName"]="album.txt",["native"]=reference });
 snapshot["memberships"]!.AsArray().Add(new JsonObject{["itemId"]="curated",["fieldId"]="shared"});
 await Call(backend,"library.save",new{snapshot,expectedRevision=0});
 var attached = await Call(backend,"folders.attach",new{fieldId="music",path=source,expectedRevision=1});
 Check(Items(attached).Count==3,"recursive folder attaches all files without duplicating an existing canonical file");
 var curated = FileItem(attached,"album.txt"); albumId=Id(curated);
 Check(albumId=="curated" && curated["title"]!.GetValue<string>()=="Curated album" && curated["annotation"]!.GetValue<string>()=="Keep this note","curated ID, name and notes survive attachment");
 Check(Member(attached,albumId,"music") && Member(attached,albumId,"shared"),"attachment preserves existing memberships");
 var repeated=await Call(backend,"folders.sync",new{expectedRevision=Revision(attached),force=true});
 Check(Items(repeated).Count==3 && Revision(repeated)==Revision(attached),"unchanged folder scan does not rewrite catalogue");
 var renamed=Path.Combine(source,"renamed.txt"); File.Move(album,renamed);
 var moved=await Call(backend,"folders.sync",new{expectedRevision=Revision(repeated),force=true});
 Check(Id(FileItem(moved,"renamed.txt"))==albumId && FileItem(moved,"renamed.txt")["title"]!.GetValue<string>()=="Curated album","rename preserves canonical identity and curated name");
 var addedPath=Path.Combine(source,"new.txt"); File.WriteAllText(addedPath,"new");
 var added=await Call(backend,"folders.sync",new{expectedRevision=Revision(moved),force=true});
 Check(Items(added).Count==4,"new source files appear on refresh");
 var noteId=Id(FileItem(added,"note.txt")); File.Delete(note);
 var missing=await Call(backend,"folders.sync",new{expectedRevision=Revision(added),force=true});
 Check(Items(missing).Count==4 && Member(missing,noteId,"music") && FileItem(missing,"note.txt")["native"]!["status"]!.GetValue<string>()!="available","deleted source file stays archived with missing status");
 var edited=missing["snapshot"]!.DeepClone().AsObject();
 edited["fields"]![0]!["folder"]!["excludedItemIds"]!.AsArray().Add(albumId);
 var pair=edited["memberships"]!.AsArray().OfType<JsonObject>().Single(value=>value["itemId"]!.GetValue<string>()==albumId && value["fieldId"]!.GetValue<string>()=="music");edited["memberships"]!.AsArray().Remove(pair);
 var saved=await Call(backend,"library.save",new{snapshot=edited,expectedRevision=Revision(missing)});
 var excluded=await Call(backend,"folders.sync",new{expectedRevision=Revision(saved),force=true});
 Check(!Member(excluded,albumId,"music") && Member(excluded,albumId,"shared"),"manual source exclusion persists without removing other memberships");
 var stale=false;try{await Call(backend,"folders.attach",new{fieldId="shared",path=source,expectedRevision=0});}catch(InvalidOperationException){stale=true;} Check(stale,"stale attach cannot overwrite catalogue");
 var second=await Call(backend,"folders.attach",new{fieldId="shared",path=nested,expectedRevision=Revision(excluded)});
 Check(Items(second).Count==4 && Member(second,Id(FileItem(second,"credits.json")),"shared"),"overlapping linked sources share canonical items");
 File.WriteAllText(Path.Combine(nested,"watcher.txt"),"watcher notification");
 var beforePolling=await Call(backend,"library.load",new{});
 Check(Revision(beforePolling)==Revision(second),"watchers never commit over an active frontend revision");
 for(var attempt=0;attempt<20;attempt++) {
  await Task.Delay(100);
  second=await Call(backend,"folders.sync",new{expectedRevision=Revision(second),force=false});
  if(Items(second).Count==5) break;
 }
 Check(Items(second).Count==5 && Member(second,Id(FileItem(second,"watcher.txt")),"music") && Member(second,Id(FileItem(second,"watcher.txt")),"shared"),"one recursive watcher refreshes overlapping linked sources without a forced rescan");
 var offline=source+"-offline";
 for(var attempt=0;;attempt++) { try { Directory.Move(source,offline);break; } catch(IOException) when(attempt<10) { await Task.Delay(100); } }
 var absent=await Call(backend,"folders.sync",new{expectedRevision=Revision(second),force=true});
 Check(Items(absent).Count==5 && absent["folders"]!.AsArray().Any(status=>status!["status"]!.GetValue<string>()=="unavailable"),"offline source preserves all archived records");
 Directory.Move(offline,source);
 var restored=await Call(backend,"folders.sync",new{expectedRevision=Revision(absent),force=true});
 Check(Items(restored).Count==5 && FileItem(restored,"renamed.txt")["native"]!["status"]!.GetValue<string>()=="available","returning source recovers original items");
 revision=Revision(restored);
}
using(var backend=new DesktopBackend(data))
{
 var reopened=await Call(backend,"folders.sync",new{expectedRevision=revision,force=true});
 Check(Items(reopened).Count==5 && !Member(reopened,albumId,"music"),"restart preserves linked metadata and exclusions");
 var detached=await Call(backend,"folders.detach",new{fieldId="music",expectedRevision=Revision(reopened)});
 Check(detached["snapshot"]!["fields"]![0]!["folder"] is null && Items(detached).Count==5 && File.Exists(Path.Combine(source,"renamed.txt")),"detach keeps archived records and source files");
}
Console.WriteLine($"{count} folder checks passed. Fixture: {root}");
