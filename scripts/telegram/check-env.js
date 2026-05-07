#!/usr/bin/env node

const REQUIRED_TRANSPORT_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'TELEGRAM_ALLOWED_CHAT_IDS'
];

const RUN_ALL_ENV = 'RALPH_TELEGRAM_RUN_ALL_ENABLED';

const PLACEHOLDER_VALUES = new Set([
  '<private bot token>',
  '<your telegram user id>',
  '<target chat id>',
  '<authorized user ids>',
  '<authorized chat ids>',
  '<private value, never commit>'
]);

function redact(value) {
  if (!value) return null;
  if (value.length <= 8) return '<set:redacted>';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function present(name, env = process.env) {
  return typeof env[name] === 'string' && env[name].length > 0;
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_VALUES.has(value.trim());
}

function hasNumericCsv(value) {
  return typeof value === 'string' && value.split(',').every((entry) => /^-?\d+$/.test(entry.trim()));
}

function entryStatus(name, env = process.env) {
  const value = env[name] || '';
  const entry = {
    name,
    present: present(name, env),
    placeholder: isPlaceholder(value),
    value: name === 'TELEGRAM_BOT_TOKEN' ? redact(value) : (value || null)
  };

  if (name === 'TELEGRAM_ALLOWED_USER_IDS' || name === 'TELEGRAM_ALLOWED_CHAT_IDS') {
    entry.valid_format = entry.present && !entry.placeholder && hasNumericCsv(value);
  } else if (name === 'TELEGRAM_BOT_TOKEN') {
    entry.valid_format = entry.present && !entry.placeholder && /^\d{8,}:[A-Za-z0-9_-]{12,}$/.test(value);
  }

  return entry;
}

function status(env = process.env) {
  const transport = REQUIRED_TRANSPORT_ENV.map((name) => entryStatus(name, env));

  const runAllValue = env[RUN_ALL_ENV] || '';
  return {
    ok: transport.every((entry) => entry.present && entry.placeholder === false && entry.valid_format === true),
    transport,
    run_all: {
      env: RUN_ALL_ENV,
      value: runAllValue || null,
      enabled: runAllValue === 'true',
      default_off: runAllValue !== 'true',
      required_value: 'true'
    }
  };
}

function main() {
  const result = status(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { REQUIRED_TRANSPORT_ENV, RUN_ALL_ENV, PLACEHOLDER_VALUES, redact, present, isPlaceholder, hasNumericCsv, status };
