const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  opencodeKimiDirectEnabled,
  nemoclawDispatcherExplicitlyEnabled,
  buildDefaultOpenCodeDispatcher,
  OPENCODE_RUNTIME_MODES
} = require('../../src/ralph/autonomous-loop');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-default-'));
}

test('nemoclawDispatcherExplicitlyEnabled reads RALPH_DISPATCHER and RALPH_EXECUTION_DISPATCHER', () => {
  expect(nemoclawDispatcherExplicitlyEnabled({})).toBe(false);
  expect(nemoclawDispatcherExplicitlyEnabled({ RALPH_DISPATCHER: 'nemoclaw' })).toBe(true);
  expect(nemoclawDispatcherExplicitlyEnabled({ RALPH_EXECUTION_DISPATCHER: 'nemoclaw' })).toBe(true);
  expect(nemoclawDispatcherExplicitlyEnabled({ RALPH_DISPATCHER: 'opencode-kimi' })).toBe(false);
});

test('opencodeKimiDirectEnabled still accepts opencode-kimi opt-in (redundant with default)', () => {
  expect(opencodeKimiDirectEnabled({ RALPH_DISPATCHER: 'opencode-kimi' })).toBe(true);
  expect(opencodeKimiDirectEnabled({})).toBe(false);
});

test('OPENCODE_RUNTIME_MODES still includes both the legacy NEMOCLAW and the new OPENCODE_KIMI_DIRECT', () => {
  expect(OPENCODE_RUNTIME_MODES.OPENCODE_KIMI_DIRECT).toBe('opencode-kimi-direct');
  expect(OPENCODE_RUNTIME_MODES.NEMOCLAW).toBe('nemoclaw-mediated');
});
