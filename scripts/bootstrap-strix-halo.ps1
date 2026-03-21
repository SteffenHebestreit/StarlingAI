[CmdletBinding()]
param(
    [ValidateSet("up", "down", "status")]
    [string]$Action = "up",

    [switch]$SkipNodeInstall,
    [switch]$SkipDockerBuild,
    [switch]$NoHostImageService,
    [string]$ImageModel = "Qwen/Qwen-Image"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Script:RepoRoot = Split-Path -Parent $PSScriptRoot
$Script:RuntimeDir = Join-Path $Script:RepoRoot ".starlingai\runtime"
$Script:LogsDir = Join-Path $Script:RepoRoot ".starlingai\logs"
$Script:HostServicesDir = Join-Path $Script:RepoRoot ".starlingai\host-services"
$Script:PidDir = Join-Path $Script:RepoRoot ".starlingai\pids"
$Script:RuntimeConfigPath = Join-Path $Script:RuntimeDir "mixed-runtime.json"
$Script:ComposeOverridePath = Join-Path $Script:RuntimeDir "compose.mixed.yml"
$Script:HostImageVenvDir = Join-Path $Script:HostServicesDir "qwen-image"
$Script:HostImagePidPath = Join-Path $Script:PidDir "qwen-image-service.pid"
$Script:HostImageStdoutLog = Join-Path $Script:LogsDir "qwen-image-service.stdout.log"
$Script:HostImageStderrLog = Join-Path $Script:LogsDir "qwen-image-service.stderr.log"
$Script:TokenPath = Join-Path $Script:RuntimeDir "admin.token"

function Write-Section([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) {
    Write-Host "[info] $Message" -ForegroundColor Gray
}

function Write-WarnLine([string]$Message) {
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Write-Ok([string]$Message) {
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function New-ManagedDirectories {
    foreach ($path in @($Script:RuntimeDir, $Script:LogsDir, $Script:HostServicesDir, $Script:PidDir)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Get-Tool([string]$Name) {
    return Get-Command $Name -ErrorAction SilentlyContinue
}

function Assert-Tool([string]$Name, [string]$Hint) {
    if (-not (Get-Tool $Name)) {
        throw "$Name is required. $Hint"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @(),

        [string]$WorkingDirectory = $Script:RepoRoot,

        [switch]$AllowFailure
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if (-not $AllowFailure -and $exitCode -ne 0) {
        $joinedArgs = if ($Arguments.Count -gt 0) { $Arguments -join " " } else { "" }
        throw "Command failed with exit code ${exitCode}: $FilePath $joinedArgs"
    }

    return $exitCode
}

function Get-JsonEndpoint([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing
        $body = $null
        if (-not [string]::IsNullOrWhiteSpace($response.Content)) {
            try {
                $body = $response.Content | ConvertFrom-Json
            }
            catch {
                $body = $response.Content
            }
        }

        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = $body
        }
    }
    catch {
        $webResponse = $_.Exception.Response
        if ($null -eq $webResponse) {
            return $null
        }

        $stream = $webResponse.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        try {
            $content = $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
            if ($stream) {
                $stream.Dispose()
            }
        }

        $body = $null
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            try {
                $body = $content | ConvertFrom-Json
            }
            catch {
                $body = $content
            }
        }

        return [pscustomobject]@{
            StatusCode = [int]$webResponse.StatusCode
            Body = $body
        }
    }
}

function Wait-ForGatewayHealth {
    param(
        [string]$Url = "http://127.0.0.1:8765/healthz",
        [int]$TimeoutSeconds = 180
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $response = Get-JsonEndpoint $Url
        if ($response -and $response.StatusCode -eq 200 -and $response.Body.status -eq "ok") {
            return
        }
        Start-Sleep -Seconds 3
    }

    throw "Gateway did not become healthy within $TimeoutSeconds seconds ($Url)."
}

function Test-NodeDependencySet {
    $nodeModulesPath = Join-Path $Script:RepoRoot "node_modules"
    return Test-Path $nodeModulesPath
}

function Ensure-Pnpm {
    if (Get-Tool "pnpm") {
        Write-Ok "pnpm is available"
        return
    }

    Assert-Tool "corepack" "Install Node.js 22+ and rerun the script."
    Write-Section "Enabling pnpm via Corepack"
    Invoke-Checked -FilePath "corepack" -Arguments @("enable")
    Invoke-Checked -FilePath "corepack" -Arguments @("prepare", "pnpm@10.6.0", "--activate")
    Write-Ok "pnpm activated"
}

function Assert-DockerCompose {
    Write-Section "Checking Docker Compose"
    Invoke-Checked -FilePath "docker" -Arguments @("compose", "version")
    Write-Ok "docker compose is available"
}

function Ensure-BaseConfig {
    $configPath = Join-Path $Script:RepoRoot "starlingai.json"
    $examplePath = Join-Path $Script:RepoRoot "starlingai.example.json"

    if (Test-Path $configPath) {
        Write-Ok "Using existing starlingai.json"
        return
    }

    Copy-Item -Path $examplePath -Destination $configPath
    Write-Ok "Created starlingai.json from example"
}

function Ensure-ProjectSecrets {
    Write-Section "Generating or preserving local secrets"
    Invoke-Checked -FilePath "node" -Arguments @("scripts/setup.mjs")
}

function Ensure-NodePackages {
    if ($SkipNodeInstall) {
        Write-WarnLine "Skipping pnpm install by request"
        return
    }

    Write-Section "Installing Node workspace dependencies"
    Invoke-Checked -FilePath "pnpm" -Arguments @("install")
    Write-Ok "pnpm install completed"
}

function Write-MixedRuntimeFiles {
    Write-Section "Generating mixed-mode runtime files"

    $runtimeConfig = @{}
    if (-not $NoHostImageService) {
        $runtimeConfig = [ordered]@{
            multimodal = [ordered]@{
                imageGeneration = [ordered]@{
                    baseUrl = "http://host.docker.internal:5005"
                    model = $ImageModel
                }
            }
        }
    }

    $runtimeJson = $runtimeConfig | ConvertTo-Json -Depth 8
    Set-Content -Path $Script:RuntimeConfigPath -Value ($runtimeJson + "`r`n") -Encoding Ascii

    $composeYaml = @"
services:
  gateway:
    environment:
      SAI_MUTABLE_CONFIG_PATH: /runtime/mixed-runtime.json
    volumes:
      - ./.starlingai/runtime/mixed-runtime.json:/runtime/mixed-runtime.json:ro
"@
    Set-Content -Path $Script:ComposeOverridePath -Value $composeYaml -Encoding Ascii

    Write-Ok "Generated $(Split-Path -Leaf $Script:RuntimeConfigPath)"
    Write-Ok "Generated $(Split-Path -Leaf $Script:ComposeOverridePath)"
}

function Test-LmStudio {
    Write-Section "Checking LM Studio on the Windows host"
    $response = Get-JsonEndpoint "http://127.0.0.1:1234/v1/models"
    if (-not $response -or $response.StatusCode -ne 200) {
        Write-WarnLine "LM Studio is not reachable at http://127.0.0.1:1234/v1/models"
        return
    }

    $modelCount = 0
    if ($response.Body.data) {
        $modelCount = @($response.Body.data).Count
    }
    Write-Ok "LM Studio reachable ($modelCount model(s) advertised)"
}

function Get-PythonLauncher {
    $launcher = Get-Tool "py"
    if ($launcher) {
        return $launcher.Source
    }

    throw "Python launcher 'py' is required for the host image service. Install Python 3.11 for Windows and rerun."
}

function Get-HostImagePythonPath {
    return Join-Path $Script:HostImageVenvDir "Scripts\python.exe"
}

function Test-HostImageDependencies {
    $pythonExe = Get-HostImagePythonPath
    if (-not (Test-Path $pythonExe)) {
        return $false
    }

    Push-Location $Script:RepoRoot
    try {
        & $pythonExe -c "import fastapi, diffusers, transformers, torch_directml" *> $null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        Pop-Location
    }
}

function Ensure-HostImageEnvironment {
    if ($NoHostImageService) {
        return
    }

    Write-Section "Preparing host-native qwen-image-service"

    $pythonLauncher = Get-PythonLauncher
    if (-not (Test-Path $Script:HostImageVenvDir)) {
        Invoke-Checked -FilePath $pythonLauncher -Arguments @("-3.11", "-m", "venv", $Script:HostImageVenvDir)
        Write-Ok "Created host image-service virtual environment"
    }

    if (Test-HostImageDependencies) {
        Write-Ok "Host image-service Python dependencies already installed"
        return
    }

    $pythonExe = Get-HostImagePythonPath
    Invoke-Checked -FilePath $pythonExe -Arguments @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel")
    Invoke-Checked -FilePath $pythonExe -Arguments @("-m", "pip", "install", "-r", "docker/qwen-image-service/requirements.txt")
    Invoke-Checked -FilePath $pythonExe -Arguments @("-m", "pip", "install", "torch-directml")
    Write-Ok "Installed host image-service Python dependencies"
}

function Read-HostImagePid {
    if (-not (Test-Path $Script:HostImagePidPath)) {
        return $null
    }

    $raw = (Get-Content -Path $Script:HostImagePidPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return [int]$raw
}

function Test-ProcessAlive([int]$Pid) {
    try {
        $null = Get-Process -Id $Pid -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Stop-HostImageService {
    $pid = Read-HostImagePid
    if ($null -eq $pid) {
        return
    }

    if (Test-ProcessAlive $pid) {
        Stop-Process -Id $pid -Force
        Write-Ok "Stopped host qwen-image-service (PID $pid)"
    }

    Remove-Item -Path $Script:HostImagePidPath -Force -ErrorAction SilentlyContinue
}

function Start-HostImageService {
    if ($NoHostImageService) {
        Write-WarnLine "Host image service disabled; image generation remains off unless you start another endpoint manually"
        return $null
    }

    Ensure-HostImageEnvironment

    $existingHealth = Get-JsonEndpoint "http://127.0.0.1:5005/health"
    if ($existingHealth -and $existingHealth.Body.status -in @("ok", "loading")) {
        Write-Ok "Host qwen-image-service already responding ($($existingHealth.Body.status))"
        return $existingHealth.Body
    }

    $existingPid = Read-HostImagePid
    if ($null -ne $existingPid -and -not (Test-ProcessAlive $existingPid)) {
        Remove-Item -Path $Script:HostImagePidPath -Force -ErrorAction SilentlyContinue
    }

    $pythonExe = Get-HostImagePythonPath
    $appDir = Join-Path $Script:RepoRoot "docker\qwen-image-service"
    $powerShellCommand = Get-Tool "powershell.exe"
    if (-not $powerShellCommand) {
        $powerShellCommand = Get-Tool "powershell"
    }
    if (-not $powerShellCommand) {
        throw "Could not locate powershell.exe to launch the host image service."
    }

    $powerShellExe = $powerShellCommand.Source
    $escapedAppDir = $appDir.Replace("'", "''")
    $escapedPython = $pythonExe.Replace("'", "''")
    $escapedModel = $ImageModel.Replace("'", "''")
    $command = "& { Set-Location '$escapedAppDir'; " +
        "`$env:COMPUTE_BACKEND='directml'; " +
        "`$env:UNIFIED_MEMORY='true'; " +
        "`$env:QWEN_IMAGE_CPU_OFFLOAD='false'; " +
        "`$env:QWEN_IMAGE_MODEL='$escapedModel'; " +
        "& '$escapedPython' -m uvicorn app:app --host 0.0.0.0 --port 5005 }"

    $process = Start-Process -FilePath $powerShellExe `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Script:HostImageStdoutLog `
        -RedirectStandardError $Script:HostImageStderrLog `
        -PassThru

    Set-Content -Path $Script:HostImagePidPath -Value ($process.Id.ToString() + "`r`n") -Encoding Ascii
    Write-Ok "Started host qwen-image-service (PID $($process.Id))"

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $health = Get-JsonEndpoint "http://127.0.0.1:5005/health"
        if ($health -and $health.Body.status -eq "ok") {
            Write-Ok "Host qwen-image-service is ready"
            return $health.Body
        }
        if ($health -and $health.Body.status -eq "loading") {
            Write-Info "Host qwen-image-service is loading the model"
            return $health.Body
        }
        if ($health -and $health.Body.status -eq "error") {
            throw "Host qwen-image-service failed to load: $($health.Body.error)"
        }
        Start-Sleep -Seconds 3
    }

    Write-WarnLine "Host qwen-image-service did not expose /health within 90 seconds; check the logs if image generation stays unavailable"
    return $null
}

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ComposeArguments,

        [switch]$AllowFailure
    )

    $arguments = @(
        "compose",
        "-f", "docker-compose.yml",
        "-f", ".starlingai/runtime/compose.mixed.yml"
    ) + $ComposeArguments

    return Invoke-Checked -FilePath "docker" -Arguments $arguments -AllowFailure:$AllowFailure
}

function Start-DockerCore {
    Write-Section "Starting Docker-managed StarlingAI services"
    $composeArgs = @("up", "-d")
    if (-not $SkipDockerBuild) {
        $composeArgs += "--build"
    }
    $composeArgs += @(
        "postgres",
        "redis",
        "fastapi-mcp-template",
        "qwen3-asr-service",
        "qwen3-tts-service",
        "gateway",
        "web",
        "tutorials"
    )

    Invoke-DockerCompose -ComposeArguments $composeArgs
    Wait-ForGatewayHealth
    Write-Ok "Gateway is healthy"
}

function Stop-DockerCore {
    Write-Section "Stopping Docker-managed StarlingAI services"
    Invoke-DockerCompose -ComposeArguments @("down") -AllowFailure
}

function Write-AdminToken {
    if (-not (Test-NodeDependencySet)) {
        Write-WarnLine "Skipping token generation because node_modules is missing"
        return
    }

    Push-Location $Script:RepoRoot
    try {
        $token = & node scripts/gen-token.mjs
        if ($LASTEXITCODE -ne 0) {
            throw "Token generation failed"
        }
        $token = $token.Trim()
        Set-Content -Path $Script:TokenPath -Value ($token + "`r`n") -Encoding Ascii
        Write-Ok "Generated dashboard token"
        Write-Host $token -ForegroundColor White
    }
    finally {
        Pop-Location
    }
}

function Show-StackStatus {
    New-ManagedDirectories
    Write-MixedRuntimeFiles

    Write-Section "Docker status"
    Invoke-DockerCompose -ComposeArguments @("ps") -AllowFailure | Out-Null

    $gateway = Get-JsonEndpoint "http://127.0.0.1:8765/healthz"
    if ($gateway -and $gateway.StatusCode -eq 200) {
        Write-Ok "Gateway: healthy"
    }
    else {
        Write-WarnLine "Gateway: unavailable"
    }

    $lmStudio = Get-JsonEndpoint "http://127.0.0.1:1234/v1/models"
    if ($lmStudio -and $lmStudio.StatusCode -eq 200) {
        Write-Ok "LM Studio: reachable"
    }
    else {
        Write-WarnLine "LM Studio: unavailable"
    }

    if (-not $NoHostImageService) {
        $imageHealth = Get-JsonEndpoint "http://127.0.0.1:5005/health"
        if ($imageHealth) {
            $status = $imageHealth.Body.status
            Write-Info "Host image service: $status"
            if ($status -eq "error") {
                Write-WarnLine "$($imageHealth.Body.error)"
            }
        }
        else {
            Write-WarnLine "Host image service: unavailable"
        }
    }
}

function Invoke-Up {
    Write-Section "Validating required tools"
    Assert-Tool "node" "Install Node.js 22+ and rerun the script."
    Assert-Tool "docker" "Install Docker Desktop and make sure 'docker compose' works."
    Assert-DockerCompose
    Ensure-Pnpm

    New-ManagedDirectories
    Ensure-BaseConfig
    Ensure-ProjectSecrets
    Ensure-NodePackages
    Write-MixedRuntimeFiles
    Test-LmStudio
    Start-HostImageService | Out-Null
    Start-DockerCore
    Write-AdminToken

    Write-Section "Endpoints"
    Write-Host "Dashboard : http://localhost:3001"
    Write-Host "Tutorials : http://localhost:3002"
    Write-Host "Gateway   : http://localhost:8765"
    if (-not $NoHostImageService) {
        Write-Host "Image API : http://localhost:5005"
    }
}

function Invoke-Down {
    New-ManagedDirectories
    Write-MixedRuntimeFiles
    Stop-HostImageService
    Stop-DockerCore
}

switch ($Action) {
    "up" {
        Invoke-Up
    }
    "down" {
        Invoke-Down
    }
    "status" {
        Show-StackStatus
    }
}