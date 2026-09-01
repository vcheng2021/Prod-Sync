---
name: jira-update
description: Update a Jira ticket — transition status, add comments, and log work. Triggered when a ticket key is explicitly referenced in a task.
---

# Jira Update Skill

A skill for automatically updating Jira tickets when explicitly referenced in a task.

## Usage

```
/jira-update <ticket-key> [start|complete|comment] <message>
```

### Actions

- **`start`** — Transitions the ticket to `In Progress`, adds a comment noting work has begun.
- **`complete`** — Adds a final comment summarizing the completed work, logs work time, and transitions to `Done`.
- **`comment`** — Adds a comment to the ticket without changing status (default if no action specified).

## Examples

```
/jira-update VIC-1 start "adding health endpoint"
/jira-update VIC-1 complete "Added GET /api/health in server/src/routes/health.ts"
/jira-update VIC-1 comment "PR opened: https://github.com/.../pull/42"
```

## Behavior

### On `start`
1. Fetch the ticket's current status and available transitions via `mcp__atlassian__getTransitionsForJiraIssue`.
2. If not already `In Progress`, transition to `In Progress` via `mcp__atlassian__transitionJiraIssue`.
3. Add a comment via `mcp__atlassian__addCommentToJiraIssue`:
   > Claude started work: {message}

### On `complete`
1. Add a detailed comment via `mcp__atlassian__addCommentToJiraIssue` with the work summary (file paths, results, commands tested).
2. Log work via `mcp__atlassian__addWorklogToJiraIssue` (default 0.5h if not specified).
3. If the user explicitly requests it, transition to `Done` — otherwise, leave status as-is and let the user verify.
4. update app version build id APP_VERSION

### On `comment`
1. Add the provided message as a comment via `mcp__atlassian__addCommentToJiraIssue`.

## Trigger conditions

- The user **must** explicitly name a Jira ticket key (e.g., `VIC-1`) and invoke this skill.
- No automatic triggers — this is opt-in per task.
- If the Jira MCP server is unavailable, report the error and proceed with the work anyway.

## Related

- [[centralized-port-config]]
