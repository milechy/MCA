const { test, expect } = require('@playwright/test');
const { sleep } = require('../../src/ralph/utils/sleep');

test('sleep resolves after the specified delay', async () => {
  const start = Date.now();
  await sleep(100);
  const elapsed = Date.now() - start;
  
  // Allow some tolerance for timing variations
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(200);
});

test('sleep(0) resolves on the next tick', async () => {
  const start = Date.now();
  await sleep(0);
  const elapsed = Date.now() - start;
  
  // Should resolve almost immediately (within a few ms)
  expect(elapsed).toBeLessThan(50);
});

test('negative input is treated as 0', async () => {
  const start = Date.now();
  await sleep(-100);
  const elapsed = Date.now() - start;
  
  // Should resolve almost immediately
  expect(elapsed).toBeLessThan(50);
});

test('NaN input is treated as 0', async () => {
  const start = Date.now();
  await sleep(NaN);
  const elapsed = Date.now() - start;
  
  // Should resolve almost immediately
  expect(elapsed).toBeLessThan(50);
});

test('non-number input is treated as 0', async () => {
  const start = Date.now();
  await sleep('not a number');
  const elapsed = Date.now() - start;
  
  // Should resolve almost immediately
  expect(elapsed).toBeLessThan(50);
});

test('sleep returns a Promise', async () => {
  const result = sleep(10);
  expect(result).toBeInstanceOf(Promise);
  await result;
});
