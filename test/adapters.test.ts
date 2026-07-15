import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginRecordContext } from "@godmode/plugin-api";
import {
  assertMergeReady,
  createGithubAdapters,
  pullRequestId,
} from "../src/adapters.js";
import {
  GitHubActionError,
  resolveWorkingRoot,
  type CommandRunner,
} from "../src/gh-util.js";

const originalEnv = { ...process.env };

function context(tenantId = "tenant-a"): PluginRecordContext {
  return {
    tenantId,
    role: "intelligence",
    source: "plugin",
    activeAgentId: "agent-test",
  };
}

test.afterEach(() => {
  process.env = { ...originalEnv };
});

test("coding roots reject traversal and absolute escapes", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "github-root-"));
  const root = path.join(base, "root");
  const child = path.join(root, "child");
  const outside = path.join(base, "outside");
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(outside);
  process.env.DEPLOYMENT_MODE = "local";
  process.env.PLATFORM_REPO_ROOT = root;

  assert.equal(resolveWorkingRoot({}, "child"), fs.realpathSync.native(child));
  assert.throws(
    () => resolveWorkingRoot({}, outside),
    (error: unknown) =>
      error instanceof GitHubActionError &&
      error.code === "GITHUB_CODING_ROOT_ESCAPE"
  );
});

test("tenant coding roots cannot cross tenant boundaries", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "github-tenants-"));
  const tenantA = path.join(data, "tenant-workspaces", "tenant-a");
  const tenantB = path.join(data, "tenant-workspaces", "tenant-b");
  fs.mkdirSync(tenantA, { recursive: true });
  fs.mkdirSync(tenantB, { recursive: true });
  process.env.DEPLOYMENT_MODE = "hub";
  process.env.PLATFORM_DATA_DIR = data;

  assert.equal(resolveWorkingRoot(context("tenant-a")), fs.realpathSync.native(tenantA));
  assert.throws(
    () => resolveWorkingRoot(context("tenant-a"), tenantB),
    (error: unknown) =>
      error instanceof GitHubActionError &&
      error.code === "GITHUB_CODING_ROOT_ESCAPE"
  );
  assert.throws(
    () => resolveWorkingRoot(context("../tenant-b")),
    (error: unknown) =>
      error instanceof GitHubActionError &&
      error.code === "GITHUB_INVALID_TENANT"
  );
});

test("adapter passes hostile values as inert argv entries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-injection-"));
  process.env.DEPLOYMENT_MODE = "local";
  process.env.PLATFORM_REPO_ROOT = root;
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    return { code: 0, stdout: "https://example.test/pr/1\n", stderr: "" };
  };
  const { repository } = createGithubAdapters(runner);
  const hostile = `title"; rm -rf .; $(whoami)`;

  await repository.actions!.create_pull_request!(
    root,
    { title: hostile, body: "body && echo injected" },
    context()
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, [
    "pr",
    "create",
    "--title",
    hostile,
    "--body",
    "body && echo injected",
  ]);
});

test("merge checks readiness before spawning merge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-merge-"));
  process.env.DEPLOYMENT_MODE = "local";
  process.env.PLATFORM_REPO_ROOT = root;
  const calls: readonly string[][] = [];
  const runner: CommandRunner = async (_cwd, args) => {
    (calls as string[][]).push([...args]);
    if (args[1] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "merged\n", stderr: "" };
  };
  const { pullRequest } = createGithubAdapters(runner);

  const result = await pullRequest.actions!.merge!(
    pullRequestId(root, 42),
    { method: "rebase", deleteBranch: false },
    context()
  );

  assert.deepEqual(calls[1], ["pr", "merge", "42", "--rebase"]);
  assert.deepEqual(result, {
    cwd: fs.realpathSync.native(root),
    ok: true,
    stdout: "merged\n",
    readiness: { ready: true, checks: 1 },
  });
});

test("merge readiness rejects drafts, conflicts, and pending checks", () => {
  assert.throws(
    () =>
      assertMergeReady({
        state: "OPEN",
        isDraft: true,
        mergeable: "MERGEABLE",
      }),
    /Draft pull requests/
  );
  assert.throws(
    () =>
      assertMergeReady({
        state: "OPEN",
        isDraft: false,
        mergeable: "CONFLICTING",
      }),
    /not mergeable/
  );
  assert.throws(
    () =>
      assertMergeReady({
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        statusCheckRollup: [{ status: "IN_PROGRESS" }],
      }),
    /not successful/
  );
});
