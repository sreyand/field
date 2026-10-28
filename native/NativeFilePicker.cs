using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Field.Native;

public static class NativeFilePicker
{
    private static readonly SemaphoreSlim PickerGate = new(1, 1);

    public static async Task<string?> Pick(nint ownerWindow = default, string? filter = null, string? title = null)
    {
        var dialogFilter = filter ?? "All files\0*.*\0\0";
        var dialogTitle = title ?? "Choose a file for FIELD";
        if (!dialogFilter.EndsWith("\0\0", StringComparison.Ordinal) || dialogFilter.Length > 4096 || dialogTitle.Contains('\0'))
            throw new ArgumentException("Invalid file picker options.");
        if (!await PickerGate.WaitAsync(0)) throw new InvalidOperationException("A file picker is already open.");
        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            var fileBuffer = IntPtr.Zero;
            try
            {
                fileBuffer = Marshal.AllocHGlobal(32768 * sizeof(char));
                Marshal.WriteInt16(fileBuffer, 0);
                var dialog = new OpenFileName
                {
                    StructSize = Marshal.SizeOf<OpenFileName>(),
                    Owner = ownerWindow,
                    Filter = dialogFilter,
                    File = fileBuffer,
                    MaxFile = 32768,
                    Title = dialogTitle,
                    Flags = 0x00080000 | 0x00001000 | 0x00000800 | 0x00000008 | 0x00000004
                };
                if (GetOpenFileName(ref dialog)) completion.SetResult(Marshal.PtrToStringUni(fileBuffer));
                else
                {
                    var error = CommDlgExtendedError();
                    if (error == 0) completion.SetResult(null);
                    else completion.SetException(new Win32Exception((int)error, "The file picker could not open."));
                }
            }
            catch (Exception error) { completion.SetException(error); }
            finally
            {
                if (fileBuffer != IntPtr.Zero) Marshal.FreeHGlobal(fileBuffer);
                PickerGate.Release();
            }
        }) { IsBackground = true, Name = "FIELD file picker" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return await completion.Task;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OpenFileName
    {
        public int StructSize;
        public IntPtr Owner;
        public IntPtr Instance;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Filter;
        public IntPtr CustomFilter;
        public int MaxCustomFilter;
        public int FilterIndex;
        public IntPtr File;
        public int MaxFile;
        public IntPtr FileTitle;
        public int MaxFileTitle;
        public IntPtr InitialDirectory;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Title;
        public int Flags;
        public short FileOffset;
        public short FileExtension;
        public IntPtr DefaultExtension;
        public IntPtr CustomData;
        public IntPtr Hook;
        public IntPtr TemplateName;
        public IntPtr Reserved;
        public int Reserved2;
        public int FlagsEx;
    }

    [DllImport("comdlg32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOpenFileName(ref OpenFileName dialog);
    [DllImport("comdlg32.dll")] private static extern uint CommDlgExtendedError();
}
