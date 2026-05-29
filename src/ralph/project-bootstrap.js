// Phase 14 #1: new-project bootstrapper (pure planning).
//
// Given a project spec, produce the full PLAN to stand up a brand-new
// self-driving repo: repo settings, the file manifest (generated content +
// proven workflows to copy from this repo), the secrets/variables the new
// repo needs, an optional Cloudflare target, and the first scaffold issue
// that kicks the autonomous loop. The orchestrator (scripts/ralph/
// bootstrap-project.js) executes this plan via gh / git / wrangler.
//
// Pure + testable: planProject() reads nothing and calls nothing.

const KINDS = ['node-lib', 'cf-worker', 'cf-pages'];

function slug(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'project';
}

// ---- generated file contents (small, embedded) -------------------------

function readme(name, description) {
  return `# ${name}

${description || 'An autonomous-loop project.'}

This repo is **self-driving**: file a GitHub issue with the \`aider-fix\`
label (or add items to \`.github/ralph-backlog.json\`) and the Aider Resolver
writes the code, opens a PR, runs tests, and auto-merges. Bootstrapped by the
Ralph project bootstrapper (Phase 14).

## Develop
- Add work to \`.github/ralph-backlog.json\` → the scheduled supplier files it.
- Or open an issue + \`aider-fix\` label for one-off work.
- Tests: \`npm test\`.
`;
}

function gitignore() {
  return ['node_modules/', '.ralph/', '*.log', '.DS_Store', 'dist/', '.wrangler/'].join('\n') + '\n';
}

function packageJson(name, kind) {
  const pkg = {
    name: slug(name),
    version: '0.1.0',
    private: true,
    scripts: {
      // generic test entry the copied aider-resolver will call via AIDER_TEST_CMD
      test: 'node --test'
    }
  };
  if (kind === 'cf-worker') {
    pkg.scripts.deploy = 'wrangler deploy';
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

// A tiny starter source + test so `npm test` (node --test) passes on day one
// and Aider has a pattern to follow.
function starterFiles(kind) {
  if (kind === 'cf-worker') {
    return [
      {
        path: 'src/index.mjs',
        content: `export default {
  async fetch(request) {
    return new Response('hello from ${'${'}new Date().toISOString()}', { status: 200 });
  }
};
`
      },
      {
        path: 'wrangler.toml',
        content: `name = "REPO_SLUG"
main = "src/index.mjs"
compatibility_date = "2026-05-01"
`
      },
      {
        path: 'test/smoke.test.js',
        content: `const { test } = require('node:test');
const assert = require('node:assert');
test('placeholder smoke test passes', () => { assert.equal(1 + 1, 2); });
`
      }
    ];
  }
  if (kind === 'cf-pages') {
    return [
      { path: 'public/index.html', content: '<!doctype html><html><body><h1>REPO_SLUG</h1></body></html>\n' },
      {
        path: 'test/smoke.test.js',
        content: `const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
test('index.html exists', () => { assert.ok(fs.existsSync('public/index.html')); });
`
      }
    ];
  }
  // node-lib
  return [
    {
      path: 'src/index.js',
      content: `function hello(name) { return 'hello ' + (name || 'world'); }
module.exports = { hello };
`
    },
    {
      path: 'test/index.test.js',
      content: `const { test } = require('node:test');
const assert = require('node:assert');
const { hello } = require('../src/index');
test('hello greets', () => { assert.equal(hello('x'), 'hello x'); assert.equal(hello(), 'hello world'); });
`
    }
  ];
}

function seedBacklog(name, description) {
  return JSON.stringify({
    version: 'ralph-backlog-v1',
    _comment: `Autonomous work queue for ${name}. The supplier files the next un-filed item as an aider-fix issue. Add items at the bottom.`,
    items: []
  }, null, 2) + '\n';
}

// Proven, long workflow/script files are copied verbatim from THIS repo
// rather than re-embedded (single source of truth). The orchestrator
// resolves `copyFrom` by reading the current checkout.
const COPY_FILES = [
  { path: '.github/workflows/aider-resolver.yml', copyFrom: '.github/workflows/aider-resolver.yml' },
  { path: '.github/workflows/issue-supplier.yml', copyFrom: '.github/workflows/issue-supplier.yml' },
  { path: 'scripts/ralph/notify-telegram.js', copyFrom: 'scripts/ralph/notify-telegram.js' },
  { path: 'src/ralph/telegram-notify.js', copyFrom: 'src/ralph/telegram-notify.js' },
  { path: 'scripts/ralph/issue-supplier.js', copyFrom: 'scripts/ralph/issue-supplier.js' },
  { path: 'src/ralph/backlog-supplier.js', copyFrom: 'src/ralph/backlog-supplier.js' }
];

// ---- the plan -----------------------------------------------------------

function planProject({ name, kind = 'node-lib', description = '', owner = 'milechy', visibility = 'private' } = {}) {
  if (!name || !String(name).trim()) return { ok: false, reason: 'name_required' };
  if (!KINDS.includes(kind)) return { ok: false, reason: 'unknown_kind', allowed: KINDS };

  const repoSlug = slug(name);

  const generated = [
    { path: 'README.md', content: readme(name, description) },
    { path: '.gitignore', content: gitignore() },
    { path: 'package.json', content: packageJson(name, kind) },
    { path: '.github/ralph-backlog.json', content: seedBacklog(name, description) },
    ...starterFiles(kind).map((f) => ({
      ...f,
      content: f.content.replace(/REPO_SLUG/g, repoSlug)
    }))
  ];

  const isCf = kind === 'cf-worker' || kind === 'cf-pages';

  return {
    ok: true,
    repo: {
      name: repoSlug,
      owner,
      full_name: `${owner}/${repoSlug}`,
      visibility,
      description: description || `${name} (autonomous-loop project)`
    },
    files: [...generated, ...COPY_FILES],
    // The new repo needs the same pipeline credentials. AIDER_TEST_CMD is set
    // to `npm test` so the copied resolver runs THIS repo's tests, not MCA's.
    secrets_needed: ['LLM_API_KEY', 'PAT_TOKEN', 'PAT_USERNAME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    variables: {
      LLM_MODEL: 'openrouter/anthropic/claude-haiku-4.5',
      AIDER_TEST_CMD: 'npm test',
      AIDER_DAILY_CAP_USD: '5.00',
      AIDER_AUTO_MERGE: '1',
      ISSUE_SUPPLIER_ENABLED: '0'
    },
    cloudflare: isCf
      ? {
          type: kind === 'cf-worker' ? 'worker' : 'pages',
          name: repoSlug,
          deploy_cmd: kind === 'cf-worker' ? 'npx wrangler deploy' : `npx wrangler pages deploy public --project-name ${repoSlug}`
        }
      : null,
    first_issue: {
      title: `[BOOT-1] Scaffold: ${name}`,
      body: `## Task\nFlesh out the initial implementation of **${name}**.\n\n${description ? `## Goal\n${description}\n\n` : ''}## Requirements\n- Implement the core functionality in \`src/\`.\n- Add tests under \`test/\` runnable via \`npm test\` (node --test).\n- Keep the change focused; further work will come as additional backlog items.\n\n## Context\nFirst scaffold issue, filed by the project bootstrapper. The repo already\nhas the autonomous-loop workflows wired.`
    }
  };
}

module.exports = {
  KINDS,
  slug,
  planProject,
  COPY_FILES,
  // exported for tests / reuse
  _internals: { readme, gitignore, packageJson, starterFiles, seedBacklog }
};
