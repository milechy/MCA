import { test, expect } from '@playwright/test';
import { retryWithBackoff } from '../../src/ralph/utils/retry-with-backoff.js';

test('happy path: function succeeds on first attempt', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    return 'success';
  };

  const result = await retryWithBackoff(fn);
  expect(result).toBe('success');
  expect(callCount).toBe(1);
});

test('retries with exponential backoff and succeeds on second attempt', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount < 2) {
      throw new Error('fail');
    }
    return 'success';
  };

  const startTime = Date.now();
  const result = await retryWithBackoff(fn, { attempts: 3, baseDelayMs: 50 });
  const elapsed = Date.now() - startTime;

  expect(result).toBe('success');
  expect(callCount).toBe(2);
  // First retry delay should be 50ms * 2^0 = 50ms
  expect(elapsed).toBeGreaterThanOrEqual(40);
});

test('exhausts attempts and rejects with last error', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw new Error('persistent failure');
  };

  await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 10 })).rejects.toThrow(
    'persistent failure'
  );
  expect(callCount).toBe(3);
});

test('edge case: attempts=1 means no retries', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw new Error('fail');
  };

  await expect(retryWithBackoff(fn, { attempts: 1, baseDelayMs: 50 })).rejects.toThrow('fail');
  expect(callCount).toBe(1);
});

test('edge case: baseDelayMs=0 means no delay between retries', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount < 3) {
      throw new Error('fail');
    }
    return 'success';
  };

  const startTime = Date.now();
  const result = await retryWithBackoff(fn, { attempts: 3, baseDelayMs: 0 });
  const elapsed = Date.now() - startTime;

  expect(result).toBe('success');
  expect(callCount).toBe(3);
  // With baseDelayMs=0, should complete very quickly (no delays)
  expect(elapsed).toBeLessThan(100);
});

test('throws on invalid attempts (non-integer)', async () => {
  const fn = async () => 'success';

  await expect(retryWithBackoff(fn, { attempts: 2.5, baseDelayMs: 50 })).rejects.toThrow(
    'attempts must be a positive integer'
  );
});

test('throws on invalid attempts (zero or negative)', async () => {
  const fn = async () => 'success';

  await expect(retryWithBackoff(fn, { attempts: 0, baseDelayMs: 50 })).rejects.toThrow(
    'attempts must be a positive integer'
  );
});

test('throws on invalid baseDelayMs (negative)', async () => {
  const fn = async () => 'success';

  await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: -10 })).rejects.toThrow(
    'baseDelayMs must be a non-negative integer'
  );
});

test('throws on invalid baseDelayMs (non-integer)', async () => {
  const fn = async () => 'success';

  await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 50.5 })).rejects.toThrow(
    'baseDelayMs must be a non-negative integer'
  );
});

test('uses default options when not provided', async () => {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount < 2) {
      throw new Error('fail');
    }
    return 'success';
  };

  const result = await retryWithBackoff(fn);
  expect(result).toBe('success');
  expect(callCount).toBe(2);
});

test('exponential backoff calculation: delay increases exponentially', async () => {
  let callCount = 0;
  const delays = [];
  let lastTime = Date.now();

  const fn = async () => {
    callCount++;
    const now = Date.now();
    if (callCount > 1) {
      delays.push(now - lastTime);
    }
    lastTime = now;
    if (callCount < 3) {
      throw new Error('fail');
    }
    return 'success';
  };

  await retryWithBackoff(fn, { attempts: 3, baseDelayMs: 20 });

  // First retry delay: 20 * 2^0 = 20ms
  // Second retry delay: 20 * 2^1 = 40ms
  expect(delays[0]).toBeGreaterThanOrEqual(15);
  expect(delays[1]).toBeGreaterThanOrEqual(35);
});
