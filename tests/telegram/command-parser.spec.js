const { test, expect } = require('@playwright/test');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');

test('parses basic Telegram commands', () => {
  expect(parseTelegramCommand('/ping').type).toBe('ping');
  expect(parseTelegramCommand('/status').type).toBe('status');
  expect(parseTelegramCommand('/mode approval').type).toBe('mode_approval');
  expect(parseTelegramCommand('/mode fullauto 6')).toMatchObject({ type: 'mode_fullauto_request', args: ['6'] });
  expect(parseTelegramCommand('/confirm MODE-123')).toMatchObject({ type: 'confirm', args: ['MODE-123'] });
});

test('parses approval commands without connecting execution', () => {
  expect(parseTelegramCommand('/approve APR-1')).toMatchObject({ type: 'approve', args: ['APR-1'] });
  expect(parseTelegramCommand('/deny APR-1')).toMatchObject({ type: 'deny', args: ['APR-1'] });
  expect(parseTelegramCommand('/modify APR-1 change scope')).toMatchObject({ type: 'modify', args: ['APR-1', 'change', 'scope'] });
});
