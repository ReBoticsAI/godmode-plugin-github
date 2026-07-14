import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OUT = 200_000;

export function resolveWorkingRoot(
  ctx: { tenantId?: string },
  cwdArg?: unknown
): string {
  if (typeof cwdArg === "string" && cwdArg.trim()) {
    return path.resolve(cwdArg.trim());
  }
  const mode = (process.env.DEPLOYMENT_MODE ?? "local").toLowerCase();
  if ((mode === "hub" || mode === "client") && ctx.tenantId) {
    const data =
      process.env.PLATFORM_DATA_DIR?.trim() ||
      path.join(
        process.env.APPDATA || path.join(os.homedir(), ".local", "share"),
        "GodMode"
      );
    return path.join(data, "tenant-workspaces", ctx.tenantId);
  }
  return process.env.PLATFORM_REPO_ROOT?.trim() || process.cwd();
}

function truncate(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_OUT) return text;
  return `${buf.subarray(0, MAX_OUT).toString("utf8")}\n…[truncated]`;
}

export async function runGh(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!fs.existsSync(cwd)) {
    throw new Error(`Working directory not found: ${cwd}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      shell: process.platform === "win32",
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gh ${args[0]} timed out`));
    }, opts?.timeoutMs ?? 180_000);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${err instanceof Error ? err.message : String(err)} — is gh on PATH?`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
  });
}
