namespace Field.Desktop;

internal sealed record DesktopOptions(string DataDirectory, string AssetsDirectory)
{
    public static DesktopOptions Parse(string[] arguments)
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FIELD", "Desktop");
        var assets = Path.Combine(AppContext.BaseDirectory, "web");
        for (var index = 0; index < arguments.Length; index++)
        {
            switch (arguments[index])
            {
                case "--data-dir":
                    data = AbsoluteValue(arguments, ref index, "--data-dir");
                    break;
                case "--assets-dir":
                    assets = AbsoluteValue(arguments, ref index, "--assets-dir");
                    break;
                default: throw new ArgumentException($"Unknown option: {arguments[index]}");
            }
        }
        data = Path.TrimEndingDirectorySeparator(Path.GetFullPath(data));
        assets = Path.TrimEndingDirectorySeparator(Path.GetFullPath(assets));
        if (!File.Exists(Path.Combine(assets, "index.html")))
            throw new FileNotFoundException("FIELD's interface files are missing. Extract the complete package before opening FIELD.exe.");
        return new DesktopOptions(data, assets);
    }

    private static string AbsoluteValue(string[] arguments, ref int index, string option)
    {
        if (++index >= arguments.Length || string.IsNullOrWhiteSpace(arguments[index]) || !Path.IsPathFullyQualified(arguments[index]))
            throw new ArgumentException($"{option} requires an absolute directory path.");
        return arguments[index];
    }
}
