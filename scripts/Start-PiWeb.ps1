param(
    [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(1024, 65535)][int]$Port = 30141,
    [string]$NodePath,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$piWebUrl = "http://127.0.0.1:$Port"
$piWebLogDir = Join-Path $InstallRoot 'agent\pi-web-logs'
$piWebEntry = Join-Path $InstallRoot 'bin\pi-web-launch.cjs'
if (-not $NodePath) { $NodePath = Join-Path $InstallRoot 'node\node.exe' }
# The port identifies the local service, even when two installations launch it.
$piWebMutex = [System.Threading.Mutex]::new($false, "Local\PiWeb-Desktop-$Port")
$piWebOwnsMutex = $false

function Test-PiWebListening {
    # Read the local TCP table directly: no connection timeout or CIM startup.
    $piListeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return $piListeners.Port -contains $Port
}

function Test-PiWebReady {
    if (-not (Test-PiWebListening)) { return $false }
    try {
        $piResponse = Invoke-WebRequest -Uri $piWebUrl -UseBasicParsing -TimeoutSec 2
        return $piResponse.StatusCode -eq 200 -and $piResponse.Content -match '<title>Pi Web</title>'
    } catch {
        return $false
    }
}

try {
    . (Join-Path $InstallRoot 'bin\PiWeb-Environment.ps1')
    try {
        $piWebOwnsMutex = $piWebMutex.WaitOne(55000)
    } catch [System.Threading.AbandonedMutexException] {
        $piWebOwnsMutex = $true
    }
    if (-not $piWebOwnsMutex) { throw 'Another Pi Web startup is still in progress. Try again shortly.' }

    if (-not (Test-PiWebReady)) {
        if (-not (Test-Path -LiteralPath $piWebEntry)) { throw "Pi Web launcher is not installed: $piWebEntry" }
        if (Test-PiWebListening) { throw "Port $Port is already in use and Pi Web is not responding. Check the service before restarting." }

        New-Item -ItemType Directory -Path $piWebLogDir -Force | Out-Null
        $piWebProcess = Start-Process -FilePath $NodePath `
            -ArgumentList @("`"$piWebEntry`"", '--hostname', '127.0.0.1', '--port', "$Port", '--no-open') `
            -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $piWebLogDir 'stdout.log') `
            -RedirectStandardError (Join-Path $piWebLogDir 'stderr.log')

        $piWebDeadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            $piWebReady = Test-PiWebReady
            if ($piWebReady) { break }
            $piWebProcess.Refresh()
            if ($piWebProcess.HasExited) { throw "Pi Web exited during startup. See $piWebLogDir\stderr.log." }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $piWebDeadline)

        if (-not $piWebReady) { throw "Pi Web did not become ready in time. See $piWebLogDir." }
    }

    if (-not $NoBrowser) { Start-Process -FilePath $piWebUrl }
    Write-Output $piWebUrl
} catch {
    $piWebMessage = $_.Exception.Message
    if (-not $NoBrowser) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($piWebMessage, 'Pi Web', 'OK', 'Error') | Out-Null
    }
    Write-Error $piWebMessage -ErrorAction Continue
    exit 1
} finally {
    if ($piWebOwnsMutex) { $piWebMutex.ReleaseMutex() }
    $piWebMutex.Dispose()
}
