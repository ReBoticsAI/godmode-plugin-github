# GodMode GitHub plugin

Official marketplace plugin: **GitHub** pull request and CI tools for Intelligence via the [`gh`](https://cli.github.com/) CLI.

## Requirements

- `gh` on the host PATH
- Auth: `gh auth login` **or** `GITHUB_TOKEN` / `GH_TOKEN` in the environment (do not commit tokens)
- Usually used with **godmode-plugin-git** for local commit/push

## Tools

| Tool | Mode | Purpose |
|------|------|---------|
| `gh_pr_list` | auto | List PRs for the current repo |
| `gh_pr_view` | auto | View one PR (JSON) |
| `gh_pr_checks` | auto | CI check rollup for a PR |
| `gh_pr_create` | confirm | Create a PR (title + body) |
| `gh_pr_comment` | confirm | Comment on a PR |
| `gh_pr_merge` | confirm | Merge when appropriate (default squash) |
| `gh_issue_create` | confirm | Open a GitHub issue |

## Safety

- Does not store PATs in the plugin.
- Prefer waiting for green `gh_pr_checks` before `gh_pr_merge`.
- Never put secrets, ops passwords, or private family content in PR bodies.

## Install

Marketplace → Official → **GitHub**, or Unofficial with this repo URL.
