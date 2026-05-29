const { test, expect } = require('@playwright/test');
const { once } = require('../../src/ralph/utils/once');

test('fn called exactly once across multiple calls', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
    return 'result';
  };

  const wrapped = once(fn);
  wrapped();
  wrapped();
  wrapped();

  expect(callCount).toBe(1);
});

test('cached value returned on subsequent calls', async () => {
  const fn = () => 'cached-result';
  const wrapped = once(fn);

  const result1 = wrapped();
  const result2 = wrapped();
  const result3 = wrapped();

  expect(result1).toBe('cached-result');
  expect(result2).toBe('cached-result');
  expect(result3).toBe('cached-result');
});

test('first-call args used, later args ignored', async () => {
  const fn = (a, b) => a + b;
  const wrapped = once(fn);

  const result1 = wrapped(5, 3);
  const result2 = wrapped(10, 20);
  const result3 = wrapped(100, 200);

  expect(result1).toBe(8);
  expect(result2).toBe(8);
  expect(result3).toBe(8);
});

test('works with functions returning objects', async () => {
  const obj = { key: 'value' };
  const fn = () => obj;
  const wrapped = once(fn);

  const result1 = wrapped();
  const result2 = wrapped();

  expect(result1).toBe(obj);
  expect(result2).toBe(obj);
  expect(result1 === result2).toBe(true);
});

test('works with functions returning undefined', async () => {
  let callCount = 0;
  const fn = () => {
    callCount++;
  };
  const wrapped = once(fn);

  const result1 = wrapped();
  const result2 = wrapped();

  expect(result1).toBeUndefined();
  expect(result2).toBeUndefined();
  expect(callCount).toBe(1);
});
