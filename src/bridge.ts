import { randomUUID } from "node:crypto";
import {
  KERNEL_CLIENT_API_VERSION,
  type GodModePluginApi,
  type GodModePluginRegister,
  type PluginBootContext,
  type PluginKernelClient,
  type PluginRecordContext,
  type PluginTenantContext,
  type PluginToolDef,
} from "@godmode/plugin-api";
import {
  createGithubAdapters,
  githubRepositoryObjectType,
  pullRequestId,
  pullRequestObjectType,
} from "./adapters.js";
import {
  requireGhSuccess,
  resolveWorkingRoot,
  runGh,
} from "./gh-util.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function requireVersionedKernelClient(
  kernel: PluginKernelClient
): PluginKernelClient {
  const provided = (kernel as { apiVersion?: unknown } | undefined)?.apiVersion;
  if (provided !== KERNEL_CLIENT_API_VERSION) {
    throw new Error(
      `GitHub plugin requires kernel client API version ${KERNEL_CLIENT_API_VERSION}; host provided ${String(
        provided ?? "no version"
      )}`
    );
  }
  return kernel;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function actionContext(
  args: Record<string, unknown>,
  ctx: PluginBootContext &
    PluginTenantContext & {
      requestId?: string;
      confirmationId?: string;
      signal?: AbortSignal;
    }
): PluginRecordContext {
  const activeAgentId =
    typeof ctx.activeAgentId === "string" && ctx.activeAgentId
      ? ctx.activeAgentId
      : "intelligence";
  return {
    tenantId: String(ctx.tenantId ?? ""),
    userId: typeof ctx.userId === "string" ? ctx.userId : undefined,
    activeAgentId,
    activeSubtaskCardId:
      typeof ctx.activeSubtaskCardId === "string"
        ? ctx.activeSubtaskCardId
        : undefined,
    activeTaskCardId:
      typeof ctx.activeTaskCardId === "string"
        ? ctx.activeTaskCardId
        : undefined,
    role: activeAgentId === "intelligence" ? "intelligence" : "editor",
    source: "agent",
    requestId:
      typeof ctx.requestId === "string" ? ctx.requestId : randomUUID(),
    idempotencyKey:
      str(args.idempotencyKey).trim() ||
      (typeof ctx.requestId === "string" ? ctx.requestId : randomUUID()),
    confirmationId:
      typeof ctx.confirmationId === "string" ? ctx.confirmationId : undefined,
    signal: ctx.signal instanceof AbortSignal ? ctx.signal : undefined,
  };
}

function kernelConfirmationId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    details?: { confirmationId?: unknown };
  };
  if (
    candidate.status !== 428 &&
    candidate.code !== "KERNEL_CONFIRMATION_REQUIRED"
  ) {
    return undefined;
  }
  return typeof candidate.details?.confirmationId === "string"
    ? candidate.details.confirmationId
    : undefined;
}

async function runConfirmedAction(
  kernel: PluginKernelClient,
  objectType: string,
  action: string,
  input: Record<string, unknown>,
  context: PluginRecordContext,
  id: string
): Promise<unknown> {
  try {
    return await kernel.runAction(
      objectType,
      action,
      input,
      context,
      id
    );
  } catch (error) {
    const confirmationId = kernelConfirmationId(error);
    if (!confirmationId) throw error;
    return kernel.runAction(
      objectType,
      action,
      input,
      { ...context, confirmationId },
      id
    );
  }
}

const cwdProperty = {
  cwd: {
    type: "string",
    description:
      "Repository directory relative to the active coding root (default: coding root).",
  },
};

const idempotencyProperty = {
  idempotencyKey: {
    type: "string",
    description:
      "Stable retry key. Defaults to the active tool request identifier.",
  },
};

