import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OUT = 200_000;

export interface GitHubContext {
  tenantId?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cwd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<CommandResult>;

export class GitHubActionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryable?: boolean; details?: unknown } = {}
  ) {
    super(message);
    this.name = "GitHubActionError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function dataDirectory(): string {
  return (
    process.env.PLATFORM_DATA_DIR?.trim() ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), ".local", "share"),
      "GodMode"
    )
  );
}

export function codingRoot(ctx: GitHubContext): string {
  const mode = (process.env.DEPLOYMENT_MODE ?? "local").toLowerCase();
  if (mode === "hub" || mode === "client") {
    if (!ctx.tenantId) {
      throw new GitHubActionError(
        403,
        "GITHUB_TENANT_REQUIRED",
        "Tenant context is required"
      );
    }
    if (
      !/^[A-Za-z0-9_-]+$/.test(ctx.tenantId) ||
      ctx.tenantId === "." ||
      ctx.tenantId === ".."
    ) {
      throw new GitHubActionError(
        400,
        "GITHUB_INVALID_TENANT",
        "Invalid tenant identifier"
      );
    }
    return path.resolve(dataDirectory(), "tenant-workspaces", ctx.tenantId);
  }
  return path.resolve(process.env.PLATFORM_REPO_ROOT?.trim() || process.cwd());
}

function canonicalExistingDirectory(value: string, label: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(path.resolve(value));
  } catch {
    throw new GitHubActionError(
      404,
      "GITHUB_WORKING_ROOT_NOT_FOUND",
      `${label} not found: ${value}`
    );
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new GitHubActionError(
      400,
      "GITHUB_WORKING_ROOT_INVALID",
      `${label} is not a directory: ${value}`
    );
  }
  return canonical;
}

export function resolveWorkingRoot(
  ctx: GitHubContext,
  cwdArg?: unknown
): string {
  const root = canonicalExistingDirectory(codingRoot(ctx), "Coding root");
  const requested =
    typeof cwdArg === "string" && cwdArg.trim()
      ? path.resolve(root, cwdArg.trim())
      : root;
  const candidate = canonicalExistingDirectory(requested, "Working directory");
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new GitHubActionError(
      403,
      "GITHUB_CODING_ROOT_ESCAPE",
      "Working directory must remain inside the coding root"
    );
  }
  return candidate;
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_OUT) return current;
  const remaining = MAX_OUT - Buffer.byteLength(current, "utf8");
  const addition = chunk.subarray(0, remaining).toString("utf8");
  return `${current}${addition}${
    chunk.byteLength > remaining ? "\n…[truncated]" : ""
  }`;
}

export async function runGh(
  cwd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => {
      child.kill();
      finishError(
        new GitHubActionError(
          499,
          "GITHUB_ACTION_CANCELLED",
          "GitHub action was cancelled"
        )
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      finishError(
        new GitHubActionError(
          504,
          "GITHUB_ACTION_TIMEOUT",
          `gh ${args[0] ?? "command"} timed out`,
          { retryable: true }
        )
      );
    }, opts?.timeoutMs ?? 180_000);
    timer.unref?.();
    if (opts?.signal?.aborted) {
      abort();
      return;
    }
    opts?.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (c: Buffer) => {
      stdout = appendBounded(stdout, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = appendBounded(stderr, c);
    });
    child.on("error", (err) => {
      finishError(
        new GitHubActionError(
          503,
          "GITHUB_CLI_UNAVAILABLE",
          `${err.message} — is gh on PATH?`,
          { retryable: true }
        )
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abort);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export function requireGhSuccess(
  result: CommandResult,
  fallback: string
): CommandResult {
  if (result.code !== 0) {
    throw new GitHubActionError(
      502,
      "GITHUB_CLI_FAILED",
      result.stderr.trim() || result.stdout.trim() || fallback,
      {
        retryable: true,
        details: { exitCode: result.code },
      }
    );
  }
  return result;
}
