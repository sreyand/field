using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Field.Native;

internal static class SqliteCatalogue
{
    public static void Initialize(SqliteConnection connection)=>Execute(connection,"""
        PRAGMA user_version=1;
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO metadata VALUES('revision','0'),('extra','{}');
        CREATE TABLE fields(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,name TEXT NOT NULL,parent TEXT,payload TEXT NOT NULL);
        CREATE INDEX fields_parent ON fields(parent);
        CREATE TABLE items(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,path TEXT,native_key TEXT,payload TEXT NOT NULL);
        CREATE INDEX items_kind ON items(kind); CREATE INDEX items_path ON items(path COLLATE NOCASE); CREATE INDEX items_identity ON items(native_key);
        CREATE TABLE memberships(item_id TEXT NOT NULL REFERENCES items(id) DEFERRABLE INITIALLY DEFERRED,field_id TEXT NOT NULL REFERENCES fields(id) DEFERRABLE INITIALLY DEFERRED,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(item_id,field_id));
        CREATE INDEX memberships_field ON memberships(field_id,item_id);
        CREATE TABLE connections(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX connections_from ON connections(from_id); CREATE INDEX connections_to ON connections(to_id);
        CREATE VIRTUAL TABLE search_documents USING fts5(kind UNINDEXED,id UNINDEXED,title,preview,tokenize='unicode61');
        CREATE TABLE search_keys(document_rowid INTEGER PRIMARY KEY,kind TEXT NOT NULL,id TEXT NOT NULL,UNIQUE(kind,id));
        """);

