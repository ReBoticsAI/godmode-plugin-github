import type { GodModePluginRegister } from "@godmode/plugin-api";
import { resolveWorkingRoot, runGh } from "./gh-util.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const register: GodModePluginRegister = (api) => {
  api.tools.register([
    {
      name: "gh_pr_list",
      description: "List pull requests for the repo at the coding root.",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          state: {
            type: "string",
            enum: ["open", "closed", "merged", "all"],
            description: "Default open",
          },
          limit: { type: "number" },
        },
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const state = str(args.state) || "open";
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
        const r = await runGh(cwd, [
          "pr",
          "list",
          "--state",
          state,
          "--limit",
          String(limit),
          "--json",
          "number,title,url,headRefName,isDraft,mergeable,state",
        ]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh pr list failed");
        let items: unknown = r.stdout;
        try {
          items = JSON.parse(r.stdout);
        } catch {
          /* keep raw */
        }
        return { cwd, pullRequests: items };
      },
    },
    {
      name: "gh_pr_view",
      description: "View a pull request by number (JSON).",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          number: { type: "number", description: "PR number" },
        },
        required: ["number"],
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const num = Number(args.number);
        if (!Number.isFinite(num)) throw new Error("number required");
        const r = await runGh(cwd, [
          "pr",
          "view",
          String(num),
          "--json",
          "number,title,body,url,state,mergeable,statusCheckRollup,headRefName,baseRefName,isDraft",
        ]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh pr view failed");
        return { cwd, pr: JSON.parse(r.stdout) };
      },
    },
    {
      name: "gh_pr_checks",
      description: "Show CI checks for a pull request.",
      mode: "auto",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          number: { type: "number", description: "PR number (optional = current branch PR)" },
        },
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const ghArgs = ["pr", "checks"];
        if (Number.isFinite(Number(args.number))) ghArgs.push(String(Number(args.number)));
        const r = await runGh(cwd, ghArgs);
        return {
          cwd,
          code: r.code,
          checks: r.stdout,
          stderr: r.stderr || undefined,
          ok: r.code === 0,
        };
      },
    },
    {
      name: "gh_pr_create",
      description:
        "Create a pull request for the current branch. Provide title and body (Summary + Test plan).",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          base: { type: "string", description: "Base branch (default repo default)" },
          draft: { type: "boolean" },
        },
        required: ["title", "body"],
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const title = str(args.title).trim();
        const body = str(args.body).trim();
        if (!title || !body) throw new Error("title and body required");
        const ghArgs = ["pr", "create", "--title", title, "--body", body];
        if (str(args.base)) ghArgs.push("--base", str(args.base));
        if (args.draft === true) ghArgs.push("--draft");
        const r = await runGh(cwd, ghArgs, { timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh pr create failed");
        return { cwd, ok: true, url: r.stdout.trim(), stdout: r.stdout };
      },
    },
    {
      name: "gh_pr_comment",
      description: "Add a comment on a pull request.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          number: { type: "number" },
          body: { type: "string" },
        },
        required: ["number", "body"],
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const num = Number(args.number);
        const body = str(args.body).trim();
        if (!Number.isFinite(num) || !body) throw new Error("number and body required");
        const r = await runGh(cwd, ["pr", "comment", String(num), "--body", body]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh pr comment failed");
        return { cwd, ok: true, stdout: r.stdout };
      },
    },
    {
      name: "gh_pr_merge",
      description:
        "Merge a pull request. Prefer only after gh_pr_checks are green. Default merge method: squash.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          number: { type: "number" },
          method: {
            type: "string",
            enum: ["squash", "merge", "rebase"],
            description: "Default squash",
          },
          deleteBranch: { type: "boolean", description: "Default true" },
        },
        required: ["number"],
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const num = Number(args.number);
        if (!Number.isFinite(num)) throw new Error("number required");
        const method = str(args.method) || "squash";
        const ghArgs = ["pr", "merge", String(num), `--${method}`];
        if (args.deleteBranch !== false) ghArgs.push("--delete-branch");
        const r = await runGh(cwd, ghArgs, { timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh pr merge failed");
        return { cwd, ok: true, stdout: r.stdout };
      },
    },
    {
      name: "gh_issue_create",
      description: "Create a GitHub issue in the current repository.",
      mode: "confirm",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          labels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title"],
      },
      handler: async (args, ctx) => {
        const cwd = resolveWorkingRoot(ctx, args.cwd);
        const title = str(args.title).trim();
        if (!title) throw new Error("title required");
        const ghArgs = ["issue", "create", "--title", title];
        if (str(args.body)) ghArgs.push("--body", str(args.body));
        if (Array.isArray(args.labels)) {
          for (const lab of args.labels) {
            if (typeof lab === "string" && lab.trim()) ghArgs.push("--label", lab.trim());
          }
        }
        const r = await runGh(cwd, ghArgs);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "gh issue create failed");
        return { cwd, ok: true, url: r.stdout.trim() };
      },
    },
  ]);
};
