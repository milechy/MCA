#!/usr/bin/env node
// Independent pre-merge review stage (the "Evaluator/Reviewer" role) for the
// Aider Resolver. Runs on a green PR branch, AFTER the test gate, BEFORE merge:
//   1. deterministic secret / dangerous-pattern scan on the ADDED diff lines
//   2. an independent LLM review of the diff (cheap model) for security + bugs
// Prints a JSON verdict and exits 2 to BLOCK the merge (human review needed),
// 0 to allow. Fail-open on the LLM part (network/key issues never block); the
// regex scan is deterministic and DOES block.
//
// Env: OPENROUTER_API_KEY, REVIEW_MODEL (default cheap), REVIEW_DIFF_BASE
//      (default origin/<default-branch>).
const { execSync } = require('node:child_process');

const REVIEW_MODEL = process.env.REVIEW_MODEL || 'openrouter/anthropic/claude-haiku-4.5';
const MAX_DIFF_CHARS = 24000;

// Hard, deterministic blockers on ADDED lines (lines starting with '+').
const DANGER_PATTERNS = [
  { re: /\b(api[_-]?key|secret|password|access[_-]?token|private[_-]?key)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+]{16,}['"]/i, note: 'hardcoded secret/credential' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, note: 'embedded private key' },
  { re: /\beval\s*\(/, note: 'use of eval()' },
  { re: /child_process[\s\S]{0,40}\b(exec|execSync)\s*\(\s*[`'"][^`'"]*\$\{/, note: 'shell exec with interpolation' },
  { re: /\brm\s+-rf\s+[\/$~]/, note: 'destructive rm -rf on an absolute/home/var path' },
  { re: /--dangerously-skip-permissions|--dangerously/i, note: 'dangerous flag' }
];

function addedLines(diff) {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
}

function scanDanger(diff) {
  const issues = [];
  const added = addedLines(diff).join('\n');
  for (const { re, note } of DANGER_PATTERNS) {
    if (re.test(added)) issues.push({ severity: 'high', note });
  }
  return issues;
}

async function llmReview(diff, env = process.env) {
  if (!env.OPENROUTER_API_KEY) return { ran: false, block: false, issues: [], summary: 'llm review skipped (no key)' };
  const prompt = `You are a strict but fair code reviewer. Review this unified diff for SECURITY vulnerabilities and clear CORRECTNESS bugs only (not style). Respond with ONLY a JSON object: {"block": boolean, "issues": [{"severity":"high|medium|low","note":"..."}], "summary":"one line"}. Set block=true ONLY for high-severity security holes or bugs that will break at runtime. Diff:\n\n${diff.slice(0, MAX_DIFF_CHARS)}`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: REVIEW_MODEL.replace(/^openrouter\//, ''), messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0 })
    });
    const json = await res.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const m = String(content || '').match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    return { ran: true, block: parsed.block === true, issues: Array.isArray(parsed.issues) ? parsed.issues : [], summary: parsed.summary || '' };
  } catch (e) {
    return { ran: false, block: false, issues: [], summary: `llm review error (fail-open): ${e.message}` };
  }
}

async function main() {
  const base = process.env.REVIEW_DIFF_BASE
    || `origin/${(() => { try { return execSync('git rev-parse --abbrev-ref origin/HEAD', { encoding: 'utf8' }).trim().replace(/^origin\//, ''); } catch { return 'main'; } })()}`;
  let diff = '';
  try { diff = execSync(`git diff ${base}...HEAD`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); } catch { diff = ''; }

  const dangerIssues = scanDanger(diff);
  const llm = await llmReview(diff);
  const issues = [...dangerIssues, ...llm.issues];
  const block = dangerIssues.length > 0 || llm.block === true;

  const verdict = {
    ok: !block,
    block,
    scan_issues: dangerIssues,
    llm_ran: llm.ran,
    llm_block: llm.block,
    llm_summary: llm.summary,
    issues
  };
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(block ? 2 : 0);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write('ci-review error (fail-open): ' + e.message + '\n'); process.exit(0); });
}

module.exports = { scanDanger, DANGER_PATTERNS, llmReview };
