param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [string]$TargetRoot,
    [string]$AgentDir,
    [string]$WorkspaceRoot,
    [string]$SourceRoot,
    [string]$ReleaseStore,
    [ValidateRange(1024, 65535)][int]$Port = 30141
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
if (-not $TargetRoot) { $TargetRoot = $ReleaseRoot }
$TargetRoot = [IO.Path]::GetFullPath($TargetRoot)
if (-not $AgentDir) { $AgentDir = Join-Path $InstallRoot 'agent' }
$AgentDir = [IO.Path]::GetFullPath($AgentDir)
$node = Join-Path $InstallRoot 'node\node.exe'
$helperSource = Join-Path $PSScriptRoot 'pi-web-runtime.cjs'
$builderSource = Join-Path $PSScriptRoot 'pi-web-build.cjs'
if ($ReleaseStore -and -not $SourceRoot) { throw '-ReleaseStore requires -SourceRoot.' }
if ($SourceRoot) {
    $SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'scripts\task.mjs'))) { throw '-SourceRoot must be the authorized Pi monorepo.' }
    if (-not $ReleaseStore) { $ReleaseStore = Join-Path $SourceRoot '.local\releases' }
    $ReleaseStore = [IO.Path]::GetFullPath($ReleaseStore)
    if (-not (Test-Path -LiteralPath $builderSource)) { throw 'The local source build helper is missing.' }
}
if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js is missing from the installation.' }
if (-not (Test-Path -LiteralPath $helperSource)) { throw 'The one-shot helper source is missing.' }
# Read/verify before changing the installation. No build or npm install here.
& $node -e "const h=require(process.argv[1]); for(const root of process.argv.slice(2)) console.log(h.inspectRelease(root));" $helperSource $ReleaseRoot $TargetRoot
if ($LASTEXITCODE -ne 0) { throw 'The release build and SDK failed validation.' }
if (-not (Test-Path -LiteralPath (Join-Path $ReleaseRoot '.next\server\app\api\local-refresh\route.js'))) {
    throw 'This build does not include the local refresh API. Build the updated source first.'
}
$localConfig = Join-Path $AgentDir 'pi-web-local.json'
if (-not $WorkspaceRoot -and (Test-Path -LiteralPath $localConfig)) {
    $WorkspaceRoot = ([IO.File]::ReadAllText($localConfig) | ConvertFrom-Json).defaultWorkspaceRoot
}
if ($WorkspaceRoot) { $WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot) }
$bin = Join-Path $InstallRoot 'bin'
$stateDir = Join-Path $AgentDir 'pi-web-runtime'
$helper = Join-Path $bin 'pi-web-runtime.cjs'
$builder = Join-Path $bin 'pi-web-build.cjs'
$configFile = Join-Path $stateDir 'runtime.json'
$entry = Join-Path $bin 'pi-web-launch.cjs'
if (Test-Path -LiteralPath (Join-Path $stateDir 'refresh.lock')) {
    throw 'A refresh is in progress or needs recovery. Do not change its installation while it runs.'
}
$backup = Join-Path $InstallRoot ('setup\local-refresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($file in @($entry, $helper, $builder, $configFile)) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup ([IO.Path]::GetFileName($file))) }
}
New-Item -ItemType Directory -Path $bin, $stateDir -Force | Out-Null
$config = @{ activeRoot = $ReleaseRoot; targetRoot = $TargetRoot; stateDir = $stateDir; helperPath = $helper; agentDir = $AgentDir; port = $Port }
if ($WorkspaceRoot) { $config.workspaceRoot = $WorkspaceRoot }
if ($SourceRoot) { $config.sourceRoot = $SourceRoot; $config.releaseStore = $ReleaseStore }
# JSON escapes paths as data; no user-supplied text is inserted as JavaScript.
$configLiteral = ConvertTo-Json -InputObject $configFile -Compress
$helperLiteral = ConvertTo-Json -InputObject $helper -Compress
$contents = @"
// Managed local refresh entry. Management helpers are launched only on demand.
const helper = require($helperLiteral);
const configFile = $configLiteral;
if (require.main === module) helper.runStart(configFile);
"@
# Validate the fixed helpers before touching the installation. Copy the new
# builder before publishing the feature flag in config.
foreach ($script in @($helperSource) + $(if ($SourceRoot) { @($builderSource) } else { @() })) {
    & $node --check $script
    if ($LASTEXITCODE -ne 0) { throw "Invalid local helper: $script" }
}
$stagedEntry = Join-Path $backup 'validated-launcher.cjs'
[IO.File]::WriteAllText($stagedEntry, $contents, [Text.UTF8Encoding]::new($false))
& $node --check $stagedEntry
if ($LASTEXITCODE -ne 0) { throw 'Launcher validation failed. The current installation was not changed.' }
$setupLock = Join-Path $stateDir 'refresh.lock'
New-Item -ItemType Directory -Path $setupLock -ErrorAction Stop | Out-Null
try {
    if ($SourceRoot) { Copy-Item -LiteralPath $builderSource -Destination $builder -Force }
    Copy-Item -LiteralPath $helperSource -Destination $helper -Force
    Copy-Item -LiteralPath $stagedEntry -Destination $entry -Force
    $stagedConfig = Join-Path $stateDir ('runtime.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($stagedConfig, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $configFile) { [IO.File]::Replace($stagedConfig, $configFile, (Join-Path $backup 'runtime.replaced.json')) }
        else { [IO.File]::Move($stagedConfig, $configFile) }
    } finally { if (Test-Path -LiteralPath $stagedConfig) { [IO.File]::Delete($stagedConfig) } }
} finally { [IO.Directory]::Delete($setupLock) }
Write-Output "Configured local refresh. Backup: $backup"
Write-Output 'No service was stopped or started. Restart Pi Web once from an external terminal, then use Settings > Application.'
