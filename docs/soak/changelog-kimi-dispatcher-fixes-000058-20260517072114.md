# Changelog: Kimi Dispatcher Fixes (PR #46)

This release rewrites the worktree prompt generation logic for improved clarity and maintainability, swaps the classification order so that models are evaluated in a more intuitive sequence, and downgrades the soft-timeout handling so that timeouts are treated as advisory rather than hard failures—reducing spurious retries while preserving resiliency.
