const { test, expect } = require('@playwright/test');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');

test('parses basic Telegram commands', () => {
  expect(parseTelegramCommand('/ping').type).toBe('ping');
  expect(parseTelegramCommand('/status').type).toBe('status');
  expect(parseTelegramCommand('/policy').type).toBe('policy');
  expect(parseTelegramCommand('/mode approval').type).toBe('mode_approval');
  expect(parseTelegramCommand('/mode fullauto 6')).toMatchObject({ type: 'mode_fullauto_request', args: ['6'] });
  expect(parseTelegramCommand('/confirm MODE-123')).toMatchObject({ type: 'confirm', args: ['MODE-123'] });
});

test('parses read-only Ralph planning and gate manifest commands', () => {
  expect(parseTelegramCommand('/ralph-plan STORY-1 staging approval add tests')).toMatchObject({ type: 'ralph_plan', args: ['STORY-1', 'staging', 'approval', 'add', 'tests'] });
  expect(parseTelegramCommand('/ralph-gate-manifest')).toMatchObject({ type: 'ralph_gate_manifest', args: [] });
});

test('parses read-only approval inspection commands', () => {
  expect(parseTelegramCommand('/approvals')).toMatchObject({ type: 'approvals', args: [] });
  expect(parseTelegramCommand('/approvals pending')).toMatchObject({ type: 'approvals', args: ['pending'] });
  expect(parseTelegramCommand('/approval APR-1')).toMatchObject({ type: 'approval_detail', args: ['APR-1'] });
});

test('parses approval verbs as disconnected command types', () => {
  expect(parseTelegramCommand('/approve APR-1')).toMatchObject({ type: 'approve', args: ['APR-1'] });
  expect(parseTelegramCommand('/deny APR-1')).toMatchObject({ type: 'deny', args: ['APR-1'] });
  expect(parseTelegramCommand('/modify APR-1 change scope')).toMatchObject({ type: 'modify', args: ['APR-1', 'change', 'scope'] });
});

test('parses execution-shaped commands without connecting shell execution', () => {
  expect(parseTelegramCommand('/execute-noop APR-1 .ralph/tmp/plan.json')).toMatchObject({
    type: 'execute_noop',
    args: ['APR-1', '.ralph/tmp/plan.json']
  });
  expect(parseTelegramCommand('/run-all APR-1 .ralph/tmp/plan.json')).toMatchObject({
    type: 'run_all',
    args: ['APR-1', '.ralph/tmp/plan.json']
  });
});
