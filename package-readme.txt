FIELD - Windows x64 desktop alpha

Launch
1. Extract the entire ZIP to a folder.
2. Double-click FIELD.exe in that folder. Keep its accompanying files and web folder together.

The package includes its .NET runtime. You do not need the .NET SDK, Node.js, or a browser window.
Microsoft Edge WebView2 Runtime is required. It is already present on most Windows 10/11 computers.
If FIELD reports that it is missing, install the Evergreen Runtime from Microsoft's official page:
https://developer.microsoft.com/microsoft-edge/webview2/

Your library
New libraries start empty. Data is stored separately from the package in:
%LOCALAPPDATA%\FIELD\Desktop
Replacing the extracted app folder for a later version keeps that data.
Referenced files stay in their original locations. This package contains no personal catalogue.

Bring an existing browser library over
Open FIELD in the same browser and location where the library was created.
Use Library > Export library, then open FIELD.exe and use Library > Import library.
Import is accepted only into an empty desktop library. The browser copy is preserved.

This is the first unsigned desktop alpha. Automatic updates and an installer are not included.
Bundled dependency notices are in licenses/. The DM Sans font license is in web/assets/fonts/OFL.txt.
