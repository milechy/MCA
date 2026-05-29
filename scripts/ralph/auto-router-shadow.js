#!/usr/bin/env node
// Phase 11-C CLI: shadow the OpenRouter auto-router against the fixed ladder.
//
// Recommend-only: this does NOT change real routing. For each story (or a
// single --prompt), it asks openrouter/auto what it would pick, compares to
// executor-router's ladder pick, records to .ralph/shadow-routing.jsonl, and
// prints an agreement/cost summary.
//
// Usage:
//   OPENROUTER_API_KEY=... node scripts/ralph/auto-router-shadow.js [--root <dir>] [--limit <n>]
//   OPENROUTER_API_KEY=... node scripts/ralph/auto-router-shadow.js --prompt "spec text"
//   node scripts/ralph/auto-router-shadow.js --summary   (no probing, just summarize prior runs)
//
// The API key is read from env OPENROUTER_API_KEY, then KIMI_API_KEY, then
// ~/.local/share/opencode/auth.json (same resolution as the dispatcher,
// Phase 8 #6).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { routeExecutor } = require('../../src/ralph/executor-router');
const {
  probeAutoRouter,
  compareRouting,
  recordShadow,
  summarizeShadow
} = require('../../src/ralph/auto-router-shadow');

function resolveApiKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  if (env.KIMI_API_KEY) return env.KIMI_API_KEY;
  try {
    const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j.openrouter && j.openrouter.key) || '';
  } catch { return ''; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), limit: 50, prompt: null, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 50;
    else if (a === '--prompt') args.prompt = argv[++i];
    else if (a === '--summary') args.summary = true;
  }
  return args;
}

function loadStories(rootDir, limit) {
  const dir = path.join(rootDir, '.ralph', 'stories');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .slice(0, limit)
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function loadShadowEntries(rootDir) {
  const p = path.join(rootDir, '.ralph', 'shadow-routing.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function promptForStory(story) {
  return [story.title || '', story.requirement || ''].join('\n\n').trim();
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, env = process.env } = {}) {
  const args = parseArgs(argv);

  if (args.summary) {
    const summary = summarizeShadow(loadShadowEntries(args.root));
    stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    stdout.write('ERROR: no OpenRouter API key (set OPENROUTER_API_KEY or run `opencode auth login openrouter`)\n');
    return { ok: false, reason: 'no_api_key' };
  }

  const items = args.prompt
    ? [{ story_id: 'AD-HOC', difficulty: null, _prompt: args.prompt }]
    : loadStories(args.root, args.limit);

  let probed = 0;
  for (const story of items) {
    const ladder = routeExecutor({ story });
    const prompt = story._prompt || promptForStory(story);
    const auto = await probeAutoRouter({ prompt, apiKey });
    const comparison = auto.ok
      ? compareRouting({ ladder_model: ladder.executor_model, auto_model: auto.chosen_model })
      : { comparable: false, note: auto.reason };
    recordShadow({ rootDir: args.root, story, ladder_model: ladder.executor_model, auto_result: auto, comparison });
    probed += 1;
    stdout.write(`${story.story_id} [${story.difficulty || '—'}] ladder=${ladder.executor_model} auto=${auto.chosen_model || auto.reason} → ${comparison.cost_relation || comparison.note}\n`);
  }

  const summary = summarizeShadow(loadShadowEntries(args.root));
  stdout.write('\n=== shadow summary ===\n' + JSON.stringify(summary, null, 2) + '\n');
  return { ok: true, probed, summary };
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, resolveApiKey, promptForStory, main };
