#!/usr/bin/env node
// Phase 15 #1 CLI: interactive requirements refinement.
//
// Paste/point at a requirements doc → the refiner summarizes, asks clarifying
// questions (you answer in the terminal), re-analyzes until clear, decomposes
// into a backlog, shows it, and on approval appends the items to
// .github/ralph-backlog.json (which the autonomous supplier then paces out).
//
// This is the SAME brain the Telegram surface will use (Phase 15 #2); the CLI
// lets you run the full conversation today, with real OpenRouter calls.
//
// Usage:
//   node scripts/ralph/refine-requirements.js --file requirements.md
//   node scripts/ralph/refine-requirements.js              # paste, end with Ctrl-D
//   (flags: --model <slug> --root <dir> --dry-run  --max-rounds <n>)
//
// API key resolved from OPENROUTER_API_KEY → KIMI_API_KEY → opencode auth.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const R = require('../../src/ralph/requirements-refiner');

function resolveApiKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  if (env.KIMI_API_KEY) return env.KIMI_API_KEY;
  try {
    const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')).openrouter || {}).key || '';
  } catch { return ''; }
}

function parseArgs(argv) {
  const a = { file: null, model: null, root: process.cwd(), dryRun: false, maxRounds: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--file') a.file = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--root') a.root = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--max-rounds') a.maxRounds = parseInt(argv[++i], 10) || 3;
  }
  return a;
}

function ask(rl, q) { return new Promise((res) => rl.question(q, (ans) => res(ans))); }
function readStdin() {
  return new Promise((res) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => res(s)); });
}

async function callLLM(req) {
  const res = await fetch(req.url, req.init);
  const json = await res.json();
  return json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const apiKey = resolveApiKey();
  if (!apiKey) { console.error('No OpenRouter API key.'); process.exitCode = 1; return; }

  let doc = '';
  if (args.file) doc = fs.readFileSync(args.file, 'utf8');
  else { console.log('要件定義を貼り付けてください。終わったら Ctrl-D:'); doc = await readStdin(); }
  doc = doc.trim();
  if (!doc) { console.error('empty doc'); process.exitCode = 1; return; }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const qa = [];
  let analysis = null;
  let round = 0;

  // analyze ⇄ clarify loop
  while (round < args.maxRounds) {
    round += 1;
    const req = R.buildAnalyzeRequest({ apiKey, model: args.model, doc, qa });
    const content = await callLLM(req);
    analysis = R.parseAnalysis(content);
    if (!analysis) { console.error('analyze: could not parse LLM output'); rl.close(); process.exitCode = 1; return; }

    console.log('\n=== 整理結果 ===');
    console.log('要約:', analysis.summary);
    if (analysis.features.length) { console.log('機能:'); analysis.features.forEach((f) => console.log(`  - ${f.name}: ${f.description || ''}`)); }
    if (analysis.risks.length) { console.log('リスク/未定:'); analysis.risks.forEach((r) => console.log(`  ! ${r}`)); }

    if (analysis.ready || !analysis.open_questions.length) break;

    console.log('\n' + R.formatQuestions(analysis.open_questions));
    for (const q of analysis.open_questions) {
      const ans = await ask(rl, `> ${q}\n  答え (skip でスキップ): `);
      if (ans.trim() && ans.trim().toLowerCase() !== 'skip') qa.push({ q, a: ans.trim() });
    }
  }

  // decompose
  console.log('\n分解しています…');
  const decReq = R.buildDecomposeRequest({ apiKey, model: args.model, doc, qa, summary: analysis.summary });
  const decContent = await callLLM(decReq);
  const decomposition = R.parseDecomposition(decContent);
  if (!decomposition) { console.error('decompose: could not parse'); rl.close(); process.exitCode = 1; return; }

  console.log('\n' + R.formatForApproval(decomposition));
  const verdict = await ask(rl, '\n> ');
  rl.close();

  if (R.isCancel(verdict) || !R.isApproval(verdict)) {
    console.log(R.isCancel(verdict) ? 'キャンセルしました。' : `承認以外の入力でした（"${verdict}"）。backlog には入れていません。手動で調整してください。`);
    return { ok: true, approved: false, decomposition };
  }

  // commit to backlog
  const items = R.toBacklogItems(decomposition);
  const backlogPath = path.join(args.root, '.github', 'ralph-backlog.json');
  if (args.dryRun) {
    console.log(`\n[dry-run] ${items.length} 件を ${backlogPath} に追加するところでした:`);
    items.forEach((it) => console.log(`  - ${it.id}: ${it.title}`));
    return { ok: true, dry_run: true, items };
  }
  let backlog = { version: 'ralph-backlog-v1', items: [] };
  if (fs.existsSync(backlogPath)) { try { backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8')); } catch { /* keep default */ } }
  backlog.items = (backlog.items || []).concat(items);
  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
  fs.writeFileSync(backlogPath, JSON.stringify(backlog, null, 2) + '\n', 'utf8');
  console.log(`\n✅ ${items.length} 件を ${backlogPath} に追加しました。commit/push すると supplier が順次消化します。`);
  return { ok: true, committed: items.length };
}

if (require.main === module) main();

module.exports = { parseArgs, resolveApiKey, main };
