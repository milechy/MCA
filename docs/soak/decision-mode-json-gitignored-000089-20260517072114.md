# Decision: Untrack `.ralph/mode.json` and `.ralph/state.json` from Git

## Context

Ralph uses a `.ralph/` directory to store runtime and operational metadata. Two JSON files have historically been tracked in Git:

- `.ralph/mode.json` — stores the current operating mode of the Ralph instance.
- `.ralph/state.json` — stores transient runtime state (e.g., current phase, lock status, session IDs).

These files are updated automatically during normal execution. Because they change frequently and their values are environment-specific, tracking them in Git creates unnecessary noise in diffs and risks merge conflicts across environments.

## Decision

We will **untrack** both `.ralph/mode.json` and `.ralph/state.json` from Git by adding them to `.gitignore`.

## Consequences

- Developers and CI will no longer see uncommitted changes in these files after every run.
- Each environment (local, CI, staging, production) is free to maintain its own runtime state without conflict.
- Ralph must ensure these files are regenerated safely when missing (e.g., on a fresh clone or after `git clean`).

## Status

- **Phase:** 1
- **Item:** #2
- **Date:** 2026-05-17
- **Decision:** Accepted

## Phase 1 #2

This decision is part of the broader Phase 1 cleanup initiative to reduce repository churn and separate runtime concerns from version-controlled configuration.
