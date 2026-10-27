# FIELD

Open `index.html` or double-click `Open FIELD.cmd`. No build step or network connection is required.

The UI starts with no fields and no items. The dark surfaces, blue selection states, and navigation follow the supplied SYDTRACK reference. The original FIELD logo is included in `assets/`.

Create a field, then use **Add** to create a link, select a PC file or enter its Windows path, write a note, or draw. Items can be edited and referenced by more than one field. Shared items appear as connections in the big FIELD. Subfields and manually labeled connections are supported.

This remains an interactive mockup. Content exists for the current page session and resets on reload. Selected files remain local to the browser; there are no uploads. A browser file picker exposes a selected file's name and contents, not its full Windows path. Full paths can be entered separately. Native Windows indexing, launching arbitrary paths, file watching, and persistent storage are not implemented.

Source: `app.js` (UI and session state), `styles.css` (appearance), and `drawing.js` (pointer drawing).
