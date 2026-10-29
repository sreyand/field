using System.Windows;
using Field.Native;
using Microsoft.Win32;

namespace Field.Desktop;

internal sealed class Program : Application
{
    private SingleInstance? instance;
    private DesktopBackend? backend;
    private DesktopOptions? options;
    private bool startupCompleted;

    [STAThread]
    public static void Main(string[] arguments)
    {
        var app = new Program { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        try
        {
            app.options = DesktopOptions.Parse(arguments);
            app.Run();
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, app.startupCompleted ? "FIELD encountered an error" : "FIELD could not start", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            instance = new SingleInstance(options!.DataDirectory);
            if (!instance.IsPrimary)
            {
                if (!await instance.ActivateExistingAsync())
                    MessageBox.Show("FIELD is already starting. Wait a moment and open it again.", "FIELD", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown();
                return;
            }
            try { backend = new DesktopBackend(options.DataDirectory); }
            catch (Exception error) when (error is IOException or InvalidDataException or Microsoft.Data.Sqlite.SqliteException)
            {
                if (error.Message.Contains("file reference", StringComparison.OrdinalIgnoreCase)) throw;
                var backups = Path.Combine(options.DataDirectory, "backups");
                if (!Directory.Exists(backups) || !Directory.EnumerateFiles(backups, "*.sqlite").Any()) throw;
                if (MessageBox.Show("FIELD could not open its catalogue.\n\n" + error.Message + "\n\nRestore a catalogue backup? The current catalogue is retained and PC files stay untouched.", "FIELD", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) { Shutdown(); return; }
                var picker = new OpenFileDialog { Title = "Restore FIELD catalogue", InitialDirectory = backups, Filter = "FIELD backups (*.sqlite)|*.sqlite", CheckFileExists = true };
                if (picker.ShowDialog() != true) { Shutdown(); return; }
                if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(picker.FileName)), Path.GetFullPath(backups), StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("Choose a backup from FIELD's backups folder.");
                DesktopLibraryStore.Recover(options.DataDirectory, Path.GetFileName(picker.FileName));
                backend = new DesktopBackend(options.DataDirectory);
            }
            var window = new FieldWindow(options, backend);
            MainWindow = window;
            instance.Listen(() => Dispatcher.BeginInvoke(() => window.BringToFront()));
            ShutdownMode = ShutdownMode.OnMainWindowClose;
            window.Show();
            startupCompleted = true;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "FIELD could not start", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        backend?.Dispose();
        instance?.Dispose();
        base.OnExit(e);
    }
}
