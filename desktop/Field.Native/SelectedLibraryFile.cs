using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

[assembly: InternalsVisibleTo("Field.BackendSmoke")]

namespace Field.Native;

internal sealed record SelectedLibraryText(string Text, string FileName);

/// <summary>Reads only the JSON path returned by the owned import picker; never exposed as a path-based RPC.</summary>
internal static class SelectedLibraryFile
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public static async Task<SelectedLibraryText> ReadAsync(string selectedPath)
    {
        if (!Path.IsPathFullyQualified(selectedPath) || !Path.GetExtension(selectedPath).Equals(".json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Choose a FIELD library JSON export.");
        await using var stream = new FileStream(selectedPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length > LibrarySnapshot.MaximumBytes) throw TooLarge();
        using var bytes = new MemoryStream((int)Math.Min(stream.Length, 1024 * 1024));
        var buffer = new byte[65536];
        while (true)
        {
            // Check the bytes actually read too, so size is bounded even if a source changes.
            var capacity = (int)Math.Min(buffer.Length, LibrarySnapshot.MaximumBytes - bytes.Length + 1);
            var read = await stream.ReadAsync(buffer.AsMemory(0, capacity)).ConfigureAwait(false);
            if (read == 0) break;
            if (bytes.Length + read > LibrarySnapshot.MaximumBytes) throw TooLarge();
            bytes.Write(buffer.AsSpan(0, read));
        }
        string text;
        try { text = Utf8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length); }
        catch (DecoderFallbackException error) { throw new InvalidDataException("Choose a UTF-8 FIELD library export.", error); }
        if (text.StartsWith('\uFEFF')) text = text[1..];
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 128 });
            var archive = document.RootElement;
            if (archive.ValueKind != JsonValueKind.Object ||
                !archive.TryGetProperty("format", out var format) || format.ValueKind != JsonValueKind.String || format.GetString() != "FIELD.library" ||
                !archive.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var schema) || schema != 1 ||
                !archive.TryGetProperty("snapshot", out var snapshot) || snapshot.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("Choose a FIELD library export with a supported format.");
        }
        catch (JsonException error) { throw new InvalidDataException("This file is not valid JSON.", error); }
        return new SelectedLibraryText(text, Path.GetFileName(selectedPath));
    }

    private static InvalidDataException TooLarge() => new("This library exceeds the 64 MB import limit for this alpha.");
}
