using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Field.Desktop;

internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex mutex;
    private readonly string pipeName;
    private readonly CancellationTokenSource stopping = new();
    private Task? listener;
    public bool IsPrimary { get; }

    public SingleInstance(string dataDirectory)
    {
        using var identityToken = WindowsIdentity.GetCurrent();
        var user = identityToken.User?.Value ?? Environment.UserName;
        var identity = user + "|" + Path.GetFullPath(dataDirectory).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
        var suffix = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..32];
        pipeName = "FIELD.Desktop." + suffix;
        mutex = new Mutex(initiallyOwned: true, "Local\\" + pipeName, out var created);
        if (created) IsPrimary = true;
        else
        {
            try { IsPrimary = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { IsPrimary = true; }
        }
    }

    public async Task<bool> ActivateExistingAsync()
    {
        // The first process may still be creating its window and pipe.
        for (var attempt = 0; attempt < 12; attempt++)
        {
            using var connection = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await connection.ConnectAsync(400);
                await connection.WriteAsync("activate\n"u8.ToArray());
                await connection.FlushAsync();
                return true;
            }
            catch (Exception error) when (error is TimeoutException or IOException) { }
            await Task.Delay(100);
        }
        return false;
    }

    public void Listen(Action activate)
    {
        if (!IsPrimary) throw new InvalidOperationException("Only the primary FIELD instance can listen.");
        var cancellation = stopping.Token;
        listener = Task.Run(async () =>
        {
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    using var connection = new NamedPipeServerStream(pipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await connection.WaitForConnectionAsync(cancellation);
                    using var incoming = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    incoming.CancelAfter(TimeSpan.FromSeconds(2));
                    var buffer = new byte[9];
                    await connection.ReadExactlyAsync(buffer, incoming.Token);
                    if (Encoding.UTF8.GetString(buffer) == "activate\n") activate();
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
                catch (OperationCanceledException) { }
                catch (IOException) { }
            }
        });
    }

    public void Dispose()
    {
        stopping.Cancel();
        try { listener?.Wait(TimeSpan.FromSeconds(2)); }
        catch (AggregateException) { /* Process shutdown still releases the instance gate. */ }
        if (IsPrimary) mutex.ReleaseMutex();
        mutex.Dispose();
        stopping.Dispose();
    }
}
