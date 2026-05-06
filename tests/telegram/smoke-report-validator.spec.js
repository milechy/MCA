const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanReportText, validateSmokeReportFile } = require('../../scripts/telegram/validate-smoke-report');

function safeReport() {
  return `Phase 6 real read-only Telegram smoke report:

Pre-smoke:
- preflight-no-secrets: pass
- telegram:dry-transport-smoke: pass
- test:telegram: pass
- local gates: pass
- working tree clean before smoke: yes
- real-transport-guard: pass
- run_all_enabled before smoke: false

Real read-only smoke:
- overall: pass
- /ping response_kind: pong
- /status response_kind: status
- /policy response_kind: policy
- output_contract.no_raw_update: true
- output_contract.no_raw_response_payload: true
- output_contract.no_private_ids: true
- response_preview_max_chars: 160
- dry_run_telegram_send: false

Post-smoke:
- shell completion events from read-only commands: none
- execution log unexpected writes: none
- audit log compact events: present
- working tree clean after smoke: yes
- git diff contains token or Telegram IDs: no
- git diff --cached contains token or Telegram IDs: no
- secrets committed: no

Cleanup:
- run-all gate unset: yes
- bot token unset: yes
- allowed user ids unset: yes
- allowed chat ids unset: yes

Decision:
- decision: pass-readonly-smoke
`;
}

function makeTempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-smoke-report-validator-'));
  const filePath = path.join(dir, 'report.txt');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('scanReportText accepts the safe report shape', () => {
  expect(scanReportText(safeReport())).toEqual({ ok: true, findings: [] });
});

test('scanReportText rejects secret env keys, token-like values, and raw payload fields', () => {
  const tokenLike = ['1234567890', 'ABCDEF', 'session', 'only', 'token'].join('_').replace('_ABCDEF_', ':ABCDEF_');
  const result = scanReportText(`${safeReport()}
TELEGRAM_BOT_TOKEN=${tokenLike}
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
{"update_id":1,"message":{"from":{"id":123456789},"chat":{"id":-1001234567890}}}
{"response_text":"pong"}
{"event":"telegram_command","command_type":"ping"}
https://api.telegram.org/bot${tokenLike}/sendMessage
`);

  expect(result.ok).toBe(false);
  expect(result.findings.map((finding) => finding.rule_id)).toEqual(expect.arrayContaining([
    'telegram_bot_token_env_key',
    'telegram_allowed_user_ids_env_key',
    'telegram_allowed_chat_ids_env_key',
    'telegram_bot_token_like_value',
    'raw_update_payload',
    'raw_message_payload',
    'raw_from_payload',
    'raw_chat_payload',
    'raw_response_text_field',
    'full_audit_log_event',
    'private_bot_url'
  ]));
});

test('scanReportText requires the safe report shape by default', () => {
  const result = scanReportText('overall: pass');

  expect(result.ok).toBe(false);
  expect(result.findings).toContainEqual({
    line: null,
    rule_id: 'missing_safe_report_field',
    detail: 'Phase 6 real read-only Telegram smoke report:'
  });
});

test('validateSmokeReportFile validates a safe report file', () => {
  const filePath = makeTempFile(safeReport());
  expect(validateSmokeReportFile(filePath)).toEqual({ ok: true, findings: [] });
});

test('validator CLI exits non-zero for unsafe report and zero for safe report', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'telegram', 'validate-smoke-report.js');
  const safePath = makeTempFile(safeReport());
  const unsafePath = makeTempFile(`${safeReport()}\n{"chat_id":-1001234567890}\n`);

  const safeRun = spawnSync(process.execPath, [scriptPath, safePath], { encoding: 'utf8' });
  expect(safeRun.status).toBe(0);
  expect(JSON.parse(safeRun.stdout)).toEqual({ ok: true, findings: [] });

  const unsafeRun = spawnSync(process.execPath, [scriptPath, unsafePath], { encoding: 'utf8' });
  expect(unsafeRun.status).toBe(1);
  const parsed = JSON.parse(unsafeRun.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.findings.map((finding) => finding.rule_id)).toContain('raw_chat_id_field');
});
