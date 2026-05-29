import { test, expect } from '@playwright/test';
import { run } from '../../../src/ralph/utils/pool.js';
import { Queue } from '../../../src/ralph/utils/queue.js';

test('pool: returns results in enqueue order', async () => {
  const queue = new Queue();

  queue.enqueue(async () => 'value-A');
  queue.enqueue(async () => 'value-B');
  queue.enqueue(async () => 'value-C');

  const poolResults = await run(queue, 1);

  expect(poolResults).toHaveLength(3);
  expect(poolResults[0]).toEqual({ ok: true, value: 'value-A', durationMs: expect.any(Number) });
  expect(poolResults[1]).toEqual({ ok: true, value: 'value-B', durationMs: expect.any(Number) });
  expect(poolResults[2]).toEqual({ ok: true, value: 'value-C', durationMs: expect.any(Number) });
});

test('pool: respects concurrency limit', async () => {
  const queue = new Queue();
  let concurrent = 0;
  let maxConcurrent = 0;

  const createTask = () => async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(resolve => setTimeout(resolve, 10));
    concurrent--;
    return 'done';
  };

  for (let i = 0; i < 10; i++) {
    queue.enqueue(createTask());
  }

  const poolResults = await run(queue, 3);

  expect(poolResults).toHaveLength(10);
  expect(maxConcurrent).toBeLessThanOrEqual(3);
  expect(poolResults.every(r => r.ok === true)).toBe(true);
});

test('pool: collects errors without aborting', async () => {
  const queue = new Queue();

  queue.enqueue(async () => 'success-1');
  queue.enqueue(async () => {
    throw new Error('task-error');
  });
  queue.enqueue(async () => 'success-2');
  queue.enqueue(async () => {
    throw new Error('another-error');
  });
  queue.enqueue(async () => 'success-3');

  const poolResults = await run(queue, 2);

  expect(poolResults).toHaveLength(5);
  expect(poolResults[0]).toEqual({ ok: true, value: 'success-1', durationMs: expect.any(Number) });
  expect(poolResults[1].ok).toBe(false);
  expect(poolResults[1].error).toBeInstanceOf(Error);
  expect(poolResults[1].error.message).toBe('task-error');
  expect(poolResults[2]).toEqual({ ok: true, value: 'success-2', durationMs: expect.any(Number) });
  expect(poolResults[3].ok).toBe(false);
  expect(poolResults[3].error).toBeInstanceOf(Error);
  expect(poolResults[4]).toEqual({ ok: true, value: 'success-3', durationMs: expect.any(Number) });
});

test('pool: throws synchronously for invalid concurrency', async () => {
  const queue = new Queue();
  queue.enqueue(async () => 'task');

  expect(() => run(queue, 0)).toThrow('concurrency must be a positive integer');
  expect(() => run(queue, -1)).toThrow('concurrency must be a positive integer');
  expect(() => run(queue, 1.5)).toThrow('concurrency must be a positive integer');
  expect(() => run(queue, 'not-a-number')).toThrow('concurrency must be a positive integer');
  expect(() => run(queue, null)).toThrow('concurrency must be a positive integer');
});

test('pool: handles empty queue', async () => {
  const queue = new Queue();

  const poolResults = await run(queue, 5);

  expect(poolResults).toHaveLength(0);
});

test('pool: measures duration per task', async () => {
  const queue = new Queue();

  queue.enqueue(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'slow';
  });
  queue.enqueue(async () => 'fast');

  const poolResults = await run(queue, 1);

  expect(poolResults[0].durationMs).toBeGreaterThanOrEqual(20);
  expect(poolResults[1].durationMs).toBeLessThan(20);
});

test('pool: handles rejected promises', async () => {
  const queue = new Queue();

  queue.enqueue(async () => Promise.reject(new Error('rejected')));
  queue.enqueue(async () => 'success');

  const poolResults = await run(queue, 1);

  expect(poolResults[0].ok).toBe(false);
  expect(poolResults[0].error.message).toBe('rejected');
  expect(poolResults[1].ok).toBe(true);
  expect(poolResults[1].value).toBe('success');
});

test('pool: works with high concurrency on small queue', async () => {
  const queue = new Queue();

  queue.enqueue(async () => 'task-1');
  queue.enqueue(async () => 'task-2');

  const poolResults = await run(queue, 10);

  expect(poolResults).toHaveLength(2);
  expect(poolResults[0]).toEqual({ ok: true, value: 'task-1', durationMs: expect.any(Number) });
  expect(poolResults[1]).toEqual({ ok: true, value: 'task-2', durationMs: expect.any(Number) });
});

test('pool: maintains order with concurrent execution', async () => {
  const queue = new Queue();
  const executionOrder = [];

  for (let i = 0; i < 6; i++) {
    const taskNum = i;
    queue.enqueue(async () => {
      executionOrder.push(taskNum);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      return taskNum;
    });
  }

  const poolResults = await run(queue, 3);

  // Results should be in enqueue order (0, 1, 2, 3, 4, 5)
  expect(poolResults.map(r => r.value)).toEqual([0, 1, 2, 3, 4, 5]);
  // But execution order may be different due to concurrency
  expect(executionOrder.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
});
