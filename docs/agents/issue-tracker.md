# Issue tracker: GitHub

Issues and specs live in GitHub Issues for
`BuddyLabsCo/issue-runner-agent-codex`. Use the `gh` CLI.

## Conventions

Run commands inside this repository. Before creating the first issue
in a session, verify the target with `gh repo view --json nameWithOwner`.
The expected repository is `BuddyLabsCo/issue-runner-agent-codex`.

- Create: `gh issue create --title "..." --body-file <file>`.
  Use a UTF-8 file for multiline bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
  Add label filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."`
  or `gh issue edit <number> --remove-label "..."`.
- Close: post the explanation as a comment, then run
  `gh issue close <number>`.

Use native GitHub sub-issues for parent-child relationships and native
issue dependencies for blockers when available. Otherwise, put
`Part of #<parent>` and `Blocked by: #<number>` at the top of the child
issue body. An issue is unblocked when every blocker is closed.

Use `docs/agents/triage-labels.md` for the triage label vocabulary.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Pull requests

- **Title** — follows the Conventional Commits spec in the form
  `<type>: [issue-<issue-number>] <subject>`, for example `fix: [issue-42] correct retry backoff`.
- **Description** — must end with `Closes #<issue-number>`

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the GitHub issue, including its labels and comments.
