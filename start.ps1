$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load .env so this script uses the same ports as Vite and Express
Get-Content (Join-Path $projectRoot '.env') -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*)$') {
    Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim()
  }
}

$stateDirectory = Join-Path $projectRoot '.ecomint'
$statePath = Join-Path $stateDirectory 'processes.json'
$logDirectory = Join-Path $stateDirectory 'logs'
$apiPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$clientPort = if ($env:VITE_DEV_PORT) { [int]$env:VITE_DEV_PORT } else { 5173 }
$applicationPorts = @($clientPort, $apiPort)

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

if (Test-Path $statePath) {
  $existingState = Get-Content $statePath -Raw | ConvertFrom-Json
  $runningProcesses = @($existingState | ForEach-Object {
    Get-Process -Id ([int]$_.pid) -ErrorAction SilentlyContinue
  })
  if ($runningProcesses.Count -gt 0) {
    Write-Host 'eComInt is already running.'
    Write-Host "Web app: http://127.0.0.1:$clientPort"
    Write-Host "API:     http://127.0.0.1:$apiPort/api/health"
    exit 0
  }
  Remove-Item $statePath -Force
}

$occupiedPorts = foreach ($port in $applicationPorts) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 @{Name = 'Port'; Expression = { $port }}, OwningProcess
}
if (@($occupiedPorts).Count -gt 0) {
  $portDetails = @($occupiedPorts | ForEach-Object { "port $($_.Port) (PID $($_.OwningProcess))" }) -join ', '
  throw "Cannot start eComInt because $portDetails is already in use. Stop the existing process before starting the app."
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$serverOutputLog = Join-Path $logDirectory 'server.out.log'
$serverErrorLog = Join-Path $logDirectory 'server.err.log'
$clientOutputLog = Join-Path $logDirectory 'client.out.log'
$clientErrorLog = Join-Path $logDirectory 'client.err.log'

$serverProcess = Start-Process -FilePath $npm `
  -ArgumentList @('run', 'dev:server') `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $serverOutputLog `
  -RedirectStandardError $serverErrorLog `
  -PassThru

$clientProcess = Start-Process -FilePath $npm `
  -ArgumentList @('--prefix', 'client', 'run', 'dev', '--', '--host', '127.0.0.1') `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $clientOutputLog `
  -RedirectStandardError $clientErrorLog `
  -PassThru

@(
  [pscustomobject]@{ name = 'server'; pid = $serverProcess.Id }
  [pscustomobject]@{ name = 'client'; pid = $clientProcess.Id }
) | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8

function Test-Endpoint {
  param([string]$uri)

  try {
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

$startupDeadline = [DateTime]::UtcNow.AddSeconds(30)
$serverReady = $false
$clientReady = $false
while ([DateTime]::UtcNow -lt $startupDeadline -and (-not $serverReady -or -not $clientReady)) {
  if ($serverProcess.HasExited -or $clientProcess.HasExited) {
    break
  }
  $serverReady = Test-Endpoint "http://127.0.0.1:$apiPort/api/health"
  $clientReady = Test-Endpoint "http://127.0.0.1:$clientPort/"
}

if (-not $serverReady -or -not $clientReady) {
  & (Join-Path $projectRoot 'stop.ps1') | Out-Null
  throw 'eComInt did not become ready within 30 seconds. Check .ecomint\logs for details.'
}

Write-Host 'eComInt started.'
Write-Host "Web app: http://127.0.0.1:$clientPort"
Write-Host "API:     http://127.0.0.1:$apiPort/api/health"
Write-Host "Logs:    $logDirectory"