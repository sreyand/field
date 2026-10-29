# Windows desktop package

The first package is a portable Windows x64 ZIP. Extract every file, then run `FIELD.exe`. It opens FIELD in its own window and includes the .NET runtime, so the receiving computer does not need the SDK or Node.js. Microsoft Edge WebView2 Evergreen Runtime remains a prerequisite; the app reports when it is missing. Microsoft documents [WebView2 distribution and runtime detection](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

Build from a source checkout with the .NET 10 SDK:

```powershell
powershell -NoProfile -File scripts/package-windows.ps1
```

The script uses `desktop/global.json`, publishes a self-contained `win-x64` application, copies an explicit list of UI assets into `web/`, includes dependency notices, validates asset hashes and bundled runtime files, and produces:

```text
dist/FIELD-0.2.0-alpha-win-x64/FIELD.exe
dist/FIELD-0.2.0-alpha-win-x64.zip
dist/FIELD-0.2.0-alpha-win-x64.zip.sha256
```

Version `0.2.0-alpha` pins .NET runtime `10.0.14`, which was verified as present in Microsoft's official NuGet feeds for both the [core runtime](https://www.nuget.org/packages/Microsoft.NETCore.App.Runtime.win-x64/10.0.14) and [Windows desktop runtime](https://www.nuget.org/packages/Microsoft.WindowsDesktop.App.Runtime.win-x64/10.0.14). The SDK and WebView2 SDK versions are selected by the desktop project. The package includes neither the user's library nor browser profile. Only the allowlisted web files are copied; source, tests, native-service files, and local data are excluded.

Use `-Version 0.2.1-alpha` for a new package. Use `-Force` to replace a same-version build while retaining prior outputs with `.previous-*` names. Failed build directories remain under `dist/.build-*` for inspection; the script performs no recursive deletes. `-OutputRoot` can select a dedicated output directory. `-RuntimeVersion` selects another available stable .NET 10 servicing release.

The source checkout's `Open FIELD.cmd` launches the current built package. `Open FIELD browser.cmd` explicitly retains the older browser prototype for migrating its library. It is not used by the desktop package.

The indexed catalogue and backups are owned by FIELD at `%LOCALAPPDATA%\FIELD\Desktop`. The SQLite catalogue and native file references persist independently of the extracted application directory. A second launch focuses the existing instance; closing the window ends the app. Bring browser data over through **Library → Export library**, then **Library → Import library** in the desktop app. Import requires an empty desktop library and preserves the browser copy.

The desktop alpha is unsigned and has no automatic updater or installer. To update it, close FIELD, extract a new package into a separate folder, and run its executable. Keep the old app folder until the new build opens the library successfully.

`scripts/create-icon.ps1` generates the Windows icon sizes from the supplied `assets/app-icon.png`. The original full FIELD wordmark used by the interface is unchanged.
