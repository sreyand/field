# FIELD file runtime

Windows 10/11 and the .NET 8 SDK are required to build this source checkout. No external NuGet packages are used.

Double-click `Open FIELD.cmd` in the project root. It builds and starts a hidden loopback service, then opens the existing `index.html` file in the default browser. Keeping that file URL preserves the browser library already associated with it. The runtime capability is passed in a URL fragment; the frontend consumes it into session storage and removes the fragment.

Depending on browser version, its normal loopback/local-network permission prompt may appear when the file page connects to the runtime. Grant access for FIELD if prompted; no browser security flags are required. See [Microsoft Edge's local network access guidance](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access).

The runtime stores only registered file identities and metadata in `%LOCALAPPDATA%\FIELD\file-references.json`. File contents stay in their original locations. The catalogue remains in the browser's IndexedDB. Keep both when backing up this prototype. Moving the FIELD checkout or switching browsers can change which browser catalogue opens.

For development, build from this directory so `global.json` selects the installed .NET 8 SDK:

```powershell
dotnet build Field.Host.csproj --configuration Release
dotnet bin/Release/net8.0-windows/Field.Host.dll --root "C:\path\to\field" --port 4323 --data-dir "C:\path\to\temporary-state"
```

The development HTTP interface has its own browser origin and IndexedDB library. It does not migrate the existing file-URL catalogue. Omit `--open` when running automated checks. The default port is 4321; another instance of this runtime on that port is reused by the launcher. Only one process can own a given metadata directory.

Registered local files on a supported filesystem retain their Windows file ID across renames and moves on that volume. The runtime periodically resolves those IDs; it does not crawl drives or read file contents. Creation time is verified alongside the file ID to avoid adopting a reused ID. Missing files, unavailable drives, permission failures, and replacement files retain the original reference. Moves across volumes and filesystems without stable ID support need explicit relinking. The UI exposes `recoverable: false` for path-only references. Files with multiple hard links may resolve to a different valid path for the same underlying file.

The service binds only `127.0.0.1`, validates Host and Origin, and requires a per-process capability on file APIs. It serves an explicit list of interface assets. Foreign HTTP origins cannot access the APIs, even with a capability. Existing file-URL pages use opaque-Origin CORS only when they hold that capability. This protects the browser boundary; local software running as the same Windows user has the user's normal filesystem access.

Verification:

```powershell
node native/host-smoke.mjs "C:\absolute\disposable-fixture-parent"
```

Run that command from the project root after the Release build. It starts an isolated service on port 4324, uses its own fixture/data subdirectory, checks browser-origin protections and file reference persistence, and stops both test processes. It never opens the file picker or launches a fixture file. Fixtures remain in the supplied parent for inspection.
