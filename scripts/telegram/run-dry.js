#!/usr/bin/env node
const { runPolling } = require('../../src/telegram/runtime');

async function main() {
  const maxIterations = process.env.TELEGRAM_MAX_ITERATIONS
    ? Number(process.env.TELEGRAM_MAX_ITERATIONS)
    : Infinity;

  await runPolling({ maxIterations });
}

main().catch((error) => {
  console.error(`[telegram-runtime] failed: ${error.message}`);
  process.exitCode = 1;
});
