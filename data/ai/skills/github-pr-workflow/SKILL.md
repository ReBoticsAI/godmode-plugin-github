---
name: github-pr-workflow
description: Open and land GitHub PRs with gh plugin tools (create, checks, merge)
tools: ["gh_pr_list", "gh_pr_view", "gh_pr_checks", "gh_pr_create", "gh_pr_comment", "gh_pr_merge", "gh_issue_create", "git_status", "git_push"]
---

1. Ensure the branch is pushed (`git_push` from godmode-plugin-git).
2. `gh_pr_create` with:
   - Title: concise why
   - Body:
     ```
     ## Summary
     - …

     ## Test plan
     - [ ] …
     ```
3. Share the returned PR URL with the user.
4. Poll `gh_pr_checks` until green (or report failures). Avoid tight busy-loops — wait between checks.
5. Only when the user asks to land it: `gh_pr_merge` (squash by default).
6. Keep secrets and private ops out of the PR.
