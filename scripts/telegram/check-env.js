#!/usr/bin/env node

const REQUIRED_TRANSPORT_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'TELEGRAM_ALLOWED_CHAT_IDS'
];

const RUN_ALL_ENV = 'RALPH_TELEGRAM_RUN_ALL_ENABLED';

function redact(value) {
  if (!value) return null;
  if (value.length <= 8) return '<set:redacted>';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function present(name, env = process.env) {
  return typeof env[name] === 'string' && env[name].length > 0;
}

function status(env = process.env) {
  const transport = REQUIRED_TRANSPORT_ENV.map((name) => ({
    name,
    present: present(name, env),
    value: name === 'TELEGRAM_BOT_TOKEN' ? redact(env[name]) : (env[name] || null)
  }));

  const runAllValue = env[RUN_ALL_ENV] || '';
  return {
    ok: transport.every((entry) => entry.present),
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

module.exports = { REQUIRED_TRANSPORT_ENV, RUN_ALL_ENV, redact, status };
