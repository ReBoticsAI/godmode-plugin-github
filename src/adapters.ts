import path from "node:path";
import type {
  PluginRecordAdapter,
  PluginRecordContext,
} from "@godmode/plugin-api";
import type { ActionDef, ObjectTypeDef, RecordData } from "@godmode/kernel";
import {
  GitHubActionError,
  requireGhSuccess,
  resolveWorkingRoot,
  runGh,
  type CommandRunner,
} from "./gh-util.js";

const PLUGIN_ID = "godmode-plugin-github";
const REPOSITORY_ADAPTER_ID = `${PLUGIN_ID}.repository`;
const PULL_REQUEST_ADAPTER_ID = `${PLUGIN_ID}.pull-request`;

const errorSchema = {
  type: "object",
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    details: {},
  },
  additionalProperties: false,
};

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: required.length ? required : undefined,
    additionalProperties: false,
  };
}

function event(type: string) {
  return [
    {
      type,
      schema: {
        type: "object",
        required: ["objectType", "recordId", "action", "result"],
        additionalProperties: true,
      },
    },
  ];
}

const repositoryOutput = objectSchema(
  {
    cwd: { type: "string" },
    ok: { type: "boolean", const: true },
    url: { type: "string" },
    stdout: { type: "string" },
  },
  ["cwd", "ok", "url", "stdout"]
);

const mutationContract = {
  execution: "sync" as const,
  contractVersion: 1,
  confirmation: { required: true, ttlSeconds: 300 },
  idempotency: { required: true, ttlSeconds: 86_400 },
  retry: {
    maxAttempts: 1,
    retryableErrorCodes: [
      "GITHUB_CLI_FAILED",
      "GITHUB_CLI_UNAVAILABLE",
      "GITHUB_ACTION_TIMEOUT",
    ],
  },
  errorSchema,
};