export function createSemanticTools(api: GodModePluginApi): PluginToolDef[] {
  const kernel = requireVersionedKernelClient(api.kernel);
  return [
    {
      name: "gh_pr_create",
      description:
        "Create a pull request through the GitHubRepository kernel action.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          title: { type: "string" },
          body: { type: "string" },
          base: { type: "string" },
          draft: { type: "boolean" },
          ...idempotencyProperty,
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        return runConfirmedAction(
          kernel,
          "GitHubRepository",
          "create_pull_request",
          {
            title: str(args.title).trim(),
            body: str(args.body).trim(),
            ...(str(args.base).trim() ? { base: str(args.base).trim() } : {}),
            ...(args.draft === true ? { draft: true } : {}),
          },
          actionContext(args, ctx),
          cwd
        );
      },
    },
    {
      name: "gh_pr_comment",
      description: "Comment through the PullRequest kernel action.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          number: { type: "integer", minimum: 1 },
          body: { type: "string" },
          ...idempotencyProperty,
        },
        required: ["number", "body"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        return runConfirmedAction(
          kernel,
          "PullRequest",
          "comment",
          { body: str(args.body).trim() },
          actionContext(args, ctx),
          pullRequestId(cwd, integer(args.number, "number"))
        );
      },
    },
    {
      name: "gh_pr_merge",
      description:
        "Merge through the PullRequest kernel action after merge-readiness checks.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          number: { type: "integer", minimum: 1 },
          method: { type: "string", enum: ["squash", "merge", "rebase"] },
          deleteBranch: { type: "boolean" },
          ...idempotencyProperty,
        },
        required: ["number"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        return runConfirmedAction(
          kernel,
          "PullRequest",
          "merge",
          {
            ...(str(args.method) ? { method: str(args.method) } : {}),
            ...(typeof args.deleteBranch === "boolean"
              ? { deleteBranch: args.deleteBranch }
              : {}),
          },
          actionContext(args, ctx),
          pullRequestId(cwd, integer(args.number, "number"))
        );
      },
    },
    {
      name: "gh_issue_create",
      description: "Create an issue through the GitHubRepository kernel action.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          title: { type: "string" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          ...idempotencyProperty,
        },
        required: ["title"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        return runConfirmedAction(
          kernel,
          "GitHubRepository",
          "create_issue",
          {
            title: str(args.title).trim(),
            ...(typeof args.body === "string" ? { body: args.body } : {}),
            ...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
          },
          actionContext(args, ctx),
          cwd
        );
      },
    },
  ];
}

function createReadTools(): PluginToolDef[] {
  return [
    {
      name: "gh_pr_list",
      description: "List pull requests for the repo at the coding root.",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          state: {
            type: "string",
            enum: ["open", "closed", "merged", "all"],
          },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const state = str(args.state) || "open";
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
        const result = requireGhSuccess(
          await runGh(cwd, [
            "pr",
            "list",
            "--state",
            state,
            "--limit",
            String(limit),
            "--json",
            "number,title,url,headRefName,isDraft,mergeable,state",
          ]),
          "gh pr list failed"
        );
        return { cwd, pullRequests: JSON.parse(result.stdout) };
      },
    },
    {
      name: "gh_pr_view",
      description: "View a pull request by number.",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          number: { type: "integer", minimum: 1 },
        },
        required: ["number"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const number = integer(args.number, "number");
        const result = requireGhSuccess(
          await runGh(cwd, [
            "pr",
            "view",
            String(number),
            "--json",
            "number,title,body,url,state,mergeable,statusCheckRollup,headRefName,baseRefName,isDraft",
          ]),
          "gh pr view failed"
        );
        return { cwd, pr: JSON.parse(result.stdout) };
      },
    },
    {
      name: "gh_pr_checks",
      description: "Show CI checks for a pull request.",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          ...cwdProperty,
          number: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const ghArgs = ["pr", "checks"];
        if (args.number != null) {
          ghArgs.push(String(integer(args.number, "number")));
        }
        const result = await runGh(cwd, ghArgs);
        return {
          cwd,
          code: result.code,
          checks: result.stdout,
          stderr: result.stderr || undefined,
          ok: result.code === 0,
        };
      },
    },
  ];
}

export const register: GodModePluginRegister = (api) => {
  requireVersionedKernelClient(api.kernel);
  const adapters = createGithubAdapters();
  api.objectTypes.register(githubRepositoryObjectType, adapters.repository);
  api.objectTypes.register(pullRequestObjectType, adapters.pullRequest);
  api.tools.register([...createReadTools(), ...createSemanticTools(api)]);
};
