# External Agent Gateway Compatibility Boundary

This document defines the compatibility boundary for external agent gateway integrations such as NemoClaw, OpenClaw-style gateways, or any future agent orchestrator.

## Decision

External agent gateways are adapter candidates only. They are not a new source of authority.

Telegram authorization, Ralph approvals, sandbox preflight, bounded artifact retrieval, local gates, and repository cleanliness checks remain the source of truth.

## Allowed role

An external gateway may provide one or more of these capabilities:

- Translate an approved operator task into an agent prompt.
- Run an agent inside the approved sandbox working directory.
- Produce `candidate.patch` inside the approved sandbox only.
- Return bounded metadata: exit code, duration, redacted stdout/stderr preview, and candidate patch path.

## Required adapter contract

An adapter must expose a deterministic local contract equivalent to:

```js
runCandidatePatch({
  rootDir,
  sandboxRoot,
  task,
  requestedPaths,
  env,
  timeoutMs
}) => {
  ok,
  reason,
  commandPreview,
  exitCode,
  startedAt,
  finishedAt,
  stdoutPreview,
  stderrPreview,
  candidatePatchPath,
  filesModified,
  repositoryFilesModified
}
```

The adapter must write only:

```text
<approved sandbox root>/candidate.patch
```

It must not write directly to repository paths outside the sandbox.

## Hard requirements

Every gateway adapter must preserve all of the following controls:

```text
Telegram authorization required
approved sandbox plan required
approved sandbox preflight required
working tree clean before execution
pre-secret-scan pass required
sandbox cwd required
requested path allowlist required
forbidden path denylist required
bounded redacted output only
candidate.patch preview required
separate approval required before apply
local gates required before commit
separate approval required before push
separate approval required before PR creation
```

## Hard non-goals

The following remain out of scope:

```text
unrestricted shell execution
persistent agent credentials in repository
production secrets in CI or Telegram
production deploy from Telegram
migration from Telegram
merge from Telegram
agent-initiated git commit
agent-initiated git push
agent-initiated PR creation
bypassing Ralph approvals
bypassing sandbox preflight
bypassing local gates
raw full logs in Telegram
raw Telegram payloads in Telegram
```

## Security boundary

External gateways are considered untrusted execution providers. Their output is treated as proposed patch material only.

A gateway must not be allowed to decide:

- Whether a patch can be applied.
- Whether a commit can be created.
- Whether a push can occur.
- Whether a pull request can be opened.
- Whether deployment or migration can occur.

Those decisions remain in the Ralph/Telegram approval chain.

## Compatibility checklist

Before adding a concrete NemoClaw, OpenClaw, or other external gateway runtime dependency, require a separate approval and implementation issue with:

```text
adapter name
exact executable or API used
credential handling plan
sandbox cwd guarantee
timeout behavior
abort behavior
output redaction behavior
candidate.patch path guarantee
local test double
real smoke procedure
rollback/disable procedure
```

## Current status

No external gateway runtime dependency is approved by this document.

The current approved execution path is the real OpenCode CLI adapter smoke-tested through the controlled sandbox candidate patch flow.
