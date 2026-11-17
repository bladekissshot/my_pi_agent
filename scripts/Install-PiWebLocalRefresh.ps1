param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [string]$TargetRoot,
    [string]$AgentDir,
    [string]$WorkspaceRoot,
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
$configFile = Join-Path $stateDir 'runtime.json'
$entry = Join-Path $bin 'pi-web-launch.cjs'
if (Test-Path -LiteralPath (Join-Path $stateDir 'refresh.lock')) {
    throw 'A refresh is in progress or needs recovery. Do not change its installation while it runs.'
}
$backup = Join-Path $InstallRoot ('setup\local-refresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($file in @($entry, $helper, $configFile)) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup ([IO.Path]::GetFileName($file))) }
}
New-Item -ItemType Directory -Path $bin, $stateDir -Force | Out-Null
$config = @{ activeRoot = $ReleaseRoot; targetRoot = $TargetRoot; stateDir = $stateDir; helperPath = $helper; agentDir = $AgentDir; port = $Port }
if ($WorkspaceRoot) { $config.workspaceRoot = $WorkspaceRoot }
# JSON escapes paths as data; no user-supplied text is inserted as JavaScript.
$configLiteral = ConvertTo-Json -InputObject $configFile -Compress
$helperLiteral = ConvertTo-Json -InputObject $helper -Compress
$contents = @"
// Managed local refresh entry. Management helpers are launched only on demand.
const helper = require($helperLiteral);
const configFile = $configLiteral;
if (require.main === module) helper.runStart(configFile);
"@
Copy-Item -LiteralPath $helperSource -Destination $helper -Force
[IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($entry, $contents, [Text.UTF8Encoding]::new($false))
& $node --check $entry
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath (Join-Path $backup 'pi-web-launch.cjs') -Destination $entry -Force
    throw 'Launcher validation failed. The previous launcher was restored.'
}
Write-Output "Configured local refresh. Backup: $backup"
Write-Output 'No service was stopped or started. Restart Pi Web once from an external terminal, then use Settings > Application.'
