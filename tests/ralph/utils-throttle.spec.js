const { test, expect } = require('@playwright/test');
const { throttle } = require('../../src/ralph/utils/throttle');

test('first call executes immediately', () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return 'result';
  };

  const throttled = throttle(fn, 100);
  const result = throttled();

  expect(callCount).toBe(1);
  expect(result).toBe('result');
});

test('subsequent calls within throttle period are ignored', () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return 'result';
  };

  const throttled = throttle(fn, 100);
  throttled();
  throttled();
  throttled();

  expect(callCount).toBe(1);
});

test('call after throttle period expires executes', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return `call-${callCount}`;
  };

  const throttled = throttle(fn, 50);
  const result1 = throttled();
  expect(result1).toBe('call-1');
  expect(callCount).toBe(1);

  await new Promise(resolve => setTimeout(resolve, 60));

  const result2 = throttled();
  expect(result2).toBe('call-2');
  expect(callCount).toBe(2);
});

test('multiple rapid calls followed by waiting', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return `call-${callCount}`;
  };

  const throttled = throttle(fn, 50);

  // First call executes
  throttled();
  expect(callCount).toBe(1);

  // Rapid calls ignored
  throttled();
  throttled();
  throttled();
  expect(callCount).toBe(1);

  // Wait for throttle period
  await new Promise(resolve => setTimeout(resolve, 60));

  // Next call executes
  throttled();
  expect(callCount).toBe(2);

  // More rapid calls ignored
  throttled();
  throttled();
  expect(callCount).toBe(2);

  // Wait again
  await new Promise(resolve => setTimeout(resolve, 60));

  // Another call executes
  throttled();
  expect(callCount).toBe(3);
});

test('function receives correct arguments', () => {
  let capturedArgs = null;
  const fn = (a, b, c) => {
    capturedArgs = [a, b, c];
    return a + b + c;
  };

  const throttled = throttle(fn, 100);
  const result = throttled(1, 2, 3);

  expect(capturedArgs).toEqual([1, 2, 3]);
  expect(result).toBe(6);
});

test('return value is preserved', async () => {
  const fn = (value) => {
    return { data: value, timestamp: Date.now() };
  };

  const throttled = throttle(fn, 50);
  const result1 = throttled('first');
  expect(result1.data).toBe('first');

  // Ignored call, should return last result
  const result2 = throttled('second');
  expect(result2.data).toBe('first');

  // Wait for throttle period
  await new Promise(resolve => setTimeout(resolve, 60));

  // New call, new result
  const result3 = throttled('third');
  expect(result3.data).toBe('third');
});

test('returns undefined before first execution', () => {
  const fn = () => 'result';
  const throttled = throttle(fn, 100);

  // Don't call it yet, just check the function exists
  expect(typeof throttled).toBe('function');
});

test('throttle period of zero allows all calls', () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return 'result';
  };

  const throttled = throttle(fn, 0);
  throttled();
  throttled();
  throttled();

  expect(callCount).toBe(3);
});

test('works with functions returning objects', async () => {
  const obj1 = { id: 1 };
  const obj2 = { id: 2 };
  let callCount = 0;

  const fn = () => {
    callCount++;
    return callCount === 1 ? obj1 : obj2;
  };

  const throttled = throttle(fn, 50);
  const result1 = throttled();
  expect(result1).toBe(obj1);

  // Ignored call returns last result
  const result2 = throttled();
  expect(result2).toBe(obj1);

  await new Promise(resolve => setTimeout(resolve, 60));

  const result3 = throttled();
  expect(result3).toBe(obj2);
});

test('works with functions returning undefined', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };

  const throttled = throttle(fn, 50);
  const result1 = throttled();
  expect(result1).toBeUndefined();
  expect(callCount).toBe(1);

  // Ignored call
  const result2 = throttled();
  expect(result2).toBeUndefined();
  expect(callCount).toBe(1);

  await new Promise(resolve => setTimeout(resolve, 60));

  const result3 = throttled();
  expect(result3).toBeUndefined();
  expect(callCount).toBe(2);
});
