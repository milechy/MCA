# Decision: Untrack .ralph/mode.json and .ralph/state.json from Git

## Status

- **Decision Date:** 2026-05-14
- **Effective Date:** 2026-05-14
- **Status:** Accepted

## Context

`.ralph/mode.json` and `.ralph/state.json` are runtime artifacts that capture 
transient operational state, not semantically versioned configuration. Committing 
them created noisy diffs, risked merge conflicts on every automated run, and 
created ambiguity about whether the files were human-curated or machine-managed. 
In Phase 1 (#2) we need a clean separation between tracked policy/config files 
and ephemeral runtime state.

## Decision

We have decided to:

1. **Untrack** `.ralph/mode.json` from Git.
2. **Untrack** `.ralph/state.json` from Git.

These files are already added to `.gitignore`. This decision formally records the 
rationale and marks the policy as accepted.

## Rationale

- **Ephemeral by design:** Both files represent mutable machine state. Any value 
  committed risks sitting stale within seconds of the next execution.
- **Reduces merge conflicts:** Multiple simultaneous runs generate conflicting 
  changes to these files.
- **Cleaner diffs:** PR diffs should reflect material code changes, not automated 
  timestamp or state updates.
- **Explicit policy:** By recording this as a decision document, future 
  contributors have a clear reference for why these files are excluded.

## Consequences

### Positive

- Diffs become focused on meaningful human changes rather than machine state.
- Merge conflicts related to runtime state are eliminated.
- Clear distinction between policy/configuration and runtime artifacts.

### Negative / Risks

- If a team member accidentally deletes `.ralph/mode.json` or `.ralph/state.json`, 
  the application must be able to reconstruct or regenerate them on the next run.
- CI pipelines or onboarding scripts must ensure these files are created when 
  missing, or provide example files (already covered by `.gitignore` rules and 
  application startup logic).

## Migration Notes

- Existing branches that still track `.ralph/mode.json` or `.ralph/state.json` 
  should remove them from the index without deleting from disk:
  ```sh
  git rm --cached .ralph/mode.json .ralph/state.json
  ```
- `.gitignore` already includes both paths; no additional ignore rules are needed.
