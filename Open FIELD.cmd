@echo off
setlocal
if exist "%~dp0FIELD.exe" (
  start "" "%~dp0FIELD.exe"
  exit /b 0
)
if exist "%~dp0dist\FIELD-0.2.2-alpha-win-x64\FIELD.exe" (
  start "" "%~dp0dist\FIELD-0.2.2-alpha-win-x64\FIELD.exe"
  exit /b 0
)
if exist "%~dp0dist\FIELD-0.1.0-alpha-win-x64\FIELD.exe" (
  start "" "%~dp0dist\FIELD-0.1.0-alpha-win-x64\FIELD.exe"
  exit /b 0
)
echo FIELD has not been packaged in this checkout yet.
echo Build it once with the .NET 10 SDK:
echo powershell -NoProfile -File "%~dp0scripts\package-windows.ps1"
pause
exit /b 1
