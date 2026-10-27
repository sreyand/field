using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Field.Native;

public sealed record FileIdentityRecord(string VolumeSerial, string FileId, string VolumePath, string CreationTime);
public sealed record FileProbe(string Status, string? Path, string? FileName, long? Size,
    string? ModifiedUtc, FileIdentityRecord? Identity, bool Recoverable, string? Message);

/// <summary>Metadata-only identity lookup. No directory walks or long-lived handles.</summary>
public static class NativeFileIdentity
{
    private const uint ShareAll = 7, OpenExisting = 3;
    private const uint MetadataFlags = 0x02000000 | 0x00100000;
    private const uint SupportsOpenById = 0x01000000;

    public static FileProbe Inspect(string path)
    {
        if (!OperatingSystem.IsWindows()) return Failed("unsupported", path, "File tracking requires Windows.");
        try
        {
            path = AbsolutePath(path);
            using var handle = CreateFileW(path, 0, ShareAll, IntPtr.Zero, OpenExisting, MetadataFlags, IntPtr.Zero);
            if (handle.IsInvalid) return PathFailure(path, Marshal.GetLastWin32Error());
            return ReadHandle(handle, path);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return Failed("unsupported", path, "Enter an absolute Windows file path.");
        }
    }

    public static FileProbe Resolve(FileIdentityRecord identity, string lastPath)
    {
        if (!ValidIdentity(identity)) return Failed("unsupported", lastPath, "This reference needs relinking.", identity);
        var current = Inspect(lastPath);
        if (SameIdentity(current.Identity, identity)) return current;

        // Network shares and filesystems without persistent IDs keep a path reference only.
        if (!IsVolumeGuid(identity.VolumePath))
            return Failed(current.Status == "available" ? "replaced" : current.Status, lastPath,
                current.Status == "available" ? "A different file is at this path. Relink the original." : current.Message,
                identity, false);

        using var volume = CreateFileW(identity.VolumePath, 0, ShareAll, IntPtr.Zero, OpenExisting, MetadataFlags, IntPtr.Zero);
        if (volume.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            return Failed(error is 5 or 32 or 33 ? "inaccessible" : "unavailable", lastPath,
                error is 5 or 32 or 33 ? "FIELD cannot access this drive." : "This drive is unavailable.", identity, true);
        }

        // Refuse a mismatched volume even if its mount path was reused.
        if (!GetFileInformationByHandleEx(volume, 18, out FileIdInfo volumeInfo, (uint)Marshal.SizeOf<FileIdInfo>()) ||
            volumeInfo.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture) != identity.VolumeSerial)
            return Failed("unavailable", lastPath, "The original drive is unavailable.", identity, true);

        var bytes = Convert.FromHexString(identity.FileId);
        var descriptor = new FileIdDescriptor
        {
            Size = 24, Type = 2,
            Low = BitConverter.ToUInt64(bytes, 0), High = BitConverter.ToUInt64(bytes, 8)
        };
        using var extended = OpenFileById(volume, ref descriptor, 0, ShareAll, IntPtr.Zero, MetadataFlags);
        var errorCode = extended.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        if (!extended.IsInvalid) return Verify(ReadHandle(extended, lastPath), identity, lastPath);

        // NTFS exposes its 64-bit ID through FileIdInfo but may reject ExtendedFileIdType.
        if (descriptor.High == 0 && errorCode is 1 or 50 or 87)
        {
            descriptor.Type = 0;
            using var standard = OpenFileById(volume, ref descriptor, 0, ShareAll, IntPtr.Zero, MetadataFlags);
            if (!standard.IsInvalid) return Verify(ReadHandle(standard, lastPath), identity, lastPath);
            errorCode = Marshal.GetLastWin32Error();
        }

