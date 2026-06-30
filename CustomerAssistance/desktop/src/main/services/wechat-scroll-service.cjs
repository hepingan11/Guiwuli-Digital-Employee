const { execFile } = require("node:child_process");

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function encodePowerShell(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function escapePowerShellString(value) {
  return String(value || "").replace(/'/g, "''");
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(command)],
      { windowsHide: true, timeout: 8000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function scrollWechatHistory(options = {}) {
  const sourceName = escapePowerShellString(options.sourceName);
  const wheelNotches = clampInteger(options.wheelNotches, 1, 10, 5);
  const delta = wheelNotches * 120;

  const command = `
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class CaaWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

$needle = '${sourceName}'
$window = Get-Process |
  Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      $_.ProcessName -match 'WeChat|Weixin|微信' -or
      ($needle -and $_.MainWindowTitle -like "*$needle*") -or
      $_.MainWindowTitle -like '*微信*'
    )
  } |
  Sort-Object { if ($_.ProcessName -match 'WeChat|Weixin') { 0 } else { 1 } }, MainWindowTitle |
  Select-Object -First 1

if (-not $window) {
  throw 'WeChat window was not found. Open WeChat and keep the chat window visible.'
}

$rect = New-Object CaaWin32+RECT
[CaaWin32]::GetWindowRect($window.MainWindowHandle, [ref]$rect) | Out-Null
[CaaWin32]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 120

$x = [int]($rect.Left + (($rect.Right - $rect.Left) * 0.72))
$y = [int]($rect.Top + (($rect.Bottom - $rect.Top) * 0.48))
[CaaWin32]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 80
[CaaWin32]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)
Write-Output "scrolled"
`;

  await runPowerShell(command);
  return { ok: true, wheelNotches };
}

module.exports = {
  scrollWechatHistory
};
