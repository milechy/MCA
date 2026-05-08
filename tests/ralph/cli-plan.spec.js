const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handlePlanCommand } = require('../../src/ralph/cli');

function tmpStory(value) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-plan-'));
  const storyPath = path.join(rootDir, 'story.json');
  fs.writeFileSync(storyPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return storyPath;
}

function captureConsole(fn) {
  const original = console.log;
  const oldExitCode = process.exitCode;
  const lines = [];
  console.log = (value) => lines.push(String(value));
  process.exitCode = undefined;
  try {
    const result = fn();
    return { result, lines, exitCode: process.exitCode };
  } finally {
    console.log = original;
    process.exitCode = oldExitCode;
  }
}

test('handlePlanCommand emits non-executing planning graph from story json', () => {
  const storyPath = tmpStory({ story_id: 'STORY-PLAN-1', title: 'Add test', objective: 'Add one test', requested_paths: ['tests/foo.spec.js'], mode: 'approval' });
  const { result, lines } = captureConsole(() => handlePlanCommand([storyPath]));
  expect(result).toMatchObject({
    ok: true,
    stage: 'langgraph_planning_layer',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
  expect(result.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.parse(lines[0]).stage).toBe('langgraph_planning_layer');
});

test('handlePlanCommand blocks missing story path', () => {
  const { result, exitCode } = captureConsole(() => handlePlanCommand([]));
  expect(result).toMatchObject({ ok: false, stage: 'langgraph_planning_layer_cli', reason: 'story_path_required', execution_connected: false, commands_executed: [] });
  expect(exitCode).toBe(1);
});
