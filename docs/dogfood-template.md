# Ralph dogfood spec template

## Test convention

This project uses **@playwright/test**, never jest. Top-level `test('name', () => {...})` only. No describe/it/beforeEach/afterEach. For dependencies that need mocking, use dependency injection (accept the dep as a function parameter with a sensible default).

- This project uses **@playwright/test**, never jest.
- Top-level `test('name', () => {...})` only. No describe/it/beforeEach/afterEach.
- For dependencies that need mocking, use dependency injection (accept the dep as a function parameter with a sensible default).

## APPEND-only rule

For any `MODIFY EXISTING` file, every pre-existing test, function, export, and require statement MUST still exist verbatim after the edit. Only APPEND new content; do not delete or reorder pre-existing items. The autonomous loop will reject any patch that removes pre-existing tests.

- For any `MODIFY EXISTING` file, every pre-existing test, function, export, and require statement MUST still exist verbatim after the edit.
- Only APPEND new content; do not delete or reorder pre-existing items.
- The autonomous loop will reject any patch that removes pre-existing tests.

## 250 LOC ceiling

Kimi K2.6 reliably hits its 5-minute runtime cap on specs larger than ~250 LOC of total expected output. When a feature requires more, split it into multiple smaller stories (module first, then CLI, then spec) so each fits inside Kimi's budget.

## Injectable deps pattern

Every external dependency of a new module SHOULD be injectable via a function parameter with a sensible default lazy-required inside the function body. This keeps unit tests fast (no fs / no subprocess) and avoids singletons.

```js
function buildThing({ rootDir, loadX = defaultLoadX, spawn = require('node:child_process').spawnSync } = {}) {
  // ...
}
```

## Verbatim export contract

For MODIFY EXISTING stories, explicitly list every existing export name in the spec injection so Kimi knows none can be removed or reordered. For CREATE stories, list every required export name in the spec injection (Kimi tends to skip 1-2 if not listed). The module.exports block at the bottom of the file is a single object literal with one entry per exported name.

- For MODIFY EXISTING: list every existing export verbatim that must be preserved.
- For CREATE: list every required export name in the spec injection.
- The module.exports block at the bottom of the file is a single object literal with one entry per exported name.

## Spec injection checklist

1. Front-load the @playwright/test convention block at the top of the spec.
2. List BOTH files in `requested_paths` (the coverage gate enforces this).
3. State each file's action explicitly: CREATE or MODIFY EXISTING.
4. For MODIFY EXISTING: list every existing export verbatim that must be preserved.
5. For tests: append at the END of the existing file, never edit-in-place.
6. Keep total expected output under 250 LOC. Split if larger.
7. State the success criterion explicitly: `Tests must pass: npm run test:ralph -- <spec-file>`.
