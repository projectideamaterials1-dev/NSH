param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$TestRecovery,
    [switch]$ResetTdr,
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
    Write-Host "  .\scripts\gpu-watchdog.ps1 -TestRecovery  Check the display now and print what recovery would do (changes nothing)"
    Write-Host "  .\scripts\gpu-watchdog.ps1 -ResetTdr   Remove the TdrDelay values -Install set (admin; reboot)"
    Write-Host "-Install asks for admin once (UAC): the task then runs elevated so it can restart the display driver,"
    Write-Host "and TdrDelay is raised from 2 s to 10 s so long GPU work no longer trips a driver reset (after a reboot)."
    Write-Host "When the screen goes black it: stops the LLM, waits for Windows' recovery, sends Win+Ctrl+Shift+B,"
    Write-Host "restarts the NVIDIA adapter's driver, then disables/enables it. Log: .\logs\gpu-watchdog.log."
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
        Where-Object { $_.CommandLine -match 'gpu-watchdog\.ps1' -and $_.CommandLine -notmatch '-(Install|Uninstall|Status|Help|TestRecovery|ResetTdr)' -and $_.ProcessId -ne $PID }
}

if ($Status) {
    # The running instance holds the mutex. (Its command line is unreadable from a non-elevated shell.)
    $held = $false
    try { $m = $null; $held = [System.Threading.Mutex]::TryOpenExisting("Local\NSH-GPU-Watchdog", [ref]$m) }
    catch [System.UnauthorizedAccessException] { $held = $true }
    $p = Get-WatchdogProcess
    Write-Host "Watchdog: $(if ($p) { "running (pid $($p.ProcessId -join ', '))" } elseif ($held) { 'running (elevated)' } else { 'NOT running' })"
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

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (($Install -or $ResetTdr) -and -not $IsAdmin) {
    # Re-run this command elevated (one UAC prompt) and wait for it.
    $ps = (Get-Process -Id $PID).Path
    $flag = if ($Install) { "-Install" } else { "-ResetTdr" }
    Write-Host "Asking for administrator rights (UAC prompt)..."
    $p = Start-Process $ps -Verb RunAs -Wait -PassThru `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $flag"
    Write-Host "Elevated run finished (exit $($p.ExitCode)). Log: $Log"
    if (Test-Path $Log) { Get-Content $Log -Tail 6 }
    exit $p.ExitCode
}

if ($ResetTdr) {
    $key = "HKLM:\System\CurrentControlSet\Control\GraphicsDrivers"
    Remove-ItemProperty -Path $key -Name TdrDelay, TdrDdiDelay -ErrorAction SilentlyContinue
    Write-Log "TdrDelay/TdrDdiDelay removed (Windows defaults after a reboot)"
    exit 0
}

if ($Install) {
    $key = "HKLM:\System\CurrentControlSet\Control\GraphicsDrivers"
    Set-ItemProperty -Path $key -Name TdrDelay -Value 10 -Type DWord
    Set-ItemProperty -Path $key -Name TdrDdiDelay -Value 20 -Type DWord
    Write-Log "TdrDelay=10 s, TdrDdiDelay=20 s set (takes effect after a reboot). Undo: -ResetTdr"
    # Replace the non-elevated instance with the elevated task.
    Get-WatchdogProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
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
    # Elevated, in the user's own session (so the balloon notices still show): restarting a display
    # adapter needs admin rights.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description "Kills GPU compute on a display-driver reset so the screen recovers (D:\NSH)" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep 3
    Write-Host "Installed: '$TaskName' runs at every logon and is running now. Log: $Log"
    exit 0
}

# ---------------------------------------------------------------- the watchdog loop

# One instance only.
$mutex = New-Object System.Threading.Mutex($false, "Local\NSH-GPU-Watchdog")
if (-not $TestRecovery -and -not $mutex.WaitOne(0)) { Write-Host "Another watchdog is already running."; exit 0 }

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
    Restore-Display
    Show-Notice "NSH: GPU driver reset" "GPU work was stopped so the display can recover. The assistant now runs on the CPU. Details: $Log"
}

# ---------------------------------------------------------------- display recovery

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NvidiaAdapters {
    Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'NVIDIA' }
}

function Get-DisplayProblem {
    # Unhealthy if the driver does not answer, or Windows marks an NVIDIA adapter as failed (code 43 etc.).
    $bad = Test-GpuResponsive
    if ($bad) { return $bad }
    foreach ($a in Get-NvidiaAdapters) {
        if ($a.Status -ne 'OK') { return "$($a.FriendlyName) is $($a.Status)" }
    }
    return $null
}

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NshKeys {
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    // Win+Ctrl+Shift+B: Windows' own "reset the graphics stack" hotkey (screen flickers, apps keep running).
    public static void ResetGraphics() {
        byte[] keys = { 0x5B, 0x11, 0x10, 0x42 };
        foreach (byte k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
    }
}
"@

function Wait-DisplayOk([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep 3
        if (-not (Get-DisplayProblem)) { return $true }
    }
    return $false
}

function Restore-Display([switch]$DryRun) {
    # Escalating steps, each only if the previous one did not bring the GPU back:
    #   1. wait for Windows' own TDR recovery   2. Win+Ctrl+Shift+B   3. restart the adapter's driver
    #   4. disable + enable the adapter. Steps 3-4 need the watchdog to run elevated (-Install does that).
    $problem = Get-DisplayProblem
    if (-not $problem) { Write-Log "  display OK - no recovery needed"; return }
    Write-Log "  display problem: $problem"
    if ($DryRun) {
        Write-Log "  (dry run) would: wait 20 s, send Win+Ctrl+Shift+B, restart-device, disable/enable: $((Get-NvidiaAdapters).FriendlyName -join ', ')"
        return
    }
    if (Wait-DisplayOk 20) { Write-Log "  display recovered on its own"; return }

    Write-Log "  step 2: Win+Ctrl+Shift+B"
    try { [NshKeys]::ResetGraphics() } catch { Write-Log "    hotkey failed: $($_.Exception.Message)" }
    if (Wait-DisplayOk 20) { Write-Log "  display recovered after the graphics reset hotkey"; return }

    if (-not (Test-Admin)) {
        Write-Log "  cannot restart the driver: the watchdog is not elevated. Run .\scripts\gpu-watchdog.ps1 -Install (accept the UAC prompt)."
        return
    }
    $adapters = @(Get-NvidiaAdapters | Sort-Object { $_.Status -eq 'OK' })   # failed ones first
    foreach ($a in $adapters) {
        Write-Log "  step 3: pnputil /restart-device $($a.FriendlyName)"
        & pnputil.exe /restart-device "$($a.InstanceId)" *>> $Log
        if (Wait-DisplayOk 30) { Write-Log "  display recovered after restarting $($a.FriendlyName)"; return }
    }
    foreach ($a in $adapters) {
        Write-Log "  step 4: disable + enable $($a.FriendlyName)"
        try {
            Disable-PnpDevice -InstanceId $a.InstanceId -Confirm:$false
            Start-Sleep 5
            Enable-PnpDevice -InstanceId $a.InstanceId -Confirm:$false
        } catch { Write-Log "    failed: $($_.Exception.Message)" }
        if (Wait-DisplayOk 30) { Write-Log "  display recovered after re-enabling $($a.FriendlyName)"; return }
    }
    Write-Log "  RECOVERY FAILED: $(Get-DisplayProblem). Only a reboot will bring the GPU back."
    Show-Notice "NSH: GPU did not recover" "Save your work and reboot. Details: $Log"
}

if ($TestRecovery) {
    $tdr = Get-ItemProperty "HKLM:\System\CurrentControlSet\Control\GraphicsDrivers" -ErrorAction SilentlyContinue
    Write-Host "Elevated: $(Test-Admin)   TdrDelay: $(if ($tdr.TdrDelay) { "$($tdr.TdrDelay) s" } else { 'default (2 s)' })"
    Get-NvidiaAdapters | ForEach-Object { Write-Host "Adapter: $($_.FriendlyName) - $($_.Status)" }
    Restore-Display -DryRun
    exit 0
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
