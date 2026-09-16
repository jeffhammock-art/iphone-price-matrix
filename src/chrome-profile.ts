import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export const chromeProfileDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", ".chrome-profile");

export async function releaseChromeProfile(): Promise<void> {
  if (process.platform === "win32") {
    const escaped = chromeProfileDir.replaceAll("'", "''");
    const script = `
      Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*${escaped}*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    `;
    await execFileAsync("powershell", ["-NoProfile", "-Command", script], { windowsHide: true }).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
