#!/usr/bin/env node

const fs = require('node:fs');

const FORBIDDEN_PATTERNS = Object.freeze([
  { id: 'telegram_bot_token_env_key', pattern: /TELEGRAM_BOT_TOKEN/ },
  { id: 'telegram_allowed_user_ids_env_key', pattern: /TELEGRAM_ALLOWED_USER_IDS/ },
  { id: 'telegram_allowed_chat_ids_env_key', pattern: /TELEGRAM_ALLOWED_CHAT_IDS/ },
  { id: 'telegram_bot_token_like_value', pattern: /\b\d{8,}:[A-Za-z0-9_-]{12,}\b/ },
  { id: 'raw_update_payload', pattern: /"update_id"\s*:/ },
  { id: 'raw_message_payload', pattern: /"message"\s*:\s*\{/ },
  { id: 'raw_from_payload', pattern: /"from"\s*:\s*\{/ },
  { id: 'raw_chat_payload', pattern: /"chat"\s*:\s*\{/ },
  { id: 'raw_user_id_field', pattern: /"user_id"\s*:\s*-?\d+/ },
  { id: 'raw_chat_id_field', pattern: /"chat_id"\s*:\s*-?\d+/ },
  { id: 'raw_response_text_field', pattern: /"response_text"\s*:/ },
  { id: 'full_audit_log_event', pattern: /"event"\s*:\s*"telegram_command"/ },
  { id: 'full_execution_log_event', pattern: /"event"\s*:\s*"(?:shell_execution_completed|approved_shell_execution_completed|shell_execution_failed)"/ },
  { id: 'private_bot_url', pattern: /https:\/\/api\.telegram\.org\/bot[0-9A-Za-z:_-]+/ }
]);

const REQUIRED_SAFE_FIELDS = Object.freeze([
  'Phase 6 real read-only Telegram smoke report:',
  'Pre-smoke:',
  'Real read-only smoke:',
  'Post-smoke:',
  'Cleanup:',
  'Decision:',
  'output_contract.no_raw_update:',
  'output_contract.no_raw_response_payload:',
  'output_contract.no_private_ids:',
  'shell completion events from read-only commands:',
  'working tree clean after smoke:',
  'secrets committed:'
]);

function scanReportText(text, { requireSafeShape = true } = {}) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(line)) {
        findings.push({ line: index + 1, rule_id: rule.id });
      }
    }
  });

  if (requireSafeShape) {
    for (const field of REQUIRED_SAFE_FIELDS) {
      if (!String(text || '').includes(field)) {
        findings.push({ line: null, rule_id: 'missing_safe_report_field', detail: field });
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings
  };
}

function validateSmokeReportFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  return scanReportText(text, options);
}

function main(argv = process.argv.slice(2)) {
  const filePath = argv[0];
  if (!filePath) {
    console.error('Usage: node scripts/telegram/validate-smoke-report.js <report-file>');
    process.exitCode = 2;
    return;
  }

  const result = validateSmokeReportFile(filePath, { requireSafeShape: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  FORBIDDEN_PATTERNS,
  REQUIRED_SAFE_FIELDS,
  scanReportText,
  validateSmokeReportFile
};
