# Phase 14: new-project bootstrapper

Stand up a brand-new **self-driving** repository from one command. The new
repo ships with the full autonomous loop wired (Aider Resolver + issue
supplier + Telegram notifications), so from birth you can feed it work and
it builds itself — same as MCA, but standalone.

## What it does

`planProject({ name, kind, description })` → a complete plan; the orchestrator
executes it:

1. `gh repo create <owner>/<slug>` (private by default)
2. Write generated starter files: `README.md`, `.gitignore`, `package.json`
   (with a runnable `npm test`), a starter `src/` + `test/`, an empty
   `.github/ralph-backlog.json`.
3. Copy the **proven** workflow/script files verbatim from MCA (single source
   of truth): `aider-resolver.yml`, `issue-supplier.yml`, `notify-telegram`,
   `telegram-notify`, `issue-supplier` script, `backlog-supplier`.
4. `git init/commit/push` to the new repo's `main`.
5. Set repo **secrets** (from your shell env): `LLM_API_KEY`, `PAT_TOKEN`,
   `PAT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   Set **variables**: `LLM_MODEL`, `AIDER_TEST_CMD=npm test` (so the resolver
   runs the NEW repo's tests, not MCA's), `AIDER_DAILY_CAP_USD`,
   `AIDER_AUTO_MERGE=1`, `ISSUE_SUPPLIER_ENABLED=0` (autonomous supply off
   until you opt in).
6. Create the `aider-fix` label + file the first scaffold issue → the loop
   starts building.
7. For `cf-worker` / `cf-pages` kinds: generate `wrangler.toml` + a Worker/
   Pages skeleton and print the deploy command (you run `wrangler deploy`
   after `wrangler login` — CF auth can't be done headlessly).

## Kinds

| kind | what you get | Cloudflare |
|---|---|---|
| `node-lib` (default) | `src/index.js` + `test/`, `node --test` | none |
| `cf-worker` | `src/index.mjs` Worker + `wrangler.toml` | `wrangler deploy` |
| `cf-pages` | `public/index.html` | `wrangler pages deploy` |

## Usage

```bash
# dry-run (default) — prints the full plan, creates NOTHING
node scripts/ralph/bootstrap-project.js --name "Edge API" --kind cf-worker --description "tiny edge API"

# for real — needs gh authed with repo scope; secrets read from your env
LLM_API_KEY=... PAT_TOKEN=... PAT_USERNAME=milechy \
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  node scripts/ralph/bootstrap-project.js --name "Edge API" --kind cf-worker \
       --description "tiny edge API" --execute
```

Flags: `--name` (required), `--kind`, `--description`, `--owner` (default
milechy), `--public`, `--execute`, `--root`.

## Honest limits

- **Local files**: the new repo lives on GitHub; the loop runs on Actions.
  Nothing is written to your laptop. `git clone` it when you want it local —
  this is intentional (the whole architecture is laptop-free).
- **Cloudflare deploy** is operator-run (`wrangler login` is interactive).
  The bootstrapper generates the CF files and prints the deploy command.
- **Secrets** are only set on the new repo for vars present in your shell
  env; unset ones are skipped (and the loop no-ops on them — e.g. no Telegram
  token → no notifications, everything else still works).
- Driven from Telegram too: ask the NL worker "新規プロジェクト〇〇作って" once
  a future intent is added — today the bootstrapper is CLI-only (the Telegram
  worker files issues into an existing repo; cross-repo creation is a
  follow-up).

## Tests

`tests/ralph/project-bootstrap.spec.js` — 10 tests on the pure planner
(slug, per-kind file manifests, secrets/vars, cloudflare targets, that the
copied template sources actually exist). The orchestrator's gh/git/wrangler
I/O is exercised by a real `--execute` run.
