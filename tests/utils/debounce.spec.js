import { test, expect } from '@playwright/test';
import debounce from '../../src/ralph/utils/debounce.js';

test('basic debounce behavior: function called once after wait time', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return 'result';
  };
  const debounced = debounce(fn, 50);

  debounced();
  expect(callCount).toBe(0);

  await new Promise(resolve => setTimeout(resolve, 75));
  expect(callCount).toBe(1);
});

test('multiple rapid calls result in single execution', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const debounced = debounce(fn, 50);

  debounced();
  debounced();
  debounced();
  expect(callCount).toBe(0);

  await new Promise(resolve => setTimeout(resolve, 75));
  expect(callCount).toBe(1);
});

test('immediate flag executes on first call', () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const debounced = debounce(fn, 50, true);

  debounced();
  expect(callCount).toBe(1);
});

test('immediate flag does not execute trailing call', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const debounced = debounce(fn, 50, true);

  debounced();
  debounced();
  expect(callCount).toBe(1);

  await new Promise(resolve => setTimeout(resolve, 75));
  expect(callCount).toBe(1);
});

test('cancel functionality prevents pending execution', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const debounced = debounce(fn, 50);

  debounced();
  debounced.cancel();

  await new Promise(resolve => setTimeout(resolve, 75));
  expect(callCount).toBe(0);
});

test('edge case: zero wait time defers to next tick', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const debounced = debounce(fn, 0);

  debounced();
  expect(callCount).toBe(0);

  await new Promise(resolve => setTimeout(resolve, 25));
  expect(callCount).toBe(1);
});

test('edge case: null function throws TypeError', () => {
  expect(() => debounce(null, 50)).toThrow('Expected a function');
});

test('uses arguments from the last call', async () => {
  let capturedArg = null;
  const fn = (arg) => {
    capturedArg = arg;
  };
  const debounced = debounce(fn, 50);

  debounced('first');
  debounced('second');
  debounced('third');

  await new Promise(resolve => setTimeout(resolve, 75));
  expect(capturedArg).toBe('third');
});
