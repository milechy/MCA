const fs = require('node:fs');
const path = require('node:path');

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendAuditEvent(event, options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), '.ralph', 'logs', 'audit.jsonl');
  ensureDirectory(filePath);

  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };

  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

module.exports = {
  appendAuditEvent
};
