const { test, expect } = require('@playwright/test');
const { Queue } = require('../../src/ralph/utils/queue');

test('constructor creates empty queue', () => {
  const queue = new Queue();
  expect(queue.size).toBe(0);
  expect(queue.isEmpty).toBe(true);
});

test('enqueue adds items to queue', () => {
  const queue = new Queue();
  queue.enqueue('first');
  expect(queue.size).toBe(1);
  expect(queue.isEmpty).toBe(false);

  queue.enqueue('second');
  expect(queue.size).toBe(2);
});

test('dequeue returns items in FIFO order', () => {
  const queue = new Queue();
  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');

  expect(queue.dequeue()).toBe('first');
  expect(queue.dequeue()).toBe('second');
  expect(queue.dequeue()).toBe('third');
});

test('size getter tracks queue length correctly', () => {
  const queue = new Queue();
  expect(queue.size).toBe(0);

  queue.enqueue('a');
  expect(queue.size).toBe(1);

  queue.enqueue('b');
  queue.enqueue('c');
  expect(queue.size).toBe(3);

  queue.dequeue();
  expect(queue.size).toBe(2);

  queue.dequeue();
  queue.dequeue();
  expect(queue.size).toBe(0);
});

test('isEmpty getter returns true when queue is empty', () => {
  const queue = new Queue();
  expect(queue.isEmpty).toBe(true);

  queue.enqueue('item');
  expect(queue.isEmpty).toBe(false);

  queue.dequeue();
  expect(queue.isEmpty).toBe(true);
});

test('dequeue returns undefined when queue is empty', () => {
  const queue = new Queue();
  expect(queue.dequeue()).toBeUndefined();

  queue.enqueue('item');
  queue.dequeue();
  expect(queue.dequeue()).toBeUndefined();
});

test('enqueue and dequeue with various data types', () => {
  const queue = new Queue();
  const obj = { key: 'value' };
  const arr = [1, 2, 3];

  queue.enqueue(42);
  queue.enqueue('string');
  queue.enqueue(obj);
  queue.enqueue(arr);
  queue.enqueue(null);
  queue.enqueue(undefined);

  expect(queue.dequeue()).toBe(42);
  expect(queue.dequeue()).toBe('string');
  expect(queue.dequeue()).toBe(obj);
  expect(queue.dequeue()).toBe(arr);
  expect(queue.dequeue()).toBeNull();
  expect(queue.dequeue()).toBeUndefined();
  expect(queue.dequeue()).toBeUndefined();
});

test('multiple enqueue/dequeue cycles maintain FIFO order', () => {
  const queue = new Queue();

  queue.enqueue(1);
  queue.enqueue(2);
  expect(queue.dequeue()).toBe(1);

  queue.enqueue(3);
  queue.enqueue(4);
  expect(queue.dequeue()).toBe(2);
  expect(queue.dequeue()).toBe(3);

  queue.enqueue(5);
  expect(queue.dequeue()).toBe(4);
  expect(queue.dequeue()).toBe(5);
  expect(queue.isEmpty).toBe(true);
});
