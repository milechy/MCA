const { test, expect } = require('@playwright/test');

const { classifyPrompt } = require('../../src/ralph/complexity-classifier');

// A fake spawnSync that returns a canned classifier line.
function fakeSpawn(signal, { status = 0 } = {}) {
  return () => ({ status, stdout: JSON.stringify(signal) + '\n', stderr: '' });
}

test('classifyPrompt parses the classifier JSON signal', () => {
  const sig = classifyPrompt({
    prompt: 'Implement a Queue class with tests',
    spawnImpl: fakeSpawn({ ok: true, task_type: 'Code Generation', prompt_complexity_score: 0.42 })
  });
  expect(sig.task_type).toBe('Code Generation');
  expect(sig.prompt_complexity_score).toBe(0.42);
});

test('classifyPrompt returns null on non-zero exit (brain falls back to static)', () => {
  const sig = classifyPrompt({
    prompt: 'anything',
    spawnImpl: fakeSpawn({ ok: true }, { status: 1 })
  });
  expect(sig).toBe(null);
});

test('classifyPrompt returns null for empty prompt', () => {
  expect(classifyPrompt({ prompt: '' })).toBe(null);
  expect(classifyPrompt({ prompt: null })).toBe(null);
});

test('classifyPrompt honors NEMOCLAW_CLASSIFIER=off (skip without spawning)', () => {
  let spawned = false;
  const sig = classifyPrompt({
    prompt: 'x',
    env: { NEMOCLAW_CLASSIFIER: 'off' },
    spawnImpl: () => { spawned = true; return { status: 0, stdout: '{}' }; }
  });
  expect(sig).toBe(null);
  expect(spawned).toBe(false);
});

test('classifyPrompt returns null when the classifier emits no ok flag', () => {
  const sig = classifyPrompt({
    prompt: 'x',
    spawnImpl: fakeSpawn({ task_type: 'Other' }) // no ok:true
  });
  expect(sig).toBe(null);
});

test('classifyPrompt uses the persistent server when NEMOCLAW_CLASSIFIER_URL is set', () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push(cmd);
    return { status: 0, stdout: JSON.stringify({ ok: true, task_type: 'Code Generation', prompt_complexity_score: 0.5, backend: 'nvidia' }) };
  };
  const sig = classifyPrompt({
    prompt: 'Implement X',
    env: { NEMOCLAW_CLASSIFIER_URL: 'http://127.0.0.1:8077' },
    spawnImpl
  });
  expect(sig.task_type).toBe('Code Generation');
  expect(calls[0]).toBe('curl'); // hit the server, not python
});

test('classifyPrompt falls back to the subprocess when the server is unreachable', () => {
  const cmds = [];
  const spawnImpl = (cmd) => {
    cmds.push(cmd);
    if (cmd === 'curl') return { status: 7, stdout: '' }; // curl connection refused
    return { status: 0, stdout: JSON.stringify({ ok: true, task_type: 'Rewrite', prompt_complexity_score: 0.1 }) };
  };
  const sig = classifyPrompt({
    prompt: 'x',
    env: { NEMOCLAW_CLASSIFIER_URL: 'http://127.0.0.1:8077' },
    spawnImpl
  });
  expect(cmds).toContain('curl');
  expect(cmds.some((c) => c.includes('python'))).toBe(true);
  expect(sig.task_type).toBe('Rewrite');
});

test('classifyPrompt tolerates leaked warnings before the JSON line', () => {
  const sig = classifyPrompt({
    prompt: 'x',
    spawnImpl: () => ({
      status: 0,
      stdout: 'Warning: unauthenticated HF request\n' +
        JSON.stringify({ ok: true, task_type: 'Rewrite', prompt_complexity_score: 0.1 }) + '\n'
    })
  });
  expect(sig.task_type).toBe('Rewrite');
});
