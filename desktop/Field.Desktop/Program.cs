using System.Windows;
using Field.Native;

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
            backend = new DesktopBackend(options.DataDirectory);
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
