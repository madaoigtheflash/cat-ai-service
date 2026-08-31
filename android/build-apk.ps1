param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$sdkCandidates = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    (Join-Path $env:USERPROFILE '.cache\closeai-android-toolchain\sdk'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
) | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'platforms\android-35\android.jar')) }

$sdkRoot = $sdkCandidates | Select-Object -First 1
if (-not $sdkRoot) {
    throw 'Android SDK 35 was not found. Install it or set ANDROID_HOME.'
}

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot

$androidRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$gradleWrapper = Join-Path $androidRoot 'gradlew.bat'
$task = "assemble$Configuration"

Push-Location $androidRoot
try {
    & $gradleWrapper --no-daemon $task
    if ($LASTEXITCODE -ne 0) {
        throw "Android build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

$variant = $Configuration.ToLowerInvariant()
$apk = Join-Path $androidRoot "app\build\outputs\apk\$variant\app-$variant.apk"
if (-not (Test-Path -LiteralPath $apk)) {
    throw "Android build completed but APK was not found: $apk"
}

Write-Host "APK built successfully: $apk"
