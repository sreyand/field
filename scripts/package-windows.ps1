[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$')]
    [string]$Version = '0.1.2-alpha',
    [ValidatePattern('^10\.0\.\d+$')]
    [string]$RuntimeVersion = '10.0.14',
    [string]$OutputRoot = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project = Join-Path $repoRoot 'desktop\Field.Desktop\Field.Desktop.csproj'
if (-not (Test-Path -LiteralPath $project -PathType Leaf)) { throw 'The FIELD desktop project was not found.' }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Building FIELD requires the .NET 10 SDK.' }
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $repoRoot 'dist' }
$outputDirectory = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if ([string]::IsNullOrWhiteSpace($outputDirectory) -or $outputDirectory -eq [System.IO.Path]::GetPathRoot($outputDirectory).TrimEnd('\')) {
    throw 'Choose a dedicated output directory rather than a drive root.'
}
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$packageName = "FIELD-$Version-win-x64"
$packageDirectory = Join-Path $outputDirectory $packageName
$archivePath = Join-Path $outputDirectory "$packageName.zip"
$checksumPath = Join-Path $outputDirectory "$packageName.zip.sha256"
$buildRoot = Join-Path $outputDirectory ('.build-' + $packageName + '-' + [Guid]::NewGuid().ToString('N'))
$publishDirectory = Join-Path $buildRoot 'package'
$temporaryArchive = Join-Path $buildRoot "$packageName.zip"

function Assert-OutputChild([string]$Candidate) {
    $absoluteCandidate = [System.IO.Path]::GetFullPath($Candidate)
    $prefix = $outputDirectory + [System.IO.Path]::DirectorySeparatorChar
    if (-not $absoluteCandidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The package target is outside the output directory: $absoluteCandidate"
    }
    return $absoluteCandidate
}
foreach ($target in @($packageDirectory, $archivePath, $checksumPath, $buildRoot, $publishDirectory, $temporaryArchive)) { Assert-OutputChild $target | Out-Null }
if (-not $Force -and ((Test-Path -LiteralPath $packageDirectory) -or (Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath))) {
    throw "The package already exists. Use a new -Version, or -Force to retain the old package under a .previous name and replace it."
}

$uiAssets = @(
    'index.html', 'app.js', 'appearance.js', 'drawing.js', 'library-model.js',
    'library-storage.js', 'native-client.js', 'desktop-client.js', 'library-transfer.js', 'context-menu.js', 'map-geometry.js', 'image-previews.js', 'assets/app-icon.png', 'styles.css',
    'assets/field-logo.png', 'assets/fonts/dm-sans-latin-variable.woff2', 'assets/fonts/OFL.txt'
)
foreach ($relative in $uiAssets) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $relative) -PathType Leaf)) {
        throw "Missing FIELD interface asset: $relative"
    }
}
$packageReadme = Join-Path $repoRoot 'package-readme.txt'
if (-not (Test-Path -LiteralPath $packageReadme -PathType Leaf)) { throw 'The portable package readme was not found.' }

