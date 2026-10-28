@echo off
setlocal
where dotnet >nul 2>nul
if errorlevel 1 (
  echo FIELD requires the .NET 8 SDK. Install it from https://dotnet.microsoft.com/download/dotnet/8.0
  pause
  exit /b 1
)
pushd "%~dp0native"
dotnet build Field.Host.csproj --configuration Release --nologo --verbosity quiet
if errorlevel 1 (
  popd
  echo FIELD could not build its local file runtime.
  pause
  exit /b 1
)
popd
set "FIELD_LAUNCH_ROOT=%~dp0"
powershell -NoProfile -Command "$fieldRoot = $env:FIELD_LAUNCH_ROOT; $fieldDll = Join-Path $fieldRoot 'native\bin\Release\net8.0-windows\Field.Host.dll'; $fieldArgs = '\"' + $fieldDll + '\" --root \"' + $fieldRoot.TrimEnd('\') + '\" --open'; Start-Process -FilePath 'dotnet' -ArgumentList $fieldArgs -WindowStyle Hidden"
