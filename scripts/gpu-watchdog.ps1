param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Help
)

if ($Help) {
    Write-Host "GPU crash watchdog. Runs in the background and, the moment the display driver resets (TDR,"
    Write-Host "event 4101 / nvlddmkm) or the GPU stops answering, kills the GPU work on the display card"
    Write-Host "(the local LLM) and restarts it on the CPU, so the driver can recover and the screen comes back"
    Write-Host "instead of the machine freezing. The backend's screening engine is on another card and falls"
    Write-Host "back to the CPU by itself, so it is left alone."
    Write-Host "Usage:"
    Write-Host "  .\scripts\gpu-watchdog.ps1             Run in this window (Ctrl+C to stop)"
    Write-Host "  .\scripts\gpu-watchdog.ps1 -Install    Start now and at every logon (scheduled task, hidden)"
    Write-Host "  .\scripts\gpu-watchdog.ps1 -Uninstall  Remove the scheduled task and stop it"
    Write-Host "  .\scripts\gpu-watchdog.ps1 -Status     Is it running, and the last incidents"
    Write-Host "Log: .\logs\gpu-watchdog.log. If the screen still goes black: Win+Ctrl+Shift+B resets the driver."
    exit 0
}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "logs"
$Log = Join-Path $LogDir "gpu-watchdog.log"
$TaskName = "NSH GPU watchdog"
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    # A reader (tail, an editor) can hold the file for a moment; a failed log write must never stop the watchdog.
    for ($i = 0; $i -lt 10; $i++) {
        try { [System.IO.File]::AppendAllText($Log, "$line`r`n"); return } catch { Start-Sleep -Milliseconds 200 }
    }
}

function Get-WatchdogProcess {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
        Where-Object { $_.CommandLine -match 'gpu-watchdog\.ps1' -and $_.CommandLine -notmatch '-(Install|Uninstall|Status|Help)' -and $_.ProcessId -ne $PID }
}

if ($Status) {
    $p = Get-WatchdogProcess
    Write-Host "Watchdog: $(if ($p) { "running (pid $($p.ProcessId -join ', '))" } else { 'NOT running' })"
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "Autostart at logon: $(if ($t) { $t.State } else { 'not installed' })"
    if (Test-Path $Log) { Write-Host "--- last log lines ($Log)"; Get-Content $Log -Tail 15 }
    exit 0
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-WatchdogProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "Watchdog removed."
    exit 0
}