& (Join-Path $PSScriptRoot 'create-icon.ps1') | Out-Null
[System.IO.Directory]::CreateDirectory($publishDirectory) | Out-Null
Push-Location -LiteralPath (Join-Path $repoRoot 'desktop')
try {
    & dotnet publish $project --configuration Release --runtime win-x64 --self-contained true --nologo --output $publishDirectory `
        -p:RuntimeFrameworkVersion=$RuntimeVersion -p:TargetLatestRuntimePatch=true `
        -p:PublishSingleFile=false -p:PublishTrimmed=false -p:PublishReadyToRun=false `
        -p:DebugType=None -p:DebugSymbols=false -p:UseSharedCompilation=false `
        -p:Version=$Version -p:InformationalVersion=$Version --disable-build-servers
    if ($LASTEXITCODE -ne 0) { throw "Publishing FIELD failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

$executable = Join-Path $publishDirectory 'FIELD.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Publishing did not produce FIELD.exe.' }
$runtimeConfigPath = Join-Path $publishDirectory 'FIELD.runtimeconfig.json'
$runtimeConfig = Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json
if ($null -eq $runtimeConfig.runtimeOptions.includedFrameworks -or $runtimeConfig.runtimeOptions.framework -or $runtimeConfig.runtimeOptions.frameworks) {
    throw 'The published application is not self-contained.'
}
foreach ($framework in $runtimeConfig.runtimeOptions.includedFrameworks) {
    if ($framework.version -ne $RuntimeVersion) { throw "Unexpected bundled runtime version: $($framework.name) $($framework.version)." }
}
if (-not (Test-Path -LiteralPath (Join-Path $publishDirectory 'coreclr.dll')) -or
    -not (Test-Path -LiteralPath (Join-Path $publishDirectory 'PresentationFramework.dll')) -or
    -not (Test-Path -LiteralPath (Join-Path $publishDirectory 'WebView2Loader.dll'))) {
    throw 'The portable package is missing a required native runtime component.'
}

$webDirectory = Join-Path $publishDirectory 'web'
foreach ($relative in $uiAssets) {
    $destination = Join-Path $webDirectory $relative
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot $relative) -Destination $destination
}
$copiedAssets = @(Get-ChildItem -LiteralPath $webDirectory -File -Recurse | ForEach-Object {
    $_.FullName.Substring($webDirectory.Length + 1).Replace('\', '/')
} | Sort-Object)
if (@(Compare-Object ($uiAssets | Sort-Object) $copiedAssets).Count -ne 0) {
    throw 'The web directory contains unexpected or missing files.'
}
foreach ($relative in $uiAssets) {
    if ((Get-FileHash -LiteralPath (Join-Path $repoRoot $relative) -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath (Join-Path $webDirectory $relative) -Algorithm SHA256).Hash) {
        throw "The packaged interface asset differs from its source: $relative"
    }
}
Copy-Item -LiteralPath $packageReadme -Destination (Join-Path $publishDirectory 'README.txt')

$assetsPath = Join-Path $repoRoot 'desktop\Field.Desktop\obj\project.assets.json'
$assets = Get-Content -LiteralPath $assetsPath -Raw | ConvertFrom-Json
$packageFolders = @($assets.packageFolders.PSObject.Properties.Name)
$licenseDirectory = Join-Path $publishDirectory 'licenses'
[System.IO.Directory]::CreateDirectory($licenseDirectory) | Out-Null
function Copy-DependencyNotices([string]$PackageId, [string]$PackageVersion, [string]$Label) {
    $found = $false
    foreach ($folder in $packageFolders) {
        $dependency = Join-Path (Join-Path $folder $PackageId.ToLowerInvariant()) $PackageVersion.ToLowerInvariant()
        if (-not (Test-Path -LiteralPath $dependency -PathType Container)) { continue }
        $notices = @(Get-ChildItem -LiteralPath $dependency -File -Recurse | Where-Object { $_.Name -match '^(?:LICENSE(?:[._-].*)?|NOTICE(?:[._-].*)?|THIRD[-_]PARTY[-_]NOTICES(?:\..*)?)$' })
        foreach ($notice in $notices) {
            Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $licenseDirectory "$Label-$($notice.Name)")
            $found = $true
        }
        break
    }
    if (-not $found) { throw "The redistribution notices for $PackageId $PackageVersion were not found." }
}
Copy-DependencyNotices 'Microsoft.NETCore.App.Runtime.win-x64' $RuntimeVersion 'dotnet'
Copy-DependencyNotices 'Microsoft.WindowsDesktop.App.Runtime.win-x64' $RuntimeVersion 'windowsdesktop'
$webViewEntry = @($assets.libraries.PSObject.Properties.Name | Where-Object { $_ -like 'Microsoft.Web.WebView2/*' })
if ($webViewEntry.Count -ne 1) { throw 'The WebView2 SDK version could not be identified.' }
$webViewVersion = $webViewEntry[0].Split('/')[1]
Copy-DependencyNotices 'Microsoft.Web.WebView2' $webViewVersion 'webview2'

$forbidden = @(Get-ChildItem -LiteralPath $publishDirectory -Recurse -File | Where-Object {
    $_.Name -in @('library.json', 'file-references.json', 'file-references.lock', 'library.lock', '.env')
})
if ($forbidden.Count -ne 0) { throw 'User data or local configuration was found in the portable package.' }
$packageInfo = [ordered]@{
    app = 'FIELD'; version = $Version; runtimeIdentifier = 'win-x64'; selfContained = $true
    runtimeVersion = $RuntimeVersion; webView2SdkVersion = $webViewVersion; webView2Runtime = 'Evergreen (installed separately)'
    signed = $false; webAssets = $uiAssets
}
$packageInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $publishDirectory 'package-info.json') -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($publishDirectory, $temporaryArchive, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$previousSuffix = '.previous-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
foreach ($target in @($packageDirectory, $archivePath, $checksumPath)) {
    if (Test-Path -LiteralPath $target) {
        $checkedTarget = Assert-OutputChild $target
        Move-Item -LiteralPath $checkedTarget -Destination ($checkedTarget + $previousSuffix)
    }
}
Move-Item -LiteralPath $publishDirectory -Destination $packageDirectory
Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($checksumPath, "$hash  $packageName.zip`n", [System.Text.Encoding]::ASCII)
if (@(Get-ChildItem -LiteralPath $buildRoot -Force).Count -eq 0) {
    Remove-Item -LiteralPath (Assert-OutputChild $buildRoot)
}
Write-Output "FIELD package: $archivePath"
Write-Output "Launch: $(Join-Path $packageDirectory 'FIELD.exe')"
Write-Output "SHA256: $hash"
