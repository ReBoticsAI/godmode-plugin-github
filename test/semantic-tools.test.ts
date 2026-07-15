import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KERNEL_CLIENT_API_VERSION,
  type GodModePluginApi,
  type PluginRecordContext,
} from "@godmode/plugin-api";
import {
  createSemanticTools,
  register,
  requireVersionedKernelClient,
} from "../src/bridge.js";

test("mutation tools delegate exclusively to kernel actions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-semantic-"));
  const oldMode = process.env.DEPLOYMENT_MODE;
  const oldRoot = process.env.PLATFORM_REPO_ROOT;
  process.env.DEPLOYMENT_MODE = "local";
  process.env.PLATFORM_REPO_ROOT = root;
  const calls: Array<{
    objectType: string;
    action: string;
    input: Record<string, unknown>;
    ctx: PluginRecordContext;
    id?: string;
  }> = [];
  const api = {
    kernel: {
      apiVersion: KERNEL_CLIENT_API_VERSION,
      async runAction(
        objectType: string,
        action: string,
        input: Record<string, unknown>,
        ctx: PluginRecordContext,
        id?: string
      ) {
        calls.push({ objectType, action, input, ctx, id });
        return { ok: true };
      },
    },
  } as unknown as GodModePluginApi;
  const tools = createSemanticTools(api);
  const executionContext = {
    tenantId: "tenant-a",
    activeAgentId: "intelligence",
    requestId: "tool-call-1",
  };

  await tools.find((tool) => tool.name === "gh_pr_create")!.handler!(
    { title: "Title", body: "Body" },
    executionContext as never
  );
  await tools.find((tool) => tool.name === "gh_pr_comment")!.handler!(
    { number: 7, body: "Comment" },
    executionContext as never
  );
  await tools.find((tool) => tool.name === "gh_pr_merge")!.handler!(
    { number: 7 },
    executionContext as never
  );
  await tools.find((tool) => tool.name === "gh_issue_create")!.handler!(
    { title: "Issue" },
    executionContext as never
  );

  assert.deepEqual(
    calls.map(({ objectType, action }) => [objectType, action]),
    [
      ["GitHubRepository", "create_pull_request"],
      ["PullRequest", "comment"],
      ["PullRequest", "merge"],
      ["GitHubRepository", "create_issue"],
    ]
  );
  assert.ok(calls.every((call) => call.ctx.idempotencyKey === "tool-call-1"));
  assert.ok(calls.every((call) => call.id));

  process.env.DEPLOYMENT_MODE = oldMode;
  process.env.PLATFORM_REPO_ROOT = oldRoot;
});

test("confirmed wrappers consume and replay kernel confirmation grants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-confirm-"));
  process.env.DEPLOYMENT_MODE = "local";
  process.env.PLATFORM_REPO_ROOT = root;
  const contexts: PluginRecordContext[] = [];
  const api = {
    kernel: {
      apiVersion: KERNEL_CLIENT_API_VERSION,
      async runAction(
        _objectType: string,
        _action: string,
        _input: Record<string, unknown>,
        ctx: PluginRecordContext
      ) {
        contexts.push(ctx);
        if (contexts.length === 1) {
          throw Object.assign(new Error("confirmation required"), {
            status: 428,
            code: "KERNEL_CONFIRMATION_REQUIRED",
            details: { confirmationId: "grant-123" },
          });
        }
        return { ok: true };
      },
    },
  } as unknown as GodModePluginApi;
  const tool = createSemanticTools(api).find(
    (candidate) => candidate.name === "gh_issue_create"
  )!;

  const result = await tool.handler!(
    { title: "Confirmed", idempotencyKey: "same-operation" },
    {
      tenantId: "tenant-a",
      activeAgentId: "intelligence",
    } as never
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]!.idempotencyKey, "same-operation");
  assert.equal(contexts[1]!.idempotencyKey, "same-operation");
  assert.equal(contexts[1]!.confirmationId, "grant-123");
});

test("versioned client contract rejects missing and mismatched hosts clearly", () => {
  assert.throws(
    () =>
      requireVersionedKernelClient({
        apiVersion: 2,
      } as never),
    /requires kernel client API version 1; host provided 2/
  );
  assert.throws(
    () =>
      register({
        kernel: {},
      } as unknown as GodModePluginApi),
    /requires kernel client API version 1; host provided no version/
  );
});
