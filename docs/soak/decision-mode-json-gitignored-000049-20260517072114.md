# Decision: Untrack `.ralph/mode.json` and `.ralph/state.json` from Git

## Context
`.ralph/mode.json` and `.ralph/state.json` are runtime state files that change frequently during normal operation. Tracking them in Git causes unnecessary noise in diffs and can lead to merge conflicts.

## Decision
Untrack both files from Git by adding them to `.gitignore` and removing them from the index (while keeping local copies).

## Rationale
- They are machine-local runtime state, not source code.
- They change on nearly every invocation, polluting `git status`.
- They are already recreated automatically if missing.

## Consequences
- Clean `git status` going forward.
- Developers must ensure `.ralph/*.json` is in `.gitignore` and the files are removed from the Git index.
- These files will still persist locally but will not be part of the repository.