        if (current.Status == "available")
            return Failed("replaced", lastPath, "A different file is at this path. Relink the original.", identity, true);
        // NTFS can report ERROR_INVALID_PARAMETER for an ID whose MFT entry was deleted.
        // This is different from a filesystem that never supported opening by ID.
        var volumeFileSystem = new StringBuilder(64);
        var knownIdVolume = GetVolumeInformationByHandleW(volume, null, 0, out _, out _, out var volumeFlags,
            volumeFileSystem, (uint)volumeFileSystem.Capacity) && (volumeFlags & SupportsOpenById) != 0 &&
            volumeFileSystem.ToString().Equals("NTFS", StringComparison.OrdinalIgnoreCase);
        if (errorCode == 87 && knownIdVolume)
            return Failed("missing", lastPath, "File not found on its original drive.", identity, true);
        return errorCode switch
        {
            2 or 3 => Failed("missing", lastPath, "File not found on its original drive.", identity, true),
            5 or 32 or 33 => Failed("inaccessible", lastPath, "FIELD cannot access this file.", identity, true),
            1 or 50 or 87 => Failed("unsupported", lastPath, "This drive requires manual relinking.", identity, false),
            _ => Failed("unavailable", lastPath, "This file is currently unavailable.", identity, true)
        };
    }

    public static bool SameIdentity(FileIdentityRecord? left, FileIdentityRecord? right) =>
        left is not null && right is not null && left.VolumeSerial == right.VolumeSerial &&
        left.FileId == right.FileId && left.CreationTime == right.CreationTime;

    private static FileProbe Verify(FileProbe probe, FileIdentityRecord identity, string lastPath)
    {
        if (probe.Status != "available") return probe with { Identity = identity };
        return SameIdentity(probe.Identity, identity) ? probe :
            Failed("missing", lastPath, "The original file no longer exists. Relink a file to continue.", identity, true);
    }

    private static FileProbe ReadHandle(SafeFileHandle handle, string fallbackPath)
    {
        if (!GetFileInformationByHandle(handle, out var info))
            return PathFailure(fallbackPath, Marshal.GetLastWin32Error());
        if ((info.FileAttributes & 0x10) != 0)
            return Failed("unsupported", fallbackPath, "Choose a file rather than a folder.");

        var path = FinalPath(handle, 0) ?? fallbackPath;
        var volumePath = VolumeRoot(FinalPath(handle, 1)) ?? WindowsRoot(path);
        FileIdentityRecord? identity = null;
        if (GetFileInformationByHandleEx(handle, 18, out FileIdInfo idInfo, (uint)Marshal.SizeOf<FileIdInfo>()))
        {
            var fileId = Convert.ToHexString(BitConverter.GetBytes(idInfo.Low).Concat(BitConverter.GetBytes(idInfo.High)).ToArray()).ToLowerInvariant();
            identity = new(idInfo.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture), fileId,
                volumePath, info.CreationTime.ToInt64().ToString(CultureInfo.InvariantCulture));
        }
        var fsName = new StringBuilder(64);
        var supportsIds = GetVolumeInformationByHandleW(handle, null, 0, out _, out _, out var flags, fsName, (uint)fsName.Capacity)
            && (flags & SupportsOpenById) != 0;
        var recoverable = identity is not null && IsVolumeGuid(volumePath) && supportsIds;
        var size = checked(((long)info.FileSizeHigh << 32) | info.FileSizeLow);
        string? modified = null;
        try { modified = DateTime.FromFileTimeUtc(info.LastWriteTime.ToInt64()).ToString("O", CultureInfo.InvariantCulture); }
        catch (ArgumentOutOfRangeException) { }
        return new("available", path, Path.GetFileName(path), size, modified, identity, recoverable,
            recoverable ? null : "Automatic move tracking is unavailable on this drive.");
    }

    private static FileProbe PathFailure(string path, int error)
    {
        if (error is 2 or 3)
        {
            // A missing directory on a disconnected drive is not evidence of deletion.
            var root = WindowsRoot(path);
            using var volume = CreateFileW(root, 0, ShareAll, IntPtr.Zero, OpenExisting, MetadataFlags, IntPtr.Zero);
            if (volume.IsInvalid) return Failed("unavailable", path, "This drive is unavailable.");
            return Failed("missing", path, "File not found.");
        }
        return error switch
        {
            5 or 32 or 33 => Failed("inaccessible", path, "FIELD cannot access this file."),
            1 or 50 or 87 or 123 => Failed("unsupported", path, "This path cannot be tracked."),
            _ => Failed("unavailable", path, "This file or drive is currently unavailable.")
        };
    }

    private static FileProbe Failed(string status, string? path, string? message,
        FileIdentityRecord? identity = null, bool recoverable = false) =>
        new(status, path, string.IsNullOrEmpty(path) ? null : Path.GetFileName(path), null, null, identity, recoverable, message);

    private static string AbsolutePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) throw new ArgumentException("Absolute path required.");
        path = path.Trim();
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path[8..];
        else if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) && path.Length > 6 && path[5] == ':') path = path[4..];
        if (path.StartsWith(@"\\.\", StringComparison.Ordinal) || path.StartsWith(@"\\?\", StringComparison.Ordinal))
            throw new ArgumentException("Device paths are not supported.");
        var fullPath = Path.GetFullPath(path);
        var root = WindowsRoot(fullPath);
        if (fullPath[root.Length..].Contains(':')) throw new ArgumentException("Alternate streams are not supported.");
        return fullPath;
    }

    private static bool ValidIdentity(FileIdentityRecord? identity) => identity is not null &&
        IsHex(identity.VolumeSerial, 16) && IsHex(identity.FileId, 32) &&
        long.TryParse(identity.CreationTime, NumberStyles.None, CultureInfo.InvariantCulture, out var time) && time >= 0 &&
        !string.IsNullOrEmpty(identity.VolumePath);
    private static bool IsHex(string text, int length) => text is not null && text.Length == length && text.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool IsVolumeGuid(string path) => path is not null && path.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase)
        && path.EndsWith(@"}\", StringComparison.Ordinal) && Guid.TryParse(path[10..^1], out _);
    private static string WindowsRoot(string path) => Path.GetPathRoot(path) ?? path;
    private static string? VolumeRoot(string? path)
    {
        if (path is null || !path.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase)) return null;
        var end = path.IndexOf(@"}\", StringComparison.Ordinal);
        return end < 0 ? null : path[..(end + 2)];
    }
    private static string? FinalPath(SafeFileHandle handle, uint flags)
    {
        var buffer = new StringBuilder(512);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, flags);
        if (length == 0) return null;
        if (length >= buffer.Capacity)
        {
            buffer = new StringBuilder(checked((int)length + 1));
            length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, flags);
            if (length == 0 || length >= buffer.Capacity) return null;
        }
        var path = buffer.ToString();
        if (flags == 0)
        {
            if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..];
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal) && path.Length > 6 && path[5] == ':') return path[4..];
        }
        return path;
    }

    [StructLayout(LayoutKind.Sequential)] private struct FileIdInfo { public ulong VolumeSerialNumber, Low, High; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct FileIdDescriptor
    {
        [FieldOffset(0)] public uint Size;
        [FieldOffset(4)] public uint Type;
        [FieldOffset(8)] public ulong Low;
        [FieldOffset(16)] public ulong High;
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime
    {
        public uint Low, High;
        public readonly long ToInt64() => ((long)High << 32) | Low;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime, LastAccessTime, LastWriteTime;
        public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenFileById(SafeFileHandle volume, ref FileIdDescriptor descriptor, uint access, uint share, IntPtr security, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileIdInfo information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder? name, uint nameSize,
        out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder? fileSystem, uint fileSystemSize);
}
