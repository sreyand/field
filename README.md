# FIELD

A Windows filesystem wrapper and personal archive. Fresh libraries start empty. DM Sans is bundled locally, with light/dark themes and square, borderless surfaces.

Double-click **Open FIELD.cmd**. Windows and the **.NET 8 SDK** are required for this source checkout. The launcher builds a small local runtime without external NuGet dependencies, then opens the existing interface in your default browser. Opening `index.html` directly still supports the browser-only archive; tracked Windows files need the launcher running.

Create fields and subfields, then add links, files, notes, and drawings. **Add → Existing item** puts the same item in another field. Edits apply everywhere. **Fields → Manage** changes memberships; removing every membership keeps the item under **FIELD logo → Items**. Shared items create connections in the map, alongside manually labeled connections.

Feature 2 adds native file references:

- **Choose file** uses the Windows chooser and records its full path. You can also enter a PC path.
- Supported local files retain their identity across renames and moves on the same volume. FIELD checks registered references periodically while visible and updates their paths. Custom item names and field memberships remain intact.
- Missing files, offline drives, access failures, and files replaced at the old path have distinct states. Unavailable references keep their original identity and metadata.
- **Relink** chooses a new target for the existing item. It preserves the item ID, name, other content, and memberships. A target already archived as another item is rejected instead of overwriting either record.
- **Open file** resolves the registered reference before asking Windows to open it.

Automatic recovery is verified on local NTFS. Moving across volumes needs relinking. Filesystems without stable ID support are labeled **Path only**; they cannot guarantee identity when a path is reused. Older browser-only references need **Track file** to bind a real Windows file. FIELD does not crawl drives, copy selected files, upload their contents, or prevent Windows from moving/deleting them.

The catalogue (fields, notes, links, drawings, memberships, connections) remains in IndexedDB for the same browser and location. Native file identities and metadata are saved separately in `%LOCALAPPDATA%\FIELD\file-references.json`. Keep both for backups. Switching browsers, clearing browser storage, or moving this checkout can change which browser catalogue opens. Saves reject stale windows rather than overwrite newer changes.

The launcher preserves the existing file-URL catalogue. A browser may ask for local-network access when that page connects to the runtime. Reopening the launcher reconnects an expired runtime session. The runtime binds only to `127.0.0.1` and protects file operations with a per-process capability. See [native/README.md](native/README.md) for launch, storage, and development details.

Verification:

```powershell
node --test tests/library-model.test.js
cd native
dotnet build Field.Host.csproj --configuration Release
cd ..
node native/host-smoke.mjs "C:\absolute\disposable-fixture-parent"
cd tests/native
dotnet run -- "C:\absolute\disposable-fixture-parent"
```

Tests cover canonical records, memberships, native identity/relink validation, real Windows renames and moves, saved identity recovery, missing/replaced files, registry persistence, and local API boundaries. Browser checks cover adding, renaming, missing-file status, relinking, and reloads. The Windows chooser was checked for opening and cancellation; full chooser selection remains a manual check. Automated browser verification uses the HTTP development origin, which has a separate catalogue; it does not migrate or modify the existing file-URL catalogue. The file-URL launcher has not been verified through browser automation.

Sources: `app.js`, `library-model.js`, `library-storage.js`, `native-client.js`, `native/`, `appearance.js`, `styles.css`, and `drawing.js`. DM Sans is bundled under the SIL Open Font License in `assets/fonts/`.
