#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUSPICIOUS_PATTERNS = Object.freeze([
  { id: 'telegram_bot_token_assignment', pattern: /TELEGRAM_BOT_TOKEN\s*=\s*["']?(?!<private bot token>|<private value, never commit>|\$\{?\w+\}?|\s*$)[0-9A-Za-z:_-]{12,}/ },
  { id: 'telegram_allowed_user_ids_assignment', pattern: /TELEGRAM_ALLOWED_USER_IDS\s*=\s*["']?\d{5,}(?:\s*,\s*\d{5,})*/ },
  { id: 'telegram_allowed_chat_ids_assignment', pattern: /TELEGRAM_ALLOWED_CHAT_IDS\s*=\s*["']?-?\d{5,}(?:\s*,\s*-?\d{5,})*/ },
  { id: 'persistent_run_all_gate_yaml_true', pattern: /RALPH_TELEGRAM_RUN_ALL_ENABLED\s*:\s*["']?true["']?/ },
  { id: 'persistent_run_all_gate_env_true', pattern: /RALPH_TELEGRAM_RUN_ALL_ENABLED\s*=\s*["']?true["']?/ },
  { id: 'github_secret_bot_token_reference', pattern: /secrets\.TELEGRAM_BOT_TOKEN/ }
]);

const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.js', '.json', '.md', '.yml', '.yaml', '.sh', '.env', '.txt'
]);

const DEFAULT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'test-results', 'playwright-report', '.next', 'dist', 'build'
]);

function listFiles(rootDir, options = {}) {
  const includeExtensions = options.includeExtensions || DEFAULT_INCLUDE_EXTENSIONS;
  const skipDirs = options.skipDirs || DEFAULT_SKIP_DIRS;
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (includeExtensions.has(ext) || entry.name.startsWith('.env')) files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function scanText({ source, text, patterns = SUSPICIOUS_PATTERNS }) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of patterns) {
      if (rule.pattern.test(line)) {
        findings.push({ source, line: index + 1, rule_id: rule.id });
      }
    }
  });
  return findings;
}

function scanFiles(rootDir, options = {}) {
  const findings = [];
  for (const filePath of listFiles(rootDir, options)) {
    const relative = path.relative(rootDir, filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    findings.push(...scanText({ source: relative, text }));
  }
  return findings;
}

function gitDiff(rootDir, args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout || '';
}

function preflightNoSecrets({ rootDir = process.cwd(), includeGitDiff = true } = {}) {
  const findings = scanFiles(rootDir);

  if (includeGitDiff) {
    const unstaged = gitDiff(rootDir, ['diff', '--no-ext-diff']);
    const staged = gitDiff(rootDir, ['diff', '--cached', '--no-ext-diff']);
    findings.push(...scanText({ source: 'git diff', text: unstaged }));
    findings.push(...scanText({ source: 'git diff --cached', text: staged }));
  }

  return {
    ok: findings.length === 0,
    findings
  };
}

function main() {
  const result = preflightNoSecrets({ rootDir: process.cwd(), includeGitDiff: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  SUSPICIOUS_PATTERNS,
  listFiles,
  scanText,
  scanFiles,
  preflightNoSecrets
};
