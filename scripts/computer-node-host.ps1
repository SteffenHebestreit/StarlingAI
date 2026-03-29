param(
    [ValidateSet('start', 'stop')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot '.starlingai'
$pidFile = Join-Path $stateDir 'computer-node.pid'
$logFile = Join-Path $stateDir 'computer-node.log'
$errFile = Join-Path $stateDir 'computer-node.err.log'
$nodePort = if ($env:SAI_COMPUTER_NODE_PORT) { [int]$env:SAI_COMPUTER_NODE_PORT } else { 8877 }

function Get-NodeHostProcess {
    param([int]$ProcessId)

    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
        return $null
    }

    if ($proc.CommandLine -match 'computer-node-main\.ts|computer-node-main\.js') {
        return $proc
    }

    return $null
}

function Find-NodeHostProcess {
    $matches = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'computer-node-main\.ts|computer-node-main\.js' } |
        Select-Object -First 1

    if ($matches) {
        return $matches
    }

    return $null
}

function Get-PortListenerProcess {
    param([int]$Port)

    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if (-not $listener) {
        return $null
    }

    return Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
}

function Get-ExistingNodeHostProcess {
    if (Test-Path $pidFile) {
        $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($existingPid) {
            $existingProc = Get-NodeHostProcess -ProcessId ([int]$existingPid)
            if ($existingProc) {
                return $existingProc
            }
        }
    }

    $listenerProc = Get-PortListenerProcess -Port $nodePort
    if ($listenerProc -and $listenerProc.CommandLine -match 'computer-node-main\.ts|computer-node-main\.js') {
        return $listenerProc
    }

    return Find-NodeHostProcess
}

function Resolve-NodeCommand {
    $pnpmCmd = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
    if ($pnpmCmd) {
        return @('pnpm.cmd', @('--filter', '@starlingai/core', 'build'))
    }

    $pnpm = Get-Command 'pnpm' -ErrorAction SilentlyContinue
    if ($pnpm) {
        return @('pnpm', @('--filter', '@starlingai/core', 'build'))
    }

    $corepack = Get-Command 'corepack.cmd' -ErrorAction SilentlyContinue
    if ($corepack) {
        return @('corepack.cmd', @('pnpm', '--filter', '@starlingai/core', 'build'))
    }

    throw 'pnpm or corepack.cmd is required to build the computer node-host.'
}

function Build-NodeHost {
    $command = Resolve-NodeCommand
    $exe = $command[0]
    $args = $command[1]

    & $exe @args
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to build @starlingai/core before starting the computer node-host.'
    }
}

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
}

switch ($Action) {
    'start' {
        if (-not (Get-Command 'node.exe' -ErrorAction SilentlyContinue)) {
            throw 'Node.js is required to start the computer node-host.'
        }

        Build-NodeHost

        $existingProc = Get-ExistingNodeHostProcess
        if ($existingProc) {
            Set-Content -Path $pidFile -Value $existingProc.ProcessId
            Write-Output '[OK] Computer node-host already running'
            Write-Output ("    PID: {0}" -f $existingProc.ProcessId)
            Write-Output ("    Log: {0}" -f $logFile)
            exit 0
        }

        if (Test-Path $pidFile) {
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }

        $portListener = Get-PortListenerProcess -Port $nodePort
        if ($portListener) {
            $summary = if ($portListener.CommandLine) { $portListener.CommandLine } else { $portListener.Name }
            throw ("Port {0} is already in use by PID {1}: {2}" -f $nodePort, $portListener.ProcessId, $summary)
        }

        $entryPoint = Join-Path $repoRoot 'packages\core\dist\computer-node-main.js'
        if (-not (Test-Path $entryPoint)) {
            throw "Computer node-host entrypoint not found after build: $entryPoint"
        }

        Remove-Item $logFile, $errFile -Force -ErrorAction SilentlyContinue

        $proc = Start-Process -FilePath (Get-Command 'node.exe').Source `
            -WorkingDirectory $repoRoot `
            -ArgumentList @($entryPoint) `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError $errFile `
            -WindowStyle Hidden `
            -PassThru

        Set-Content -Path $pidFile -Value $proc.Id
        Start-Sleep -Seconds 2

        if ($proc.HasExited) {
            $existingProc = Get-ExistingNodeHostProcess
            if ($existingProc) {
                Set-Content -Path $pidFile -Value $existingProc.ProcessId
                Write-Output '[OK] Computer node-host already running'
                Write-Output ("    PID: {0}" -f $existingProc.ProcessId)
                Write-Output ("    Log: {0}" -f $logFile)
                exit 0
            }

            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            $stdout = if (Test-Path $logFile) { Get-Content $logFile -Raw } else { '' }
            $stderr = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { '' }
            throw ("Computer node-host exited immediately. STDOUT:`n{0}`nSTDERR:`n{1}" -f $stdout, $stderr)
        }

        Write-Output '[OK] Computer node-host started'
        Write-Output ("    PID: {0}" -f $proc.Id)
        Write-Output ("    Log: {0}" -f $logFile)
        exit 0
    }

    'stop' {
        # Collect all PIDs to kill: from pid file, orphan scan, and port listener.
        $pidsToKill = [System.Collections.Generic.HashSet[int]]::new()

        if (Test-Path $pidFile) {
            $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($existingPid) {
                $existingProc = Get-NodeHostProcess -ProcessId ([int]$existingPid)
                if ($existingProc) {
                    [void]$pidsToKill.Add([int]$existingPid)
                }
            }
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }

        # Always scan for orphaned processes regardless of pid file state.
        $orphaned = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'computer-node-main\.ts|computer-node-main\.js' }
        if ($orphaned) {
            $orphaned | ForEach-Object { [void]$pidsToKill.Add([int]$_.ProcessId) }
        }

        # Also check if something is still holding the port.
        $portProc = Get-PortListenerProcess -Port $nodePort
        if ($portProc -and $portProc.CommandLine -match 'node') {
            [void]$pidsToKill.Add([int]$portProc.ProcessId)
        }

        if ($pidsToKill.Count -gt 0) {
            foreach ($targetPid in $pidsToKill) {
                # Kill the process tree (parent + children) rather than just the parent.
                $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId = {0}" -f $targetPid) -ErrorAction SilentlyContinue
                if ($children) {
                    $children | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                }
                Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
            }

            # Brief wait then verify port is freed.
            Start-Sleep -Milliseconds 500
            $stillListening = Get-PortListenerProcess -Port $nodePort
            if ($stillListening -and $stillListening.CommandLine -match 'node') {
                Stop-Process -Id $stillListening.ProcessId -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 300
            }

            Write-Output '[OK] Computer node-host stopped'
            exit 0
        }

        Write-Output '[OK] Computer node-host is not running'
        exit 0
    }
}