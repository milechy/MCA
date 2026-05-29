#!/usr/bin/env node
// Phase 14 #1 CLI: bootstrap a brand-new self-driving project.
//
// Usage:
//   node scripts/ralph/bootstrap-project.js --name "My Thing" --kind node-lib \
//        --description "what it does" [--owner milechy] [--public] [--execute]
//
// DRY-RUN by default: prints the full plan (repo, files, commands) without
// touching GitHub/Cloudflare. Pass --execute to actually:
//   1. gh repo create <owner>/<slug> (--private|--public)
//   2. write generated files + copy the proven workflow/script files
//   3. git init / commit / push
//   4. set repo secrets (from env: LLM_API_KEY, PAT_TOKEN, PAT_USERNAME,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) + variables
//   5. (cf kinds) print the wrangler deploy command (operator runs it; needs
//      wrangler login)
//   6. file the first scaffold issue (aider-fix) → loop starts
//
// Requires `gh` authed with repo scope. Secrets are read from THIS shell's
// env so nothing sensitive is printed or committed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planProject } = require('../../src/ralph/project-bootstrap');

function parseArgs(argv) {
  const a = { name: null, kind: 'node-lib', description: '', owner: 'milechy', visibility: 'private', execute: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--name') a.name = argv[++i];
    else if (k === '--kind') a.kind = argv[++i];
    else if (k === '--description') a.description = argv[++i];
    else if (k === '--owner') a.owner = argv[++i];
    else if (k === '--public') a.visibility = 'public';
    else if (k === '--execute') a.execute = true;
    else if (k === '--root') a.root = argv[++i];
  }
  return a;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function printPlan(plan) {
  const out = [];
  out.push(`repo:      ${plan.repo.full_name} (${plan.repo.visibility})`);
  out.push(`desc:      ${plan.repo.description}`);
  out.push(`files (${plan.files.length}):`);
  for (const f of plan.files) out.push(`  - ${f.path}${f.copyFrom ? `  (copy ← ${f.copyFrom})` : ''}`);
  out.push(`secrets:   ${plan.secrets_needed.join(', ')}`);
  out.push(`variables: ${Object.entries(plan.variables).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  out.push(`cloudflare:${plan.cloudflare ? ` ${plan.cloudflare.type} → ${plan.cloudflare.deploy_cmd}` : ' none'}`);
  out.push(`first issue: ${plan.first_issue.title}`);
  return out.join('\n');
}

function materializeFiles(plan, { srcRoot, destRoot }) {
  for (const f of plan.files) {
    const dest = path.join(destRoot, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.copyFrom) {
      const from = path.join(srcRoot, f.copyFrom);
      fs.copyFileSync(from, dest);
    } else {
      fs.writeFileSync(dest, f.content, 'utf8');
    }
  }
}

function execute(plan, args, { stdout }) {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `boot-${plan.repo.name}-`));
  stdout.write(`workdir: ${tmp}\n`);

  // 1. create repo
  stdout.write(`creating ${plan.repo.full_name} ...\n`);
  sh('gh', ['repo', 'create', plan.repo.full_name, `--${plan.repo.visibility}`, '--description', plan.repo.description]);

  // 2. materialize files
  materializeFiles(plan, { srcRoot: args.root, destRoot: tmp });

  // 3. git init + push
  sh('git', ['init', '-b', 'main'], { cwd: tmp });
  sh('git', ['add', '.'], { cwd: tmp });
  sh('git', ['commit', '-m', `Bootstrap ${plan.repo.name} (autonomous-loop scaffold)`], { cwd: tmp });
  sh('git', ['remote', 'add', 'origin', `https://github.com/${plan.repo.full_name}.git`], { cwd: tmp });
  sh('git', ['push', '-u', 'origin', 'main'], { cwd: tmp });
  stdout.write('pushed scaffold to main\n');

  // 4. secrets + variables (secrets from env; skip any that are unset)
  for (const s of plan.secrets_needed) {
    const val = process.env[s];
    if (!val) { stdout.write(`  secret ${s}: SKIPPED (not in env)\n`); continue; }
    sh('gh', ['secret', 'set', s, '--repo', plan.repo.full_name, '--body', val]);
    stdout.write(`  secret ${s}: set\n`);
  }
  for (const [k, v] of Object.entries(plan.variables)) {
    sh('gh', ['variable', 'set', k, '--repo', plan.repo.full_name, '--body', String(v)]);
    stdout.write(`  variable ${k}=${v}: set\n`);
  }

  // 5. cloudflare (operator runs deploy; needs wrangler login)
  if (plan.cloudflare) {
    stdout.write(`cloudflare: clone the repo and run \`${plan.cloudflare.deploy_cmd}\` after \`npx wrangler login\`.\n`);
  }

  // 6. first scaffold issue — create the aider-fix label first (a fresh repo
  // has no labels; `gh issue create --label` fails on a missing label, a
  // trap we hit earlier with issue #182).
  try {
    sh('gh', ['label', 'create', 'aider-fix', '--repo', plan.repo.full_name, '--description', 'Trigger Aider Resolver', '--color', '0066ff']);
  } catch { stdout.write('  (aider-fix label already exists)\n'); }
  const issue = sh('gh', ['issue', 'create', '--repo', plan.repo.full_name, '--title', plan.first_issue.title, '--body', plan.first_issue.body, '--label', 'aider-fix']).trim();
  stdout.write(`first issue filed: ${issue}\n`);
  stdout.write('\n✅ bootstrap complete. The new repo is self-driving.\n');
}

function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const plan = planProject({ name: args.name, kind: args.kind, description: args.description, owner: args.owner, visibility: args.visibility });
  if (!plan.ok) { stdout.write(`bootstrap: cannot plan — ${plan.reason}${plan.allowed ? ` (allowed: ${plan.allowed.join(', ')})` : ''}\n`); return plan; }

  stdout.write('=== PLAN ===\n' + printPlan(plan) + '\n');
  if (!args.execute) {
    stdout.write('\n(dry-run — pass --execute to create the repo. `aider-fix` label must exist on the new repo, the workflow creates it on first need.)\n');
    return { ok: true, dry_run: true, plan };
  }
  // pre-req sanity: the copyFrom sources must exist in this checkout
  const { COPY_FILES } = require('../../src/ralph/project-bootstrap');
  for (const f of COPY_FILES) {
    if (!fs.existsSync(path.join(args.root, f.copyFrom))) {
      stdout.write(`bootstrap: missing template source ${f.copyFrom} — run from the MCA repo root.\n`);
      return { ok: false, reason: 'missing_template_source', file: f.copyFrom };
    }
  }
  execute(plan, args, { stdout });
  return { ok: true, executed: true, plan };
}

if (require.main === module) main();

module.exports = { parseArgs, printPlan, materializeFiles, main };
