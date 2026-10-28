# FIELD — Windows alpha

Extract `dist/FIELD-0.1.2-alpha-win-x64.zip` and double-click **FIELD.exe**, or use **Open FIELD.cmd** from this checkout after building the package. FIELD opens in its own Windows window. No .NET SDK or separate .NET installation is required to run the portable package.

The package targets 64-bit Windows and uses the Microsoft Edge WebView2 Evergreen Runtime. It is already installed on this development machine. A missing-runtime message links to Microsoft's installer. This first alpha is unsigned.

Fresh desktop libraries are empty. Your catalogue is saved in `%LOCALAPPDATA%\FIELD\Desktop\library.json`; registered file identities are in `file-references.json`. The WebView profile in the same folder stores appearance preferences. Replacing or moving the program folder leaves this app-owned data in place. Closing the window shuts down FIELD; launching again focuses the existing window when it is already open.

To bring over an existing browser library:

1. Open the original `index.html` in the same browser and location you used previously, or use **Open FIELD browser.cmd**.
2. Open **Library → Export library** and save the JSON file.
3. Open the desktop app, then **Library → Import library** and choose that export.

Import is available for an empty desktop library and preserves canonical item IDs, field memberships, hierarchy, connections, notes, links, drawings, and native file references. The original browser library is kept. Invalid exports and existing desktop libraries are not overwritten. The alpha import limit is 64 MB. Selected files remain references to their original locations; exporting the catalogue does not copy those file contents.

Fields, subfields, links, files, notes, drawings, shared references, connections, basic search, native file selection/opening, and same-volume NTFS rename/move tracking are included. Use **Relink** for cross-volume moves or unavailable targets. File status and relinking preserve the item and its memberships. The interface uses local DM Sans, dark/light themes, and compact borderless rows.

Right-click an item or field for quick actions, or use **Shift+F10** on a focused row. Delete a field through **Delete field** in its menu or the field page's **…** button. Deletion removes the field and its connections, keeps all archived items and PC files, and moves direct subfields to its parent. The overview's **Items** tab includes items without a field. Connection names are optional.

Build the portable package from source with the .NET 10 SDK:

```powershell
powershell -NoProfile -File scripts/package-windows.ps1
```

The script bundles .NET 10.0.14, the WebView2 SDK loader, UI assets and dependency notices; it writes the extracted package, ZIP and SHA256 checksum to `dist/`. Use `-Force` for a rebuild; previous output is retained under a `.previous` name. See [desktop/PACKAGING.md](desktop/PACKAGING.md).

Verification:

```powershell
node --test tests/*.test.js
cd desktop
dotnet run --project tests/backend/Field.BackendSmoke.csproj -- "C:\absolute\disposable-fixture-parent"
```

The legacy HTTP prototype remains under `native/` for browser migration and development. Its command-line build requires the .NET 8 SDK; the packaged desktop app uses its native bridge directly and does not start that HTTP service.

Image files show lazy thumbnails and a larger preview in the details panel. Desktop previews read registered local files, stay out of the saved catalogue, and use a bounded memory cache. Unsupported, missing, corrupt, and oversized images retain their file controls. The app icon is generated from assets/app-icon.png.
