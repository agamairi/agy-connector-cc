import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true,
  });
  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}
export function formatCommandFailure(result) {
  return [
    `${result.command} ${result.args.join(" ")}`.trim(),
    result.signal ? `signal=${result.signal}` : `exit=${result.status}`,
    (result.stderr || result.stdout || "").trim(),
  ]
    .filter(Boolean)
    .join(": ");
}
export function runCommandChecked(command, args, options) {
  const result = runCommand(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error?.code === "ENOENT") return { available: false, detail: "not found" };
  if (result.error) return { available: false, detail: result.error.message };
  if (result.status !== 0)
    return {
      available: false,
      detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`,
    };
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    (options.killImpl ?? process.kill.bind(process))(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    try {
      const stat = (options.readFileImpl ?? fs.readFileSync)(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
    } catch {
      return null;
    }
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  if (platform === "win32") {
    const result = runCommandImpl(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CreationDate.ToUniversalTime().Ticks`,
      ],
      {},
    );
    const value = result.status === 0 && !result.error ? result.stdout.trim() : "";
    return value ? `windows-start-ticks:${value}` : null;
  }

  const result = runCommandImpl("ps", ["-p", String(pid), "-o", "lstart="], {});
  const value = result.status === 0 && !result.error ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return value ? `posix-start:${value}` : null;
}
function signalTarget(pid, signal, method, killImpl) {
  const target = method === "process-group" ? -pid : pid;
  try {
    killImpl(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilGone(pid, method, options) {
  const deadline = Date.now() + options.gracePeriodMs;
  while (Date.now() < deadline) {
    if (!signalTarget(pid, 0, method, options.killImpl)) return true;
    await options.delayImpl(Math.min(options.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  return !signalTarget(pid, 0, method, options.killImpl);
}

export async function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) return { attempted: false, delivered: false, method: null };

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }
    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && /not found|cannot find|does not exist|no such process/i.test(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }
    if (result.error?.code !== "ENOENT") {
      if (result.error) throw result.error;
      throw new Error(formatCommandFailure(result));
    }
    try {
      killImpl(pid);
      return { attempted: true, delivered: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") return { attempted: true, delivered: false, method: "kill" };
      throw error;
    }
  }

  let method = "process-group";
  try {
    if (!signalTarget(pid, "SIGTERM", method, killImpl)) {
      return { attempted: true, delivered: false, method };
    }
  } catch {
    method = "process";
    if (!signalTarget(pid, "SIGTERM", method, killImpl)) {
      return { attempted: true, delivered: false, method };
    }
  }

  const waitOptions = {
    gracePeriodMs: options.gracePeriodMs ?? 5_000,
    pollIntervalMs: options.pollIntervalMs ?? 100,
    delayImpl: options.delayImpl ?? delay,
    killImpl,
  };
  if (await waitUntilGone(pid, method, waitOptions)) {
    return { attempted: true, delivered: true, method, escalated: false };
  }
  const escalated = signalTarget(pid, "SIGKILL", method, killImpl);
  return { attempted: true, delivered: true, method, escalated };
}
