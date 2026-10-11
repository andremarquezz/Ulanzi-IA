param(
    [ValidateSet('close', 'list', 'wait')]
    [string]$Mode = 'close',
    [int]$TimeoutSeconds = 35,
    [int]$MinimumCount = 1
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class CodexWindow {
    public long Handle { get; set; }
    public int Pid { get; set; }
    public string Title { get; set; }
}

public static class CodexWindowTools {
    private delegate bool EnumWindowsDelegate(IntPtr hwnd, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsDelegate callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const uint WM_CLOSE = 0x0010;

    public static CodexWindow[] List() {
        var result = new List<CodexWindow>();

        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (!IsWindowVisible(hwnd)) return true;

            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return true;

            try {
                using (var process = Process.GetProcessById((int)pid)) {
                    if (!process.ProcessName.Equals("Code", StringComparison.OrdinalIgnoreCase)) {
                        return true;
                    }
                }
            } catch {
                return true;
            }

            int length = GetWindowTextLength(hwnd);
            if (length == 0) return true;

            var buffer = new StringBuilder(length + 1);
            GetWindowText(hwnd, buffer, buffer.Capacity);
            var title = buffer.ToString().Trim();
            if (title.Length == 0) return true;

            result.Add(new CodexWindow {
                Handle = hwnd.ToInt64(),
                Pid = (int)pid,
                Title = title,
            });
            return true;
        }, IntPtr.Zero);

        return result.ToArray();
    }

    public static void Close(long hwnd) {
        if (!PostMessage(new IntPtr(hwnd), WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) {
            throw new InvalidOperationException("Nao foi possivel solicitar fechamento da janela: " + hwnd);
        }
    }
}
'@ -ErrorAction Stop

if ($Mode -eq 'wait') {
    $deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSeconds))
    $windows = @([CodexWindowTools]::List())
    while ($windows.Count -lt $MinimumCount -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $windows = @([CodexWindowTools]::List())
    }

    [PSCustomObject]@{
        success = $windows.Count -ge $MinimumCount
        windows = @($windows | ForEach-Object {
            [PSCustomObject]@{ pid = $_.Pid; title = $_.Title }
        })
    } | ConvertTo-Json -Compress -Depth 5
    exit 0
}

$initial = @([CodexWindowTools]::List())
if ($Mode -eq 'list') {
    [PSCustomObject]@{
        success = $true
        windows = @($initial | ForEach-Object {
            [PSCustomObject]@{ pid = $_.Pid; title = $_.Title }
        })
    } | ConvertTo-Json -Compress -Depth 5
    exit 0
}

foreach ($window in $initial) {
    [CodexWindowTools]::Close($window.Handle)
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    $remaining = @([CodexWindowTools]::List())
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 350
} while ((Get-Date) -lt $deadline)

$remaining = @([CodexWindowTools]::List())
$success = $remaining.Count -eq 0
$forceClosedBackground = $false
$stopAttempts = 0
$backgroundBefore = @()
$backgroundErrors = @()

if ($success) {
    # Give VS Code time to save its window state and shut down voluntarily.
    Start-Sleep -Milliseconds 1500
    $remaining = @([CodexWindowTools]::List())
    $success = $remaining.Count -eq 0

    if ($success) {
        $backgroundBefore = @(Get-Process -Name Code -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
        $backgroundDeadline = (Get-Date).AddSeconds(12)

        # Stop-Process can return before the process has actually exited.
        # Retry and poll instead of declaring failure immediately after a kill.
        while ((Get-Date) -lt $backgroundDeadline) {
            $background = @(Get-Process -Name Code -ErrorAction SilentlyContinue)
            if ($background.Count -eq 0) { break }

            # Never force-kill a visible editor or a visible unsaved-changes dialog.
            $remaining = @([CodexWindowTools]::List())
            if ($remaining.Count -gt 0) {
                $success = $false
                break
            }

            $stopAttempts++
            foreach ($proc in $background) {
                try {
                    Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                    $forceClosedBackground = $true
                }
                catch {
                    $backgroundErrors += ('PID ' + $proc.Id + ': ' + $_.Exception.Message)
                }
            }

            # The process may be in the middle of exiting even after Stop-Process.
            Start-Sleep -Milliseconds 650
        }
    }
}

$remaining = @([CodexWindowTools]::List())
$processes = @(Get-Process -Name Code -ErrorAction SilentlyContinue)
$success = $success -and $remaining.Count -eq 0 -and $processes.Count -eq 0

[PSCustomObject]@{
    success = $success
    windowsBefore = @($initial | ForEach-Object {
        [PSCustomObject]@{ pid = $_.Pid; title = $_.Title }
    })
    windowsRemaining = @($remaining | ForEach-Object {
        [PSCustomObject]@{ pid = $_.Pid; title = $_.Title }
    })
    backgroundProcessesBefore = @($backgroundBefore)
    backgroundProcessesRemaining = @($processes | Select-Object -ExpandProperty Id)
    backgroundStopAttempts = $stopAttempts
    backgroundErrors = @($backgroundErrors | Select-Object -Unique)
    backgroundProcessesStopped = $forceClosedBackground
    processesRemaining = $processes.Count
} | ConvertTo-Json -Compress -Depth 5