const repositoryActions: ActionDef[] = [
  {
    name: "create_pull_request",
    label: "Create pull request",
    description: "Create a pull request from the repository's current branch.",
    target: "record",
    effect: "external",
    roles: ["editor", "owner", "intelligence"],
    ...mutationContract,
    timeoutMs: 300_000,
    inputSchema: objectSchema(
      {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", minLength: 1, maxLength: 100_000 },
        base: { type: "string", minLength: 1, maxLength: 255 },
        draft: { type: "boolean" },
      },
      ["title", "body"]
    ),
    outputSchema: repositoryOutput,
    events: event("github.pull_request.created"),
  },
  {
    name: "create_issue",
    label: "Create issue",
    description: "Create an issue in the repository.",
    target: "record",
    effect: "external",
    roles: ["editor", "owner", "intelligence"],
    ...mutationContract,
    timeoutMs: 180_000,
    inputSchema: objectSchema(
      {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", maxLength: 100_000 },
        labels: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      ["title"]
    ),
    outputSchema: repositoryOutput,
    events: event("github.issue.created"),
  },
];

const pullRequestActions: ActionDef[] = [
  {
    name: "comment",
    label: "Comment on pull request",
    description: "Add a comment to a pull request.",
    target: "record",
    effect: "external",
    roles: ["editor", "owner", "intelligence"],
    ...mutationContract,
    timeoutMs: 180_000,
    inputSchema: objectSchema(
      { body: { type: "string", minLength: 1, maxLength: 100_000 } },
      ["body"]
    ),
    outputSchema: objectSchema(
      {
        cwd: { type: "string" },
        ok: { type: "boolean", const: true },
        stdout: { type: "string" },
      },
      ["cwd", "ok", "stdout"]
    ),
    events: event("github.pull_request.commented"),
  },
  {
    name: "merge",
    label: "Merge pull request",
    description:
      "Merge a non-draft pull request only when GitHub reports it mergeable and all checks are successful.",
    target: "record",
    effect: "destructive",
    roles: ["owner", "intelligence"],
    ...mutationContract,
    timeoutMs: 300_000,
    inputSchema: objectSchema({
      method: { type: "string", enum: ["squash", "merge", "rebase"] },
      deleteBranch: { type: "boolean" },
    }),
    outputSchema: objectSchema(
      {
        cwd: { type: "string" },
        ok: { type: "boolean", const: true },
        stdout: { type: "string" },
        readiness: {
          type: "object",
          required: ["ready", "checks"],
          properties: {
            ready: { type: "boolean", const: true },
            checks: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      ["cwd", "ok", "stdout", "readiness"]
    ),
    events: event("github.pull_request.merged"),
  },
];

export const githubRepositoryObjectType: ObjectTypeDef = {
  name: "GitHubRepository",
  label: "GitHub Repository",
  labelPlural: "GitHub Repositories",
  description: "A GitHub repository rooted within the active coding root.",
  pluginId: PLUGIN_ID,
  module: "engineering",
  accessPolicy: "tenant-member",
  contractVersion: 1,
  database: "tenant",
  storage: { kind: "adapter", adapterId: REPOSITORY_ADAPTER_ID },
  fields: [
    { name: "id", label: "ID", fieldType: "Data", inForm: false },
    { name: "path", label: "Path", fieldType: "Data", inForm: false },
    { name: "name", label: "Name", fieldType: "ReadOnly", inForm: false },
  ],
  permissions: [
    { role: "viewer", read: true },
    { role: "editor", read: true },
    { role: "owner", read: true },
    { role: "intelligence", read: true },
  ],
  actions: repositoryActions,
};

export const pullRequestObjectType: ObjectTypeDef = {
  name: "PullRequest",
  label: "Pull Request",
  labelPlural: "Pull Requests",
  description: "A GitHub pull request scoped to a repository coding root.",
  pluginId: PLUGIN_ID,
  module: "engineering",
  accessPolicy: "tenant-member",
  contractVersion: 1,
  database: "tenant",
  storage: { kind: "adapter", adapterId: PULL_REQUEST_ADAPTER_ID },
  fields: [
    { name: "id", label: "ID", fieldType: "Data", inForm: false },
    {
      name: "repository_path",
      label: "Repository path",
      fieldType: "Data",
      inForm: false,
    },
    { name: "number", label: "Number", fieldType: "Int", inForm: false },
  ],
  permissions: [
    { role: "viewer", read: true },
    { role: "editor", read: true },
    { role: "owner", read: true },
    { role: "intelligence", read: true },
  ],
  actions: pullRequestActions,
};

function requiredString(input: RecordData, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubActionError(
      400,
      "GITHUB_INVALID_INPUT",
      `${key} is required`
    );
  }
  return value.trim();
}

export function pullRequestId(cwd: string, number: number): string {
  return Buffer.from(JSON.stringify([cwd, number]), "utf8").toString("base64url");
}

export function parsePullRequestId(id: string): {
  cwd: string;
  number: number;
} {
  try {
    const value = JSON.parse(
      Buffer.from(id, "base64url").toString("utf8")
    ) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      !Number.isSafeInteger(value[1]) ||
      Number(value[1]) <= 0
    ) {
      throw new Error("invalid");
    }
    return { cwd: value[0], number: Number(value[1]) };
  } catch {
    throw new GitHubActionError(
      400,
      "GITHUB_INVALID_PULL_REQUEST_ID",
      "Invalid pull request identifier"
    );
  }
}

type PullRequestView = {
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  statusCheckRollup?: Array<Record<string, unknown>> | null;
};

export function assertMergeReady(view: PullRequestView): {
  ready: true;
  checks: number;
} {
  if (view.state !== "OPEN") {
    throw new GitHubActionError(
      409,
      "GITHUB_PULL_REQUEST_NOT_OPEN",
      "Pull request is not open"
    );
  }
  if (view.isDraft) {
    throw new GitHubActionError(
      409,
      "GITHUB_PULL_REQUEST_DRAFT",
      "Draft pull requests cannot be merged"
    );
  }
  if (view.mergeable !== "MERGEABLE") {
    throw new GitHubActionError(
      409,
      "GITHUB_PULL_REQUEST_NOT_MERGEABLE",
      `Pull request is not mergeable (${view.mergeable ?? "UNKNOWN"})`,
      { retryable: view.mergeable === "UNKNOWN" }
    );
  }
  const checks = view.statusCheckRollup ?? [];
  const failing = checks.filter((check) => {
    const value = String(
      check.conclusion ?? check.state ?? check.status ?? ""
    ).toUpperCase();
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value);
  });
  if (failing.length) {
    throw new GitHubActionError(
      409,
      "GITHUB_CHECKS_NOT_READY",
      `${failing.length} required check(s) are not successful`,
      { retryable: true }
    );
  }
  return { ready: true, checks: checks.length };
}

function repositoryPath(id: string, ctx: PluginRecordContext): string {
  return resolveWorkingRoot(ctx, id);
}

export function createGithubAdapters(
  runner: CommandRunner = runGh
): {
  repository: PluginRecordAdapter;
  pullRequest: PluginRecordAdapter;
} {
  const repository: PluginRecordAdapter = {
    get(id, ctx) {
      const cwd = repositoryPath(id, ctx);
      return {
        id: cwd,
        objectType: "GitHubRepository",
        data: { id: cwd, path: cwd, name: path.basename(cwd) },
      };
    },
    actions: {
      async create_pull_request(id, input, ctx) {
        const cwd = repositoryPath(id, ctx);
        const args = [
          "pr",
          "create",
          "--title",
          requiredString(input, "title"),
          "--body",
          requiredString(input, "body"),
        ];
        if (typeof input.base === "string" && input.base.trim()) {
          args.push("--base", input.base.trim());
        }
        if (input.draft === true) args.push("--draft");
        const result = requireGhSuccess(
          await runner(cwd, args, {
            timeoutMs: 300_000,
            signal: ctx.signal,
          }),
          "gh pr create failed"
        );
        return {
          cwd,
          ok: true,
          url: result.stdout.trim(),
          stdout: result.stdout,
        };
      },
      async create_issue(id, input, ctx) {
        const cwd = repositoryPath(id, ctx);
        const args = ["issue", "create", "--title", requiredString(input, "title")];
        if (typeof input.body === "string" && input.body) {
          args.push("--body", input.body);
        }
        if (Array.isArray(input.labels)) {
          for (const label of input.labels) {
            if (typeof label === "string" && label.trim()) {
              args.push("--label", label.trim());
            }
          }
        }
        const result = requireGhSuccess(
          await runner(cwd, args, {
            timeoutMs: 180_000,
            signal: ctx.signal,
          }),
          "gh issue create failed"
        );
        return {
          cwd,
          ok: true,
          url: result.stdout.trim(),
          stdout: result.stdout,
        };
      },
    },
  };

  const pullRequest: PluginRecordAdapter = {
    get(id, ctx) {
      const parsed = parsePullRequestId(id);
      const cwd = resolveWorkingRoot(ctx, parsed.cwd);
      return {
        id: pullRequestId(cwd, parsed.number),
        objectType: "PullRequest",
        data: {
          id: pullRequestId(cwd, parsed.number),
          repository_path: cwd,
          number: parsed.number,
        },
      };
    },
    actions: {
      async comment(id, input, ctx) {
        const parsed = parsePullRequestId(id);
        const cwd = resolveWorkingRoot(ctx, parsed.cwd);
        const result = requireGhSuccess(
          await runner(
            cwd,
            [
              "pr",
              "comment",
              String(parsed.number),
              "--body",
              requiredString(input, "body"),
            ],
            { timeoutMs: 180_000, signal: ctx.signal }
          ),
          "gh pr comment failed"
        );
        return { cwd, ok: true, stdout: result.stdout };
      },
      async merge(id, input, ctx) {
        const parsed = parsePullRequestId(id);
        const cwd = resolveWorkingRoot(ctx, parsed.cwd);
        const viewResult = requireGhSuccess(
          await runner(
            cwd,
            [
              "pr",
              "view",
              String(parsed.number),
              "--json",
              "state,isDraft,mergeable,statusCheckRollup",
            ],
            { timeoutMs: 180_000, signal: ctx.signal }
          ),
          "gh pr view failed"
        );
        let view: PullRequestView;
        try {
          view = JSON.parse(viewResult.stdout) as PullRequestView;
        } catch {
          throw new GitHubActionError(
            502,
            "GITHUB_INVALID_RESPONSE",
            "gh pr view returned invalid JSON",
            { retryable: true }
          );
        }
        const readiness = assertMergeReady(view);
        const method =
          input.method === "merge" || input.method === "rebase"
            ? input.method
            : "squash";
        const args = ["pr", "merge", String(parsed.number), `--${method}`];
        if (input.deleteBranch !== false) args.push("--delete-branch");
        const result = requireGhSuccess(
          await runner(cwd, args, {
            timeoutMs: 300_000,
            signal: ctx.signal,
          }),
          "gh pr merge failed"
        );
        return { cwd, ok: true, stdout: result.stdout, readiness };
      },
    },
  };

  return { repository, pullRequest };
}
