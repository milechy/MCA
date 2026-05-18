# Decision: Untrack `.ralph/mode.json` and `.ralph/state.json` from Git

**Status:** Approved  
**Date:** 2026-05-17  
**Issue:** #2  

## Context

The Ralph orchestrator manages conversation mode (e.g., inference vs. training) via `.ralph/mode.json` and persists mutable state such as active tasks, tool call results, and checkpoint metadata via `.ralph/state.json`. Both files are currently tracked under version control.

## Problem

Because these files are tracked, every branch switch, merge, or reset risks propagating stale or branch-specific mode/state into unrelated contexts. This produces:

1. **Merge conflicts** when multiple branches update state independently.  
2. **State leakage** across sessions / users / environments.  
3. **Noise in diffs** since `state.json` changes on nearly every tool call.

## Decision

We will **untrack** `.ralph/mode.json` and `.ralph/state.json` from Git.

### Phase 1 – Immediate
- Add both files to `.gitignore`.  
- Run `git rm --cached` on them in every active branch.  
- Leave clean, template versions or README instructions in-repo describing what the files are expected to contain.

### Future (out of scope)
- Introduce a `.ralph/config.json` (or similar) with user-local overrides if any defaults need to be versioned.

## Consequences

- **Positive:** Eliminates merge conflicts and cross-session pollution for these files.  
- **Positive:** Ensures diffs only reflect meaningful code / documentation changes.  
- **Negative / Mitigation:** New checkouts will lack these files. They must be created on first run (or via a skeleton bootstrap). A template or README note is required so bootstrap tooling knows the expected schema.

## References

- Phase 1 #2  
- `.ralph/README.md` (template / bootstrap documentation)
