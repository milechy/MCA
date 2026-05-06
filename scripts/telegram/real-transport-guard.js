#!/usr/bin/env node

const { status } = require('./check-env');
const { preflightNoSecrets } = require('./preflight-no-secrets');

const READ_ONLY_COMMANDS = Object.freeze(['/ping', '/status', '/policy']);

function realTransportGuard({ env = process.env, rootDir = process.cwd(), includeGitDiff = true } = {}) {
  const envStatus = status(env);
  const secretPreflight = preflightNoSecrets({ rootDir, includeGitDiff });
  const findings = [];

  if (!envStatus.ok) {
    findings.push({
      rule_id: 'telegram_transport_env_missing',
      detail: 'TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, and TELEGRAM_ALLOWED_CHAT_IDS must be set in the active shell session.'
    });
  }

  if (env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true') {
    findings.push({
      rule_id: 'real_run_all_gate_must_be_off_for_transport_smoke',
      detail: 'Unset RALPH_TELEGRAM_RUN_ALL_ENABLED before real Bot API read-only transport smoke.'
    });
  }

  for (const finding of secretPreflight.findings) {
    findings.push({
      rule_id: 'repo_or_diff_secret_preflight_failed',
      detail: `${finding.source}:${finding.line}:${finding.rule_id}`
    });
  }

  return {
    ok: findings.length === 0,
    stage: 'real_transport_read_only_guard',
    allowed_commands: READ_ONLY_COMMANDS,
    forbidden_commands: ['/run-all', '/approve', '/deny', '/modify', '/mode fullauto', '/confirm'],
    run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
    telegram_env_ok: envStatus.ok,
    token_redacted: envStatus.transport.find((entry) => entry.name === 'TELEGRAM_BOT_TOKEN')?.value || null,
    repo_secret_preflight_ok: secretPreflight.ok,
    findings
  };
}

function main() {
  const result = realTransportGuard({ env: process.env, rootDir: process.cwd(), includeGitDiff: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  READ_ONLY_COMMANDS,
  realTransportGuard
};
