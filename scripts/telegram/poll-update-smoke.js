#!/usr/bin/env node

const { handleUpdate } = require('../../src/telegram/runtime');
const { status } = require('./check-env');
const { preflightNoSecrets } = require('./preflight-no-secrets');

const DEFAULT_ALLOWED_COMMANDS = Object.freeze(['/ping', '/status', '/policy', '/run-all']);
const MAX_RESPONSE_PREVIEW_CHARS = 240;

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
}

function redactToken(value) {
  if (!value) return null;
  if (value.length <= 8) return '<set:redacted>';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function oneLinePreview(value, maxChars = MAX_RESPONSE_PREVIEW_CHARS) {
  if (!value) return null;
  const oneLine = String(value).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

function commandFromUpdate(update) {
  return update?.message?.text || update?.edited_message?.text || '';
}

function commandType(commandText) {
  const [verb] = String(commandText || '').trim().split(/\s+/);
  return verb || '';
}

function isAllowedCommand(commandText, allowedCommands = DEFAULT_ALLOWED_COMMANDS) {
  return allowedCommands.includes(commandType(commandText));
}

async function fetchUpdates({ env = process.env, offset = null, limit = 10, timeout = 0 } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const params = new URLSearchParams({ limit: String(limit), timeout: String(timeout) });
  if (offset !== null && offset !== undefined) params.set('offset', String(offset));

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(`telegram_get_updates_failed:${response.status}`);
  }
  return payload.result || [];
}

function selectLatestAllowedUpdate(updates, { allowedUserIds, allowedChatIds, allowedCommands = DEFAULT_ALLOWED_COMMANDS } = {}) {
  const sorted = [...updates].sort((a, b) => (b.update_id || 0) - (a.update_id || 0));
  for (const update of sorted) {
    const message = update.message || update.edited_message;
    if (!message) continue;
    const userId = message.from?.id;
    const chatId = message.chat?.id;
    const text = message.text || '';

    if (!allowedUserIds.includes(userId)) continue;
    if (!allowedChatIds.includes(chatId)) continue;
    if (!isAllowedCommand(text, allowedCommands)) continue;

    return update;
  }
  return null;
}

function safeUpdateSummary(update) {
  if (!update) return null;
  const text = commandFromUpdate(update);
  return {
    update_id: update.update_id,
    command_type: commandType(text),
    command_preview: oneLinePreview(text, 120)
  };
}

async function runPolledUpdateSmoke({ rootDir = process.cwd(), env = process.env, offset = null, limit = 10, timeout = 0 } = {}) {
  const envStatus = status(env);
  const secretPreflight = preflightNoSecrets({ rootDir, includeGitDiff: true });

  if (!envStatus.ok) {
    return {
      ok: false,
      reason: 'telegram_env_invalid',
      token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
      run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
      results: []
    };
  }

  if (!secretPreflight.ok) {
    return {
      ok: false,
      reason: 'repo_secret_preflight_failed',
      token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
      run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
      findings_count: secretPreflight.findings.length,
      results: []
    };
  }

  const allowedUserIds = parseList(env.TELEGRAM_ALLOWED_USER_IDS);
  const allowedChatIds = parseList(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const updates = await fetchUpdates({ env, offset, limit, timeout });
  const update = selectLatestAllowedUpdate(updates, { allowedUserIds, allowedChatIds });

  if (!update) {
    return {
      ok: false,
      reason: 'no_allowed_update_found',
      token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
      run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
      updates_seen: updates.length,
      results: []
    };
  }

  const config = {
    dry_run: false,
    bot_token: env.TELEGRAM_BOT_TOKEN,
    allowed_user_ids: allowedUserIds,
    allowed_chat_ids: allowedChatIds
  };

  const roles = {
    owner_user_ids: [],
    admin_user_ids: [],
    reviewer_user_ids: allowedUserIds,
    observer_user_ids: []
  };

  const response = await handleUpdate(update, { rootDir, config, roles, env });

  return {
    ok: response.ok === true,
    reason: response.reason || null,
    token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
    run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
    update: safeUpdateSummary(update),
    result: {
      ok: response.ok,
      reason: response.reason || null,
      response_preview: oneLinePreview(response.response_text || null),
      response_length: response.response_text ? response.response_text.length : 0
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const offsetArg = argv.find((arg) => arg.startsWith('--offset='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const timeoutArg = argv.find((arg) => arg.startsWith('--timeout='));

  const result = await runPolledUpdateSmoke({
    rootDir: process.cwd(),
    env: process.env,
    offset: offsetArg ? Number(offsetArg.split('=')[1]) : null,
    limit: limitArg ? Number(limitArg.split('=')[1]) : 10,
    timeout: timeoutArg ? Number(timeoutArg.split('=')[1]) : 0
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ALLOWED_COMMANDS,
  MAX_RESPONSE_PREVIEW_CHARS,
  parseList,
  redactToken,
  oneLinePreview,
  commandFromUpdate,
  commandType,
  isAllowedCommand,
  selectLatestAllowedUpdate,
  safeUpdateSummary,
  runPolledUpdateSmoke
};
