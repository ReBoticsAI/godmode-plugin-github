---
name: github-pr-workflow
description: Open and land GitHub PRs with kernel-backed mutations and gh read tools
tools: ["gh_pr_list", "gh_pr_view", "gh_pr_checks", "gh_pr_create", "gh_pr_comment", "gh_pr_merge", "gh_issue_create", "git_status", "git_push"]
---

1. Ensure the branch is pushed (`git_push` from godmode-plugin-git).
2. Call `gh_pr_create` with:
   - Title: concise why
   - Body:
     ```
     ## Summary
     - …

     ## Test plan
     - [ ] …
     ```
   - Optional `base`, `draft`, and stable `idempotencyKey`
   - Optional `cwd` relative to the active coding root
3. Share the returned PR URL with the user. `gh_pr_create` delegates to the `GitHubRepository.create_pull_request` kernel action.
4. Use `gh_pr_checks` for a CI snapshot. It returns `ok`, exit `code`, text `checks`, and optional `stderr`; rerun only after waiting when checks are pending.
5. Only when the user asks to land it, call `gh_pr_merge`. It delegates to `PullRequest.merge`, which independently requires an open, non-draft, mergeable PR whose checks are `SUCCESS`, `NEUTRAL`, or `SKIPPED`.
   - Merge defaults: squash and delete the branch
   - Override with `method: "merge" | "rebase"` or `deleteBranch: false`
6. Treat `gh_pr_create`, `gh_pr_comment`, `gh_pr_merge`, and `gh_issue_create` as confirmed kernel mutations. Their wrappers preserve the idempotency key and replay once when the kernel supplies a confirmation grant.
7. `gh_pr_list`, `gh_pr_view`, and `gh_pr_checks` are read-only direct `gh` calls; they do not run ObjectType actions.
8. Keep secrets and private ops out of PRs, comments, and issues.
