param(
    [switch]$Stop,
    [switch]$Status,
    [string]$Pull,
    [switch]$Help
)

if ($Help) {
    Write-Host "Local LLM server for the operator assistant (Ollama, portable build in .\ollama\)"
    Write-Host "Usage:"
    Write-Host "  .\scripts\ollama.ps1                 Start the server on 127.0.0.1:11434"
    Write-Host "  .\scripts\ollama.ps1 -Pull qwen3:4b  Download another model (into .\ollama\models)"
    Write-Host "  .\scripts\ollama.ps1 -Status         Server version, installed and loaded models"
    Write-Host "  .\scripts\ollama.ps1 -Stop           Stop the server"
    Write-Host "Everything - binaries, models, identity key, logs, temp files - stays under .\ollama\"
    Write-Host "(nothing on C:). Install the binaries once from the release zip:"
    Write-Host "  https://github.com/ollama/ollama/releases -> ollama-windows-amd64.zip, extract into .\ollama\app\"
    exit 0
}

$ErrorActionPreference = "Stop"
$Root = Join-Path (Split-Path -Parent $PSScriptRoot) "ollama"
$Exe = Join-Path $Root "app\ollama.exe"
if (-not (Test-Path $Exe)) { throw "Ollama not found at $Exe - see .\scripts\ollama.ps1 -Help" }

# Ollama keeps its identity key in ~/.ollama and writes temp files to %TEMP%; point both at .\ollama\.
foreach ($d in "models", "home", "logs", "tmp") { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
$env:OLLAMA_MODELS = Join-Path $Root "models"
$env:OLLAMA_HOST = "127.0.0.1:11434"
$env:USERPROFILE = Join-Path $Root "home"
$env:HOME = $env:USERPROFILE
$env:TEMP = Join-Path $Root "tmp"
$env:TMP = $env:TEMP
# Two resident models plus the CUDA screening engine on one 8 GB card exhausted it once and the display
# driver reset ("GPU is lost" until a reboot). So: one model at a time, 1 GiB of VRAM left for the
# desktop, and - on multi-GPU hosts - LLM_GPU in .env (an nvidia-smi UUID or index) pins Ollama to its
# own card while PHYSICS_GPU (docker-compose.gpu.yml) keeps the screening engine on another.
$env:OLLAMA_MAX_LOADED_MODELS = "1"
# Set OLLAMA_GPU_OVERHEAD=0 beforehand when the LLM is pinned to a card with no display attached.
if (-not $env:OLLAMA_GPU_OVERHEAD) { $env:OLLAMA_GPU_OVERHEAD = "1073741824" }
# 8-bit KV cache (needs flash attention): about half the context memory of the f16 default.
$env:OLLAMA_FLASH_ATTENTION = "1"
$env:OLLAMA_KV_CACHE_TYPE = "q8_0"
$dotenv = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
$llmGpu = $env:LLM_GPU
if (-not $llmGpu -and (Test-Path $dotenv)) {
    $m = Select-String -Path $dotenv -Pattern '^\s*LLM_GPU\s*=\s*(\S+)' | Select-Object -First 1
    if ($m) { $llmGpu = $m.Matches[0].Groups[1].Value }
}
if ($llmGpu) {
    $env:CUDA_VISIBLE_DEVICES = $llmGpu
    # The Vulkan backend ignores CUDA_VISIBLE_DEVICES and still sees every card - it once picked the
    # display card over the pinned one (more free memory). With a pin, CUDA only.
    $env:OLLAMA_VULKAN = "0"
}

function Test-Server {
    try { (Invoke-RestMethod -TimeoutSec 2 "http://127.0.0.1:11434/api/version").version } catch { $null }
}

if ($Stop) {
    Get-Process ollama -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
    # The model runners outlive a killed server and keep their VRAM - stop them too.
    Get-Process llama-server -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like (Join-Path $Root "app\*") } | Stop-Process -Force
    Write-Host "Ollama stopped."
    exit 0
}

if ($Status) {
    $v = Test-Server
    if (-not $v) { Write-Host "Ollama is not running."; exit 1 }
    Write-Host "Ollama $v at http://127.0.0.1:11434 (models in $env:OLLAMA_MODELS)"
    & $Exe list
    & $Exe ps
    exit 0
}

if (-not (Test-Server)) {
    $log = Join-Path $Root "logs\server.log"
    Start-Process $Exe -ArgumentList "serve" -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Root "logs\server.out.log") -RedirectStandardError $log
    for ($i = 0; $i -lt 30 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Server)) { throw "Ollama did not start - see $log" }
    Write-Host "Ollama $(Test-Server) started (models: $env:OLLAMA_MODELS, log: $log)"
} else {
    Write-Host "Ollama $(Test-Server) is already running."
}

if ($Pull) { & $Exe pull $Pull }
