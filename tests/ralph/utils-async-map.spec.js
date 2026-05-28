import { test, expect } from '@playwright/test';
import { asyncMap } from '../../src/ralph/utils/async-map.js';

test('asyncMap: happy path — processes all items and maintains order', async () => {
  const input = [1, 2, 3, 4, 5];
  const results = await asyncMap(input, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return item * 2;
  });

  expect(results).toEqual([2, 4, 6, 8, 10]);
});

test('asyncMap: respects concurrency limit', async () => {
  const concurrencyLog = [];
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const input = Array.from({ length: 10 }, (_, i) => i);
  const results = await asyncMap(
    input,
    async (item) => {
      currentConcurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      concurrencyLog.push({ item, action: 'start', concurrent: currentConcurrent });

      await new Promise((resolve) => setTimeout(resolve, 20));

      currentConcurrent -= 1;
      concurrencyLog.push({ item, action: 'end', concurrent: currentConcurrent });
      return item * 2;
    },
    3
  );

  expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  expect(maxConcurrent).toBeLessThanOrEqual(3);
});

test('asyncMap: handles empty array', async () => {
  const results = await asyncMap([], async (item) => item * 2);
  expect(results).toEqual([]);
});

test('asyncMap: propagates errors from async function', async () => {
  const input = [1, 2, 3];
  const error = new Error('test error');

  await expect(
    asyncMap(input, async (item) => {
      if (item === 2) {
        throw error;
      }
      return item * 2;
    })
  ).rejects.toThrow('test error');
});

test('asyncMap: throws on invalid arguments', async () => {
  await expect(asyncMap(null, async () => {})).rejects.toThrow('First argument must be an array');
  await expect(asyncMap([], 'not a function')).rejects.toThrow('Second argument must be a function');
  await expect(asyncMap([], async () => {}, 0)).rejects.toThrow('Concurrency must be a positive number');
});
