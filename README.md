# FIELD — Windows alpha 0.2.0

Close older FIELD builds, then run `dist/FIELD-0.2.1-alpha-win-x64/FIELD.exe`, or use `Open FIELD.cmd`. Extract the complete ZIP when moving the application. The portable x64 package includes .NET; WebView2 Evergreen Runtime is required.

## Catalogue and migration

FIELD stores its catalogue in `%LOCALAPPDATA%\FIELD\Desktop\library.sqlite`. Existing `library.json` catalogues migrate on first launch with canonical IDs, shared memberships, custom names, notes, drawings, and relationships intact. The original JSON and a migration backup are retained. Older builds keep reading the old JSON copy: use 0.2.0 for further editing after migration.

SQLite indexes fields, file identities and paths, memberships, relationships, and full-text search. Writes update changed records in a transaction. The current frontend still exchanges complete snapshots and limits a catalogue/export to 64 MB; this is a foundation for larger archives, not an unlimited-scale claim. Item lists render 100 rows at a time with Show more.

## Linked folders

Use **Link folder** on Fields, or right-click a field and choose **Link folder**. Files in that folder and its subfolders appear in the field. Refresh runs while FIELD is open using file-change notifications, a five-second UI check, and a periodic reconciliation. Changes pause while editing, selecting items, or a native operation is running. Use **Refresh** for an immediate check.

Original PC files are never moved or deleted by linking, unlinking, organizing, or field deletion. Canonical items can appear in multiple fields without copies. Renames preserve stable file identity and curated names. Missing files and offline folders retain catalogue records. Removing a source item from its field records an exclusion so the next scan does not put it back; manually adding it again clears the exclusion. Unlinking keeps imported items and memberships.

Recursive scans skip symbolic links/junctions and FIELD app data. A scan is limited to 100,000 files; unreadable/oversized sources report an unavailable status and preserve existing records. Cross-volume moves still require relinking. Automatic folder updates run only while the app is open.

## Organization

Primary fields start collapsed. Use their chevrons to reveal subfields; opening a nested field expands its ancestry automatically.

Hover an item to reveal its checkbox, or use the Select checkbox above the list to select all filtered items, including rows beyond the current page. Add to fields or Remove from fields applies to the selection. Undo / Ctrl+Z reverses the last organization operation while preserving later content edits and unrelated memberships. The last 20 bulk operations can be undone during the current session.

Right-click items or fields, or use Shift+F10. Field deletion keeps items and PC files, promotes direct subfields, and removes incident connections. Connection names are optional. Image files show lazy thumbnails and larger detail previews; unsupported, corrupt, or oversized images retain normal file controls. The supplied icon, DM Sans, flat surfaces, and both themes are included.

## Search and recovery

Search uses indexed names, note text, URLs, and file paths with word/prefix matching. It shows at most 100 results. It does not index the contents of arbitrary PC documents.

FIELD keeps up to seven daily catalogue backups while in use. **Library → Backups → Restore** creates a safety copy before restoring organization. Restore affects the catalogue, not original PC files. If a damaged catalogue prevents startup, the app offers explicit catalogue-backup recovery and retains the previous database and journal files. Backups do not copy source file contents or the separate native file-reference registry.

Library exports remain portable JSON metadata. Browser libraries can be exported through the browser prototype and imported into an empty desktop catalogue. Drawings and notes are in the catalogue; linked PC file contents stay at their original locations.

## Build and checks

Build with the .NET 10 SDK:

```powershell
powershell -NoProfile -File scripts/package-windows.ps1
node --test tests/*.test.js
```

Native checks live under `desktop/tests/{backend,storage,folders,previews}`. Pass an absolute disposable fixture parent to each executable. The portable build includes runtime and dependency notices and a SHA256 checksum. This alpha is unsigned and has no automatic updater.