if ($Install) {
    $ps = (Get-Process -Id $PID).Path
    $action = New-ScheduledTaskAction -Execute $ps `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    # At logon, plus every 5 minutes as a resurrection check (a running instance holds the mutex, so the
    # extra starts exit at once).
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $trigger = @((New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"), $repeat)
    # No time limit, restart if it ever dies, run on battery.
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "Kills GPU compute on a display-driver reset so the screen recovers (D:\NSH)" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep 3
    Write-Host "Installed: '$TaskName' runs at every logon and is running now. Log: $Log"
    exit 0
}

# ---------------------------------------------------------------- the watchdog loop

# One instance only.
$mutex = New-Object System.Threading.Mutex($false, "Local\NSH-GPU-Watchdog")
if (-not $mutex.WaitOne(0)) { Write-Host "Another watchdog is already running."; exit 0 }

Add-Type -AssemblyName System.Windows.Forms
function Show-Notice([string]$title, [string]$text) {
    try {
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Warning
        $n.Visible = $true
        $n.ShowBalloonTip(15000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep 6
        $n.Dispose()
    } catch { }
}

function Test-GpuResponsive {
    # A hung driver makes nvidia-smi hang too, so never wait on it without a timeout.
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo "nvidia-smi.exe", "-L"
        $psi.CreateNoWindow = $true
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch { }; return "nvidia-smi hung for 15 s" }
        $out = $p.StandardOutput.ReadToEnd()
        if ($p.ExitCode -ne 0) { return "nvidia-smi failed (exit $($p.ExitCode))" }
        if ($out -notmatch "^GPU 0") { return "nvidia-smi lists no GPU" }
        return $null
    } catch { return "nvidia-smi could not run: $($_.Exception.Message)" }
}

$OllamaExe = Join-Path $Root "ollama\app\ollama.exe"
$OllamaScript = Join-Path $PSScriptRoot "ollama.ps1"

function Stop-GpuWork([string]$reason) {
    Write-Log "INCIDENT: $reason - stopping GPU work on the display card"
    # The LLM runner (llama-server / ollama runner children) is what runs on the display card.
    $killed = @()
    foreach ($name in "llama-server", "ollama") {
        Get-Process $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force; $killed += "$($_.Name)($($_.Id))" } catch { }
        }
    }
    Write-Log "  killed: $(if ($killed) { $killed -join ', ' } else { 'nothing GPU-related was running' })"

    # Give the driver a moment to finish its reset, then bring the assistant back on the CPU only, so
    # anything still sending chats (the UI, an eval) cannot hit the card again until a deliberate restart.
    Start-Sleep 5
    if ($killed -and (Test-Path $OllamaExe)) {
        try {
            $env:LLM_GPU = "-1"   # CUDA_VISIBLE_DEVICES=-1 -> no GPU
            & $OllamaScript *>> $Log
            Write-Log "  Ollama restarted on the CPU (slow but safe). Run .\scripts\ollama.ps1 -Stop; .\scripts\ollama.ps1 for GPU again."
        } catch { Write-Log "  Ollama restart failed: $($_.Exception.Message)" }
    }
    Show-Notice "NSH: GPU driver reset" "GPU work was stopped so the display can recover. The assistant now runs on the CPU. Details: $Log"
}

# Report crashes that happened while nothing could run (hard freezes end in a power-button reset).
$lastRun = if (Test-Path $Log) { (Get-Item $Log).LastWriteTime } else { (Get-Date).AddDays(-1) }
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = $lastRun } -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Log "NOTE: unclean restart at $($_.TimeCreated) (the machine froze or lost power before this boot)" }

Write-Log "Watchdog started (pid $PID)"
$since = Get-Date
$lastGpuCheck = [datetime]::MinValue
$cooldownUntil = [datetime]::MinValue
$gpuWasOk = $true
$gpuFailures = 0
$heartbeat = Get-Date

while ($true) {
  try {
    $now = Get-Date
    $reason = $null

    # 1. Display-driver reset events: 4101 "Display driver nvlddmkm stopped responding", nvlddmkm errors.
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display', 'nvlddmkm'; StartTime = $since } -ErrorAction SilentlyContinue
    $since = $now
    if ($ev) {
        $first = $ev | Sort-Object TimeCreated | Select-Object -First 1
        $reason = "display driver event $($first.Id) ($($first.ProviderName)) at $($first.TimeCreated)"
    }

    # 2. Every 30 s: does the GPU still answer?
    if (-not $reason -and ($now - $lastGpuCheck).TotalSeconds -ge 30) {
        $lastGpuCheck = $now
        $bad = Test-GpuResponsive
        # Two failed checks in a row (one can be a hiccup while a model loads).
        $gpuFailures = if ($bad) { $gpuFailures + 1 } else { 0 }
        if ($bad) { Write-Log "GPU check failed ($gpuFailures in a row): $bad" }
        if ($gpuFailures -eq 2) { $reason = $bad; $gpuWasOk = $false }
        if (-not $bad -and -not $gpuWasOk) { Write-Log "GPU answers again"; $gpuWasOk = $true }
    }

    if ($reason -and $now -ge $cooldownUntil) {
        Stop-GpuWork $reason
        $cooldownUntil = (Get-Date).AddMinutes(2)
    }

    if (($now - $heartbeat).TotalHours -ge 6) { Write-Log "alive"; $heartbeat = $now }
  } catch {
    Write-Log "watchdog error (continuing): $($_.Exception.Message)"
  }
    Start-Sleep 3
}
