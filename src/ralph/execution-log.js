const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function executionLogPath(rootDir = process.cwd()) {
  return path.join(rootDir, '.ralph', 'logs', 'execution.jsonl');
}

function appendExecutionLog(event, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const filePath = options.filePath || executionLogPath(rootDir);
  ensureDir(path.dirname(filePath));
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

module.exports = {
  executionLogPath,
  appendExecutionLog
};
