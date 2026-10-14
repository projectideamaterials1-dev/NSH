param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$Cpu,
    [switch]$Help
)

if ($Help) {
    Write-Host "Brings the whole NSH stack up or down: Docker Desktop, the compose stack (prod + GPU + monitoring)"
    Write-Host "and the local LLM server for the assistant."
    Write-Host "Usage:"
    Write-Host "  .\scripts\stack.ps1           Start everything and wait until the backend is healthy"
    Write-Host "  .\scripts\stack.ps1 -Cpu      Start with the CPU screening engine (no GPU reservation). Also chosen"
    Write-Host "                                automatically when nvidia-smi cannot see a working GPU."
    Write-Host "  .\scripts\stack.ps1 -Status   Show what is running"
    Write-Host "  .\scripts\stack.ps1 -Stop     Stop cleanly (backend saves state to Redis), e.g. before a reboot"
    exit 0
}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Ollama = Join-Path $PSScriptRoot "ollama.ps1"

function Test-Docker { docker info --format "{{.ServerVersion}}" 2>$null | Out-Null; return $LASTEXITCODE -eq 0 }

function Test-Gpu {
    # After a display-driver reset the card can be "lost" until a reboot; the GPU compose file then
    # cannot even start the container (its device reservation fails), so check before choosing.
    $out = nvidia-smi -L 2>$null
    return $LASTEXITCODE -eq 0 -and ($out -match "^GPU 0")
}

function Get-Compose([bool]$gpu) {
    $files = @("-f", (Join-Path $Root "docker-compose.prod.yml"))
    if ($gpu) { $files += @("-f", (Join-Path $Root "docker-compose.gpu.yml")) }
    return @("compose") + $files + @("--profile", "monitoring")
}

$Compose = Get-Compose $true

function Get-Health {
    # curl.exe: works on Windows PowerShell 5.1 too (no -SkipCertificateCheck there); the dev cert is self-signed.
    $raw = curl.exe -sk --max-time 5 https://localhost/health 2>$null
    if (-not $raw) { return $null }
    try { return $raw | ConvertFrom-Json } catch { return $null }
}

function Show-Status {
    Write-Host "Docker:  $(if (Test-Docker) { 'running' } else { 'stopped' })"
    if (Test-Docker) { docker @Compose ps --format "  {{.Name}}  {{.Status}}" }
    $h = Get-Health
    if ($h) {
        Write-Host "Backend: status=$($h.status) engine_ready=$($h.engine_ready) leader=$($h.is_leader) live=$($h.live) persistence=$($h.persistence) gpu=$($h.gpu)"
        if ($h.screening -and -not $h.screening.ok) {
            Write-Host "WARNING: conjunction screening is failing ($($h.screening.consecutive_failures) cycles): $($h.screening.last_error)" -ForegroundColor Red
        }
    } else { Write-Host "Backend: not reachable at https://localhost" }
    $a = curl.exe -sk --max-time 5 https://localhost/api/assistant/status 2>$null
    Write-Host "Assistant: $(if ($a) { $a } else { 'not reachable' })"
}

if ($Status) { Show-Status; exit 0 }

if ($Stop) {
    if (Test-Docker) {
        Write-Host "Stopping the compose stack (backend writes a final Redis snapshot)..."
        docker @Compose stop
    }
    & $Ollama -Stop
    if (Test-Docker) { docker desktop stop }
    Write-Host "Everything stopped. Start again with .\scripts\stack.ps1"
    exit 0
}

# 1. Docker Desktop (auto-start is off; its disk lives in D:\NSH\docker)
if (-not (Test-Docker)) {
    Write-Host "Starting Docker Desktop..."
    docker desktop start 2>$null
    if ($LASTEXITCODE -ne 0) { Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" }
    for ($i = 0; $i -lt 90 -and -not (Test-Docker); $i++) { Start-Sleep 2 }
    if (-not (Test-Docker)) { throw "Docker Desktop did not start within 3 minutes" }
}
Write-Host "Docker is running."

# 2. Local LLM server for the assistant (before the backend, so its first status check succeeds)
& $Ollama

# 3. The stack: same files and profile it was created with; existing images, no rebuild
$useGpu = -not $Cpu -and (Test-Gpu)
if (-not $useGpu) {
    if (-not $Cpu) {
        Write-Host "WARNING: nvidia-smi sees no working GPU - starting with the CPU screening engine. Reboot to recover the GPU." -ForegroundColor Yellow
    }
    $Compose = Get-Compose $false
    # The GPU image is the one kept current; it runs on the CPU when told to.
    $env:BACKEND_IMAGE = "nsh-backend:gpu"
    $env:ACM_ENGINE = "cpp"
}
Write-Host "Starting the NSH stack ($(if ($useGpu) { 'GPU' } else { 'CPU' }) screening)..."
docker @Compose up -d --no-build
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# 4. Wait for the backend to restore state from Redis and take leadership
Write-Host "Waiting for the backend..."
for ($i = 0; $i -lt 60; $i++) {
    $h = Get-Health
    if ($h -and $h.engine_ready -and $h.is_leader) { break }
    Start-Sleep 3
}
Show-Status
Write-Host "Dashboard: https://localhost"
