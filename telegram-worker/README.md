# Ralph Telegram NL Worker (Phase 13 #2)

Drive development from Telegram in natural language. You text the bot
("`src/ralph/utils` に debounce ヘルパー追加して、テストも書いて") → a Cloudflare
Worker expands it into a GitHub issue (`aider-fix` label) → the existing
Aider Resolver writes the code, opens a PR, auto-merges → Phase 13 #1
notifications message you when it lands.

**Serverless = laptop-free.** Unlike the polling bot in `src/telegram/`,
this Worker only runs when Telegram delivers a message, so nothing needs to
stay running on your machine.

## Two flows

**A. Quick one-issue** (short message): NL → one GitHub issue.
```
short text → Worker → OpenRouter (Haiku) → 1 issue (aider-fix) → reply
  → Aider Resolver → PR → auto-merge → Telegram notify
```

**B. Requirements refinement** (Phase 15 #2 — a document upload OR a long
multi-line message): a multi-turn conversation that organizes / brushes up
the requirements and decomposes them into a backlog.
```
要件定義 (.md/.txt upload or long text)
  → Worker → analyze (Sonnet) → clarifying questions → you answer (KV holds state)
  → re-analyze until clear → decompose into ordered backlog items
  → "これでOK?" → you approve
  → commit items to .github/ralph-backlog.json (GitHub Contents API)
  → the issue supplier paces them into the Aider loop
```
State between turns lives in the `REFINE_KV` namespace (key `refine:<chatId>`,
24h TTL).

## Deploy (one-time, ~10 min)

You need a Cloudflare account (free tier is fine) and `wrangler`.

```bash
cd telegram-worker

# 1. Authenticate wrangler (opens browser)
npx wrangler login

# 2. Set the secrets (you'll be prompted to paste each value)
npx wrangler secret put TELEGRAM_BOT_TOKEN        # your bot token
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # invent a random string, reuse in step 4
npx wrangler secret put ALLOWED_CHAT_ID           # your Telegram numeric chat id (comma-sep for several)
npx wrangler secret put GITHUB_PAT                # fine-grained PAT: Issues RW on milechy/MCA
npx wrangler secret put GITHUB_REPO               # milechy/MCA
npx wrangler secret put OPENROUTER_API_KEY        # same key the rest of the pipeline uses

# 3. Deploy
npx wrangler deploy
# → prints the Worker URL, e.g. https://ralph-telegram-nl.<subdomain>.workers.dev

# 4. Point Telegram's webhook at the Worker (uses the secret from step 2)
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://ralph-telegram-nl.<subdomain>.workers.dev" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### Finding your chat id

Message the bot once, then:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
# look for "chat":{"id": <this number> ...}
```

## Usage

**Quick one-issue** — text in plain language:
- "`src/ralph/utils/throttle.js` に throttle(fn, ms) を作ってテストも"

**Requirements refinement** — upload a `.md`/`.txt` requirements doc, or paste
a long multi-line spec. The bot summarizes, asks clarifying questions (reply
in one message), then proposes a decomposed backlog; reply **OK** to commit
(or send adjustments, or `キャンセル`). The KV namespace must be bound
(`REFINE_KV`, already in wrangler.toml).

Control phrases (no LLM call): `help` / `status` / `stop`.

The refinement KV namespace was created via the Cloudflare API (id in
wrangler.toml). If you redeploy in a fresh account, run
`npx wrangler kv namespace create REFINE_KV` and replace the id.

## Safety

- Only the `ALLOWED_CHAT_ID` chat(s) can drive it; every request also must
  carry the `TELEGRAM_WEBHOOK_SECRET` header (Telegram sends it).
- The LLM marks oversized/vague requests `feasible=false` and the Worker
  refuses them with an explanation instead of filing junk.
- Downstream the Aider Resolver still enforces its cost ceiling (#190) and
  auto-merge guard, so a bad issue can't run up unbounded cost.

## Cost

- Each NL expansion: ~$0.001–0.005 (Haiku, ~1k tokens).
- The resulting dev work: the usual ~$0.10/PR.

## Tests

Pure logic (auth, parse, request builders, JSON extraction) is unit-tested in
`tests/ralph/tg-worker-lib.spec.js` (run with the ralph Playwright config).
The `fetch` I/O in `index.mjs` is exercised at deploy time via a real message.
