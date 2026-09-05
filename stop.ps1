$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load .env so this script checks the same ports as start.ps1
Get-Content (Join-Path $projectRoot '.env') -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*)$') {
    Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim()
  }
}

$statePath = Join-Path (Join-Path $projectRoot '.ecomint') 'processes.json'
$apiPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$clientPort = if ($env:VITE_DEV_PORT) { [int]$env:VITE_DEV_PORT } else { 5173 }
$applicationPorts = @($clientPort, $apiPort)

if (-not (Test-Path $statePath)) {
  $occupiedPorts = foreach ($port in $applicationPorts) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1 @{Name = 'Port'; Expression = { $port }}, OwningProcess
  }
  if (@($occupiedPorts).Count -gt 0) {
    $portDetails = @($occupiedPorts | ForEach-Object { "port $($_.Port) (PID $($_.OwningProcess))" }) -join ', '
    Write-Host "No tracked eComInt processes found; $portDetails is still in use."
  } else {
    Write-Host 'eComInt is not running.'
  }
  exit 0
}

$state = Get-Content $statePath -Raw | ConvertFrom-Json
$rootIds = @($state | ForEach-Object { [int]$_.pid })
$allIds = [System.Collections.Generic.HashSet[int]]::new()
$pendingIds = [System.Collections.Generic.Queue[int]]::new()

foreach ($rootId in $rootIds) {
  [void]$allIds.Add($rootId)
  $pendingIds.Enqueue($rootId)
}

$processes = @(Get-CimInstance Win32_Process)
while ($pendingIds.Count -gt 0) {
  $parentId = $pendingIds.Dequeue()
  foreach ($process in $processes | Where-Object { [int]$_.ParentProcessId -eq $parentId }) {
    $childId = [int]$process.ProcessId
    if ($allIds.Add($childId)) {
      $pendingIds.Enqueue($childId)
    }
  }
}

foreach ($processId in $allIds) {
  Stop-Process -Id $processId -Force
}

Remove-Item $statePath -Force
Write-Host 'eComInt stopped.'