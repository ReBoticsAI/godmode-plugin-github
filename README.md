# GodMode GitHub plugin

Official marketplace plugin: **GitHub** pull request and CI tools for Intelligence. Read tools call the [`gh`](https://cli.github.com/) CLI directly; mutations execute through versioned ObjectType kernel actions backed by `gh` adapters.

## Requirements

- `gh` on the host PATH
- Auth: `gh auth login` **or** `GITHUB_TOKEN` / `GH_TOKEN` in the environment (do not commit tokens)
- Usually used with **godmode-plugin-git** for local commit/push

## Architecture

The manifest negotiates kernel client API version 1. At registration, the plugin installs two adapter-backed ObjectTypes:

- `GitHubRepository`: `create_pull_request` and `create_issue`
- `PullRequest`: `comment` and `merge`

The four mutation tools call `api.kernel.runAction(...)`; they do not invoke `gh` directly. Their action contracts require confirmation and idempotency, declare timeouts and structured errors, and emit kernel events. If the kernel returns a confirmation grant, the tool wrapper replays the same action once with that grant and the same idempotency key.

Repository paths are resolved inside the active coding root. In hub/client deployments, that root is tenant-scoped. Absolute or traversal escapes are rejected.

## Tools

| Tool | Mode | Execution and result |
|------|------|----------------------|
| `gh_pr_list` | auto | Direct read: lists PRs with `gh pr list`; defaults to open, limit 20 |
| `gh_pr_view` | auto | Direct read: returns PR JSON from `gh pr view` |
| `gh_pr_checks` | auto | Direct read: returns `ok`, exit `code`, text `checks`, and optional `stderr`; the PR number is optional |
| `gh_pr_create` | confirm | `GitHubRepository.create_pull_request`; requires title and body |
| `gh_pr_comment` | confirm | `PullRequest.comment`; requires PR number and body |
| `gh_pr_merge` | confirm | `PullRequest.merge`; verifies open/non-draft/mergeable status and successful checks before merging |
| `gh_issue_create` | confirm | `GitHubRepository.create_issue`; requires a title |

All tools accept an optional `cwd` relative to the coding root. Mutation tools also accept an optional stable `idempotencyKey`; otherwise the active tool request ID is used.

`gh_pr_merge` defaults to squash and branch deletion. Set `method` to `merge` or `rebase`, or set `deleteBranch: false`, to override those defaults.

## Safety

- Does not store PATs in the plugin.
- Use `gh_pr_checks` to inspect CI before requesting a merge. The merge action independently rejects closed or draft PRs, conflicts, unknown mergeability, and checks not reported as `SUCCESS`, `NEUTRAL`, or `SKIPPED`.
- Never put secrets, ops passwords, or private family content in PR bodies.

## Verification

Run `npm run validate` to type-check source and tests, execute the ObjectType/adapter/tool contract tests, and build the bridge. The suite verifies kernel API negotiation, strict action contracts, mutation delegation, confirmation replay, coding-root isolation, safe argv handling, and merge-readiness enforcement.

## Install

Marketplace → Official → **GitHub**, or Unofficial with this repo URL.
