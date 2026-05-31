#!/usr/bin/env node
// Record one production Aider attempt's outcome to the Cloudflare D1 learning
// store so the brain's next model choice for this context bucket learns from it.
// No-op (exit 0) if D1 isn't configured, so the workflow never breaks on it.
//
// Usage:
//   node scripts/ralph/ci-record-outcome.js --story-id issue-257 \
//     --context-bucket "easy|create|js|2-3f" --difficulty easy \
//     --model openrouter/moonshotai/kimi-k2.6 --attempt 0 \
//     --succeeded true --cost 0.04 --failure-class ""
const { recordOutcome, isConfigured } = require('../../src/ralph/d1-learning-store');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] || fallback);
}

async function main() {
  if (!isConfigured(process.env)) {
    process.stderr.write('ci-record-outcome: D1 not configured — skipping\n');
    return;
  }
  const succeededArg = arg('--succeeded');
  const succeeded = succeededArg === 'true' ? true : succeededArg === 'false' ? false : null;
  const r = await recordOutcome({
    story_id: arg('--story-id'),
    context_bucket: arg('--context-bucket') || null,
    difficulty: arg('--difficulty') || null,
    model: arg('--model'),
    attempt_number: Number(arg('--attempt', '0')) || 0,
    succeeded,
    cost_usd: Number(arg('--cost', '0')) || 0,
    failure_class: arg('--failure-class') || null,
    routing_source: arg('--routing-source') || 'ci_aider',
    env: process.env
  });
  process.stderr.write('ci-record-outcome: ' + JSON.stringify(r) + '\n');
}

main().catch((e) => { process.stderr.write('ci-record-outcome error: ' + e.message + '\n'); process.exit(0); });
