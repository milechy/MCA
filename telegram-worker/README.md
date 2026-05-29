# Ralph Telegram NL Worker (Phase 13 #2)

Drive development from Telegram in natural language. You text the bot
("`src/ralph/utils` に debounce ヘルパー追加して、テストも書いて") → a Cloudflare
Worker expands it into a GitHub issue (`aider-fix` label) → the existing
Aider Resolver writes the code, opens a PR, auto-merges → Phase 13 #1
notifications message you when it lands.

**Serverless = laptop-free.** Unlike the polling bot in `src/telegram/`,
this Worker only runs when Telegram delivers a message, so nothing needs to
stay running on your machine.

## Architecture

```
You (Telegram, natural language)
  → Telegram webhook → Cloudflare Worker (this)
      → verify webhook secret + allowed chat id
      → OpenRouter (Haiku) expands NL → structured issue JSON
      → GitHub API: create issue with aider-fix label
      → reply "📥 issue #N created"
  → Aider Resolver (existing) → PR → auto-merge
  → Telegram notification (Phase 13 #1) "✅ merged"
```

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

Just text the bot in plain language. Examples:
- "`src/ralph/utils/throttle.js` に throttle(fn, ms) を作ってテストも"
- "kimi-cost-tracker に週次集計の関数足して"

Control phrases (no LLM call):
- `help` — usage
- `status` — link to the Actions tab
- `stop` — how to pause the autonomous supplier

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
