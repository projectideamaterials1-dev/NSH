param(
    [switch]$Demo,
    [switch]$Live,
    [ValidateRange(1, 500)][int]$Satellites = 0,
    [switch]$Help
)

if ($Help) {
    Write-Host "Crimson Nebula - Windows PowerShell Launcher" -ForegroundColor Cyan
    Write-Host "Usage:"
    Write-Host "  .\run.ps1          Start backend (:8000) and dashboard (:3000)"
    Write-Host "  .\run.ps1 -Demo    Seed demo mission (50 sats, 10k debris, planted threats)"
    Write-Host "  .\run.ps1 -Live    Track real satellites & debris in real time via CelesTrak"
    Write-Host "  .\run.ps1 -Live -Satellites 120   ...starting with 120 satellites (default 150; resizable in the dashboard)"
    exit 0
}

$ErrorActionPreference = "Stop"
$RootDir = $PSScriptRoot
$BackendDir = Join-Path $RootDir "backend"
$VenvDir = Join-Path $BackendDir ".venv"
$FrontendDir = Join-Path $RootDir "frontend"
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"

Write-Host "🛰️ Starting Crimson Nebula..." -ForegroundColor Cyan

# 1. Ensure Python venv exists
if (-not (Test-Path $PythonExe)) {
    Write-Host "🐍 Creating isolated backend virtualenv ($VenvDir)..." -ForegroundColor Yellow
    python -m venv $VenvDir
}

# 2. Check dependencies
Write-Host "🔍 Verifying Python dependencies..." -ForegroundColor DarkGray
& $PythonExe -c "import fastapi, uvicorn, numpy, pydantic, pythonjsonlogger, orjson, sgp4" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "📦 Installing required Python dependencies into backend/.venv..." -ForegroundColor Yellow
    & $PythonExe -m pip install --upgrade pip
    & $PythonExe -m pip install -r (Join-Path $BackendDir "requirements.txt")
}

if ($Demo) {
    & $PythonExe -c "import requests" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $PythonExe -m pip install requests
    }
}

# 3. Check frontend node_modules
if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "📦 Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location $FrontendDir
    try {
        npm install
    } finally {
        Pop-Location
    }
}

# 4. Set live mode environment if requested
if ($Live) {
    $env:REALWORLD_FLEET = if ($env:REALWORLD_FLEET) { $env:REALWORLD_FLEET } else { "isro-eo,stations,planet,oneweb,starlink,gps-ops,weather,resource,science" }
    $env:REALWORLD_OBJECTS = if ($env:REALWORLD_OBJECTS) { $env:REALWORLD_OBJECTS } else { "fengyun-1c-debris,cosmos-2251-debris,iridium-33-debris" }
    $env:REALWORLD_MAX_SATELLITES = if ($Satellites -gt 0) { "$Satellites" } elseif ($env:REALWORLD_MAX_SATELLITES) { $env:REALWORLD_MAX_SATELLITES } else { "150" }
}

# 5. Start Backend
Write-Host "🚀 Starting Backend on http://localhost:8000 ..." -ForegroundColor Green
$BackendJob = Start-Job -ScriptBlock {
    param($Dir, $Py)
    Set-Location $Dir
    & $Py -m uvicorn satellite_api.main:app --host 127.0.0.1 --port 8000
} -ArgumentList $BackendDir, $PythonExe

# Wait for backend health
Write-Host "⏳ Waiting for backend to become healthy..." -ForegroundColor DarkGray
$Healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($res -and $res.status -in @("ok", "online")) {
            $Healthy = $true
            break
        }
    } catch { }
}

if (-not $Healthy) {
    Write-Host "⚠️ Warning: Backend health check timed out. Output log:" -ForegroundColor Yellow
    Receive-Job $BackendJob
}

# 6. Start Frontend
Write-Host "💻 Starting Frontend on http://localhost:3000 ..." -ForegroundColor Green
$FrontendJob = Start-Job -ScriptBlock {
    param($Dir)
    Set-Location $Dir
    npm run dev
} -ArgumentList $FrontendDir

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "✅ Crimson Nebula is running!" -ForegroundColor Green
Write-Host "   - Web Dashboard:     http://localhost:3000"
Write-Host "   - Backend API Docs:  http://localhost:8000/docs"
Write-Host "   - Health Endpoint:   http://localhost:8000/health"
Write-Host ""

if ($Demo) {
    Write-Host "🎬 Demo mode: seeding 50 satellites, 10,000 debris and planted threats..." -ForegroundColor Magenta
    Push-Location $BackendDir
    try {
        & $PythonExe scripts/demo.py --url http://127.0.0.1:8000
    } finally {
        Pop-Location
    }
} elseif ($Live) {
    Write-Host "🛰️ Live mode: real satellites ($env:REALWORLD_FLEET) tracked in real time" -ForegroundColor Magenta
} else {
    Write-Host "📡 To populate the simulation:"
    Write-Host "   Demo mission:     .\run.ps1 -Demo"
    Write-Host "   Real satellites:  .\run.ps1 -Live  (or use dashboard 'Load real satellites')"
}
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop services." -ForegroundColor Yellow
Write-Host ""

try {
    while ($true) {
        # Stream any backend or frontend logs
        Receive-Job -Job $BackendJob | ForEach-Object { Write-Host "[Backend] $_" -ForegroundColor Gray }
        Receive-Job -Job $FrontendJob | ForEach-Object { Write-Host "[Frontend] $_" -ForegroundColor DarkCyan }
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host "`n🛑 Shutting down Crimson Nebula services..." -ForegroundColor Red
    Stop-Job -Job $BackendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $BackendJob -ErrorAction SilentlyContinue
    Stop-Job -Job $FrontendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $FrontendJob -ErrorAction SilentlyContinue
}
