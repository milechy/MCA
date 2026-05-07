const { test, expect } = require('@playwright/test');

const {
  DEFAULT_ALLOWED_COMMANDS,
  parseList,
  redactToken,
  oneLinePreview,
  commandFromUpdate,
  commandType,
  isAllowedCommand,
  matchesCommandSubstring,
  selectLatestAllowedUpdate,
  safeUpdateSummary
} = require('../../scripts/telegram/poll-update-smoke');

test('poll update smoke helpers parse ids and redact token', () => {
  expect(parseList('1, -1002, nope, 3')).toEqual([1, -1002, 3]);
  expect(redactToken('')).toBe(null);
  expect(redactToken('short')).toBe('<set:redacted>');
  expect(redactToken('1234567890:ABCDEF_session_only_token')).toBe('1234…oken');
});

test('poll update smoke command helpers allow only explicit manual smoke commands', () => {
  expect(DEFAULT_ALLOWED_COMMANDS).toEqual(['/ping', '/status', '/policy', '/run-all']);
  expect(commandFromUpdate({ message: { text: '/run-all APR .ralph/tmp/p.json' } })).toBe('/run-all APR .ralph/tmp/p.json');
  expect(commandType('/run-all APR .ralph/tmp/p.json')).toBe('/run-all');
  expect(isAllowedCommand('/run-all APR .ralph/tmp/p.json')).toBe(true);
  expect(isAllowedCommand('/approve APR-1')).toBe(false);
  expect(isAllowedCommand('/mode fullauto')).toBe(false);
});

test('poll update smoke supports optional command substring matching', () => {
  expect(matchesCommandSubstring('/run-all APR-NEW .ralph/tmp/p.json', null)).toBe(true);
  expect(matchesCommandSubstring('/run-all APR-NEW .ralph/tmp/p.json', 'APR-NEW')).toBe(true);
  expect(matchesCommandSubstring('/run-all APR-OLD .ralph/tmp/p.json', 'APR-NEW')).toBe(false);
});

test('poll update smoke selects latest allowed update without leaking ids in summary', () => {
  const updates = [
    {
      update_id: 1,
      message: { text: '/ping', from: { id: 111 }, chat: { id: 222 } }
    },
    {
      update_id: 2,
      message: { text: '/approve APR-1', from: { id: 3 }, chat: { id: 10 } }
    },
    {
      update_id: 3,
      message: { text: '/run-all APR-OK .ralph/tmp/p.json', from: { id: 3 }, chat: { id: 10 } }
    }
  ];

  const selected = selectLatestAllowedUpdate(updates, {
    allowedUserIds: [3],
    allowedChatIds: [10]
  });

  expect(selected.update_id).toBe(3);
  expect(safeUpdateSummary(selected)).toEqual({
    update_id: 3,
    command_type: '/run-all',
    command_preview: '/run-all APR-OK .ralph/tmp/p.json'
  });
  expect(JSON.stringify(safeUpdateSummary(selected))).not.toContain('"from"');
  expect(JSON.stringify(safeUpdateSummary(selected))).not.toContain('"chat"');
});

test('poll update smoke can select a fresh command by approval id substring instead of an older latest command', () => {
  const updates = [
    { update_id: 9, message: { text: '/run-all APR-FRESH .ralph/tmp/fresh.json', from: { id: 3 }, chat: { id: 10 } } },
    { update_id: 10, message: { text: '/run-all APR-OLD .ralph/tmp/old.json', from: { id: 3 }, chat: { id: 10 } } }
  ];

  const selected = selectLatestAllowedUpdate(updates, {
    allowedUserIds: [3],
    allowedChatIds: [10],
    matchCommandSubstring: 'APR-FRESH'
  });

  expect(selected.update_id).toBe(9);
  expect(safeUpdateSummary(selected)).toMatchObject({
    command_type: '/run-all',
    command_preview: '/run-all APR-FRESH .ralph/tmp/fresh.json'
  });
});

test('poll update smoke returns null when no allowed update exists', () => {
  const updates = [
    { update_id: 1, message: { text: '/ping', from: { id: 999 }, chat: { id: 10 } } },
    { update_id: 2, message: { text: '/deny APR-1', from: { id: 3 }, chat: { id: 10 } } }
  ];

  expect(selectLatestAllowedUpdate(updates, { allowedUserIds: [3], allowedChatIds: [10] })).toBe(null);
});

test('poll update smoke returns null when no command matches the requested substring', () => {
  const updates = [
    { update_id: 1, message: { text: '/run-all APR-OLD .ralph/tmp/old.json', from: { id: 3 }, chat: { id: 10 } } }
  ];

  expect(selectLatestAllowedUpdate(updates, {
    allowedUserIds: [3],
    allowedChatIds: [10],
    matchCommandSubstring: 'APR-FRESH'
  })).toBe(null);
});

test('poll update smoke response previews are bounded one-line strings', () => {
  const preview = oneLinePreview(`hello\n${'x'.repeat(300)}`, 20);
  expect(preview).toBe('hello xxxxxxxxxxxxxx…');
  expect(preview).not.toContain('\n');
});
