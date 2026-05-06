#!/usr/bin/env node
const { runPolling } = require('../../src/telegram/runtime');

async function main() {
  const maxIterations = process.env.TELEGRAM_MAX_ITERATIONS
    ? Number(process.env.TELEGRAM_MAX_ITERATIONS)
    : Infinity;

  await runPolling({ maxIterations });
}

main().catch((error) => {
  console.error('[telegram-runtime] failed');
  if (error && error.stack) {
    console.error(error.stack);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