    public static LibraryEnvelope Read(SqliteConnection connection)
    {
        using var command=connection.CreateCommand(); command.CommandText="SELECT value FROM metadata WHERE key='revision'";
        if(!long.TryParse(command.ExecuteScalar()?.ToString(),out var revision)||revision<0||revision>9007199254740991) throw new InvalidDataException("Invalid catalogue revision.");
        command.CommandText="SELECT value FROM metadata WHERE key='extra'";
        using var extra=JsonDocument.Parse(command.ExecuteScalar()?.ToString()??"{}");
        foreach(var table in new[]{"fields","items","memberships","connections"})
        {
            command.CommandText=$"SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM {table}";
            if(Convert.ToInt64(command.ExecuteScalar())>LibrarySnapshot.MaximumBytes) throw new InvalidDataException("The saved catalogue exceeds this alpha's 64 MB limit.");
        }
        using var memory=new MemoryStream();
        using(var writer=new Utf8JsonWriter(memory))
        {
            writer.WriteStartObject(); writer.WriteNumber("version",1);
            foreach(var property in extra.RootElement.EnumerateObject()) property.WriteTo(writer);
            foreach(var table in new[]{"fields","items","memberships","connections"})
            {
                writer.WritePropertyName(table); writer.WriteStartArray(); command.CommandText=$"SELECT payload FROM {table} ORDER BY ordinal";
                using var reader=command.ExecuteReader();
                while(reader.Read()) { using var record=JsonDocument.Parse(reader.GetString(0)); record.RootElement.WriteTo(writer); }
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
        }
        using var snapshot=JsonDocument.Parse(memory.ToArray()); LibrarySnapshot.Validate(snapshot.RootElement);
        return new(revision,snapshot.RootElement.Clone());
    }

    public static void Write(SqliteConnection connection,JsonElement snapshot,long revision)
    {
        using var transaction=connection.BeginTransaction();
        foreach(var table in new[]{"fields","items","memberships","connections"})
        {
            var old=new Dictionary<string,(string Payload,long Ordinal)>();
            using(var read=connection.CreateCommand())
            {
                read.Transaction=transaction; read.CommandText=table=="memberships" ? "SELECT item_id || ':' || field_id,payload,ordinal FROM memberships" : $"SELECT id,payload,ordinal FROM {table}";
                using var reader=read.ExecuteReader(); while(reader.Read()) old.Add(reader.GetString(0),(reader.GetString(1),reader.GetInt64(2)));
            }
            var ordinal=0L;
            foreach(var record in snapshot.GetProperty(table).EnumerateArray())
            {
                var id=table=="memberships" ? Text(record,"itemId")+":"+Text(record,"fieldId") : Text(record,"id"); var payload=record.GetRawText();
                if(old.Remove(id,out var previous)&&previous.Payload==payload&&previous.Ordinal==ordinal) { ordinal++; continue; }
                using var write=connection.CreateCommand(); write.Transaction=transaction;
                write.Parameters.AddWithValue("$ordinal",ordinal++); write.Parameters.AddWithValue("$payload",payload);
                if(table!="memberships") write.Parameters.AddWithValue("$id",id);
                switch(table)
                {
                    case "fields":
                        write.CommandText="INSERT INTO fields VALUES($id,$ordinal,$name,$parent,$payload) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,name=excluded.name,parent=excluded.parent,payload=excluded.payload";
                        write.Parameters.AddWithValue("$name",Text(record,"name")); write.Parameters.AddWithValue("$parent",Value(record,"parent")); break;
                    case "items":
                        write.CommandText="INSERT INTO items VALUES($id,$ordinal,$kind,$title,$path,$native,$payload) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,kind=excluded.kind,title=excluded.title,path=excluded.path,native_key=excluded.native_key,payload=excluded.payload";
                        write.Parameters.AddWithValue("$kind",Text(record,"kind")); write.Parameters.AddWithValue("$title",Text(record,"title")); write.Parameters.AddWithValue("$path",record.TryGetProperty("path",out var itemPath)&&itemPath.ValueKind==JsonValueKind.String&&!string.IsNullOrWhiteSpace(itemPath.GetString()) ? LibrarySnapshot.WindowsPath(itemPath.GetString()!) : DBNull.Value);
                        write.Parameters.AddWithValue("$native",record.TryGetProperty("native",out var native)&&native.ValueKind==JsonValueKind.Object ? FileReferenceService.TargetKey(LibrarySnapshot.DeserializeReference(native)) : DBNull.Value); break;
                    case "memberships":
                        write.CommandText="INSERT INTO memberships VALUES($item,$field,$ordinal,$payload) ON CONFLICT(item_id,field_id) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload";
                        write.Parameters.AddWithValue("$item",Text(record,"itemId")); write.Parameters.AddWithValue("$field",Text(record,"fieldId")); break;
                    case "connections":
                        write.CommandText="INSERT INTO connections VALUES($id,$ordinal,$from,$to,$payload) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,from_id=excluded.from_id,to_id=excluded.to_id,payload=excluded.payload";
                        write.Parameters.AddWithValue("$from",Text(record,"from")); write.Parameters.AddWithValue("$to",Text(record,"to")); break;
                }
                write.ExecuteNonQuery();
                if(table is "fields" or "items")
                {
                    using var search=connection.CreateCommand(); search.Transaction=transaction;
                    search.CommandText="INSERT OR IGNORE INTO search_keys(kind,id) VALUES($kind,$id); DELETE FROM search_documents WHERE rowid=(SELECT document_rowid FROM search_keys WHERE kind=$kind AND id=$id); INSERT INTO search_documents(rowid,kind,id,title,preview) SELECT document_rowid,$kind,$id,$title,$preview FROM search_keys WHERE kind=$kind AND id=$id";
                    search.Parameters.AddWithValue("$kind",table=="fields" ? "field" : "item"); search.Parameters.AddWithValue("$id",id);
                    search.Parameters.AddWithValue("$title",Text(record,table=="fields" ? "name" : "title")); search.Parameters.AddWithValue("$preview",SearchText(record)); search.ExecuteNonQuery();
                }
            }
            foreach(var id in old.Keys)
            {
                using var remove=connection.CreateCommand(); remove.Transaction=transaction;
                if(table=="memberships") { var pair=id.Split(':'); remove.CommandText="DELETE FROM memberships WHERE item_id=$item AND field_id=$field"; remove.Parameters.AddWithValue("$item",pair[0]); remove.Parameters.AddWithValue("$field",pair[1]); }
                else { remove.CommandText=$"DELETE FROM {table} WHERE id=$id"; remove.Parameters.AddWithValue("$id",id); }
                remove.ExecuteNonQuery();
                if(table is "fields" or "items") { remove.CommandText="DELETE FROM search_documents WHERE rowid=(SELECT document_rowid FROM search_keys WHERE kind=$kind AND id=$id); DELETE FROM search_keys WHERE kind=$kind AND id=$id"; remove.Parameters.AddWithValue("$kind",table=="fields" ? "field" : "item"); remove.ExecuteNonQuery(); }
            }
        }
        using var metadata=connection.CreateCommand(); metadata.Transaction=transaction;
        metadata.CommandText="UPDATE metadata SET value=$revision WHERE key='revision'; UPDATE metadata SET value=$extra WHERE key='extra'";
        metadata.Parameters.AddWithValue("$revision",revision.ToString(System.Globalization.CultureInfo.InvariantCulture));
        metadata.Parameters.AddWithValue("$extra",JsonSerializer.Serialize(snapshot.EnumerateObject().Where(property=>property.Name is not ("version" or "fields" or "items" or "memberships" or "connections")).ToDictionary(property=>property.Name,property=>property.Value),DesktopLibraryStore.Json));
        metadata.ExecuteNonQuery(); transaction.Commit();
    }
    private static string SearchText(JsonElement record)=>string.Join(" ",new[]{"name","title","body","path","fileName","url","annotation"}.Where(name=>record.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String).Select(name=>record.GetProperty(name).GetString()));
    private static string Text(JsonElement record,string name)=>record.GetProperty(name).GetString()!;
    private static object Value(JsonElement record,string name)=>record.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String ? value.GetString()! : DBNull.Value;
    public static void Execute(SqliteConnection connection,string sql) { using var command=connection.CreateCommand(); command.CommandText=sql; command.ExecuteNonQuery(); }
}
