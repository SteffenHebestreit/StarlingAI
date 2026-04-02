[CmdletBinding()]
param(
    [ValidateSet("up", "down", "status")]
    [string]$Action = "up",

    [switch]$SkipNodeInstall,
    [switch]$SkipDockerBuild,
    [switch]$NoHostImageService,
    [string]$ImageModel = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-WarnLine([string]$Message) {
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Write-Info([string]$Message) {
    Write-Host "[info] $Message" -ForegroundColor Gray
}

function Invoke-RepoCommand([string[]]$Arguments) {
    Push-Location $repoRoot
    try {
        & node @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: node $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

Write-WarnLine "bootstrap-strix-halo.ps1 no longer provisions bundled host-native image generation."
Write-Info "Configure external STT, TTS, and image-generation endpoints in Settings or config/multimodal/10-multimodal.jsonc."

if ($NoHostImageService.IsPresent -or -not [string]::IsNullOrWhiteSpace($ImageModel)) {
    Write-Info "Legacy image-service flags are ignored. StarlingAI now uses external image backends only."
}

switch ($Action) {
    "up" {
        $args = @("scripts/sai.mjs", "start")
        if (-not $SkipDockerBuild) {
            $args += "--build"
        }
        Invoke-RepoCommand $args
    }
    "down" {
        Invoke-RepoCommand @("scripts/sai.mjs", "stop")
    }
    "status" {
        Invoke-RepoCommand @("scripts/sai.mjs", "health")
    }
}