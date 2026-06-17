# Decision: Untrack `.ralph/mode.json` and `.ralph/state.json` from Git

## Context
The `.ralph/mode.json` and `.ralph/state.json` files contain transient session state that changes frequently during operation. Tracking them in git leads to unnecessary noise in diffs and a risk of accidentally committing machine-local or ephemeral state.

## Decision
Add `.ralph/mode.json` and `.ralph/state.json` to `.gitignore` and stop tracking them in the repository.

## Consequences
- **Positive:** Cleaner diffs, reduced risk of committing transient state, no merge conflicts for session state.
- **Negative:** New clones will not have these files; consumers must ensure they are created at runtime if required.
