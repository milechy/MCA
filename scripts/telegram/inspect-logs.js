#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

function tail(items, count) {
  return items.slice(Math.max(0, items.length - count));
}

function inspectLogs({ rootDir = process.cwd(), count = 5 } = {}) {
  const auditPath = path.join(rootDir, '.ralph', 'logs', 'audit.jsonl');
  const executionPath = path.join(rootDir, '.ralph', 'logs', 'execution.jsonl');
  const audit = readJsonl(auditPath);
  const execution = readJsonl(executionPath);

  return {
    audit: {
      path: '.ralph/logs/audit.jsonl',
      count: audit.length,
      tail: tail(audit, count)
    },
    execution: {
      path: '.ralph/logs/execution.jsonl',
      count: execution.length,
      tail: tail(execution, count)
    },
    shell_completion_events: execution.filter((event) => [
      'shell_execution_completed',
      'approved_shell_execution_completed'
    ].includes(event.event)).map((event) => ({
      timestamp: event.timestamp,
      event: event.event,
      command_hash: event.command_hash,
      approval_id: event.approval_id || null
    }))
  };
}

function main() {
  const countArg = Number(process.argv[2] || 5);
  const result = inspectLogs({ count: Number.isFinite(countArg) && countArg > 0 ? countArg : 5 });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { inspectLogs, readJsonl };
