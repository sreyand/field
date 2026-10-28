using Field.Native;
using System.IO;
using Field.Desktop;
using System.Text.Json;
using System.Windows.Media;
using System.Windows.Media.Imaging;

var root = Path.Combine(Path.GetFullPath(args[0]), "preview-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var imagePath = Path.Combine(root, "Landscape.png");
var pixels = new byte[2000 * 1000 * 4];
for (var i = 0; i < pixels.Length; i += 4) { pixels[i] = 100; pixels[i+1] = 190; pixels[i+2] = 80; pixels[i+3] = 255; }
var source = BitmapSource.Create(2000, 1000, 96, 96, PixelFormats.Bgra32, null, pixels, 8000);
var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(source));
using (var stream = File.Create(imagePath)) encoder.Save(stream);
using var files = new FileReferenceService(root);
var reference = files.Track(imagePath);
var originalBytes = File.ReadAllBytes(imagePath);
JsonElement Preview(NativeReference record) => JsonSerializer.SerializeToElement(ImagePreview.Create(record));
void Check(bool condition, string name) { if (!condition) throw new Exception(name); Console.WriteLine("PASS " + name); }
var result = Preview(reference);
Check(result.GetProperty("available").GetBoolean(), "registered image decodes");
Check(result.GetProperty("width").GetInt32() == 2000 && result.GetProperty("height").GetInt32() == 1000, "original dimensions retained");
using (var bytes = new MemoryStream(Convert.FromBase64String(result.GetProperty("dataUrl").GetString()!.Split(',')[1]))) {
    var frame = BitmapDecoder.Create(bytes, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames[0];
    Check(frame.PixelWidth == 1200 && frame.PixelHeight == 600, "preview downsampled with correct aspect ratio");
}
Check(!Preview(reference with {Status="missing"}).GetProperty("available").GetBoolean(), "missing reference cannot read stale path");
Check(!Preview(reference with {Status="replaced"}).GetProperty("available").GetBoolean(), "replacement file is not previewed");
var corrupt = Path.Combine(root,"Corrupt.jpg"); File.WriteAllText(corrupt,"not an image");
Check(!Preview(reference with {Path=corrupt}).GetProperty("available").GetBoolean(), "corrupt image falls back safely");
var svg = Path.Combine(root,"Unsafe.svg"); File.WriteAllText(svg,"<svg/>");
Check(!Preview(reference with {Path=svg}).GetProperty("available").GetBoolean(), "active vector formats are excluded");
var large = Path.Combine(root,"Large.png"); using(var stream=File.Create(large)) stream.SetLength(65L*1024*1024);
Check(!Preview(reference with {Path=large}).GetProperty("available").GetBoolean(), "oversized files are bounded before decoding");
using var library = new DesktopLibraryStore(root);
var snapshot = JsonSerializer.SerializeToElement(new {
 version=1, fields=new[]{new{id="qa-images",name="Images",parent=(string?)null,color="#6384ff"}},
 items=new[]{new{id="qa-image",kind="file",title="Landscape",path=reference.Path,fileName=reference.FileName,size=reference.Size,native=reference}},
 memberships=new[]{new{itemId="qa-image",fieldId="qa-images"}}, connections=Array.Empty<object>()
}, new JsonSerializerOptions(JsonSerializerDefaults.Web));
library.Save(snapshot,0);
Check(File.ReadAllBytes(imagePath).SequenceEqual(originalBytes), "preview leaves source bytes unchanged");
Console.WriteLine("QA_DATA="+root);
