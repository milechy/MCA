#!/usr/bin/env node

const https = require('node:https');

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

function matchesCommandSubstring(commandText, matchCommandSubstring = null) {
  if (!matchCommandSubstring) return true;
  return String(commandText || '').includes(matchCommandSubstring);
}

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: oneLinePreview(error?.message || String(error), 180),
    code: error?.code || error?.cause?.code || null
  };
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, payload: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`telegram_get_updates_invalid_json:${response.statusCode}`));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('telegram_get_updates_timeout'));
    });
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  if (typeof fetch === 'function') {
    try {
      const response = await fetch(url);
      const payload = await response.json();
      return { status: response.status, payload, transport: 'fetch' };
    } catch (error) {
      const fallback = await httpsJson(url);
      return { ...fallback, transport: 'https', fallback_from: safeError(error) };
    }
  }

  const fallback = await httpsJson(url);
  return { ...fallback, transport: 'https' };
}

async function fetchUpdates({ env = process.env, offset = null, limit = 10, timeout = 0 } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const params = new URLSearchParams({ limit: String(limit), timeout: String(timeout) });
  if (offset !== null && offset !== undefined) params.set('offset', String(offset));

  const url = `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`;
  const { status: httpStatus, payload, transport, fallback_from: fallbackFrom } = await fetchJson(url);
  if (httpStatus < 200 || httpStatus >= 300 || payload.ok !== true) {
    const error = new Error(`telegram_get_updates_failed:${httpStatus}`);
    error.telegram = {
      transport,
      fallback_from: fallbackFrom || null,
      description: oneLinePreview(payload.description || '', 180)
    };
    throw error;
  }
  return { updates: payload.result || [], transport, fallback_from: fallbackFrom || null };
}

function selectLatestAllowedUpdate(updates, {
  allowedUserIds,
  allowedChatIds,
  allowedCommands = DEFAULT_ALLOWED_COMMANDS,
  matchCommandSubstring = null
} = {}) {
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
    if (!matchesCommandSubstring(text, matchCommandSubstring)) continue;

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

async function runPolledUpdateSmoke({
  rootDir = process.cwd(),
  env = process.env,
  offset = null,
  limit = 10,
  timeout = 0,
  matchCommandSubstring = null
} = {}) {
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
  let fetched;
  try {
    fetched = await fetchUpdates({ env, offset, limit, timeout });
  } catch (error) {
    return {
      ok: false,
      reason: 'telegram_get_updates_failed',
      token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
      run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
      error: safeError(error),
      telegram: error.telegram || null,
      results: []
    };
  }

  const update = selectLatestAllowedUpdate(fetched.updates, { allowedUserIds, allowedChatIds, matchCommandSubstring });

  if (!update) {
    return {
      ok: false,
      reason: 'no_allowed_update_found',
      token_redacted: redactToken(env.TELEGRAM_BOT_TOKEN || ''),
      run_all_enabled: env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true',
      update_transport: fetched.transport,
      fetch_fallback_from: fetched.fallback_from || null,
      updates_seen: fetched.updates.length,
      match_command_substring: matchCommandSubstring || null,
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
    update_transport: fetched.transport,
    fetch_fallback_from: fetched.fallback_from || null,
    match_command_substring: matchCommandSubstring || null,
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
  const matchArg = argv.find((arg) => arg.startsWith('--match-command-substring='));

  const result = await runPolledUpdateSmoke({
    rootDir: process.cwd(),
    env: process.env,
    offset: offsetArg ? Number(offsetArg.split('=')[1]) : null,
    limit: limitArg ? Number(limitArg.split('=')[1]) : 10,
    timeout: timeoutArg ? Number(timeoutArg.split('=')[1]) : 0,
    matchCommandSubstring: matchArg ? matchArg.slice('--match-command-substring='.length) : null
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, reason: 'poll_update_smoke_unhandled_error', error: safeError(error) }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ALLOWED_COMMANDS,
  MAX_RESPONSE_PREVIEW_CHARS,
  parseList,
  redactToken,
  oneLinePreview,
  safeError,
  commandFromUpdate,
  commandType,
  isAllowedCommand,
  matchesCommandSubstring,
  fetchJson,
  fetchUpdates,
  selectLatestAllowedUpdate,
  safeUpdateSummary,
  runPolledUpdateSmoke
};
