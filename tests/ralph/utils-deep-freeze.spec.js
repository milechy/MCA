import { test, expect } from '@playwright/test';
import { deepFreeze } from '../../src/ralph/utils/deep-freeze.js';

test('deepFreeze: happy path — freezes nested object structure', () => {
  const obj = {
    name: 'test',
    nested: {
      value: 42,
      deep: {
        data: 'hello'
      }
    },
    arr: [1, 2, { item: 'value' }]
  };

  const result = deepFreeze(obj);

  expect(result).toBe(obj);
  expect(Object.isFrozen(obj)).toBe(true);
  expect(Object.isFrozen(obj.nested)).toBe(true);
  expect(Object.isFrozen(obj.nested.deep)).toBe(true);
  expect(Object.isFrozen(obj.arr)).toBe(true);
  expect(Object.isFrozen(obj.arr[2])).toBe(true);
});

test('deepFreeze: skips frozen branches to avoid loops', () => {
  const inner = { value: 1 };
  Object.freeze(inner);

  const obj = {
    frozen: inner,
    other: { data: 2 }
  };

  const result = deepFreeze(obj);

  expect(Object.isFrozen(obj)).toBe(true);
  expect(Object.isFrozen(obj.frozen)).toBe(true);
  expect(Object.isFrozen(obj.other)).toBe(true);
  // Should not throw or loop infinitely
});

test('deepFreeze: handles empty object', () => {
  const obj = {};
  const result = deepFreeze(obj);

  expect(result).toBe(obj);
  expect(Object.isFrozen(obj)).toBe(true);
});

test('deepFreeze: handles empty array', () => {
  const arr = [];
  const result = deepFreeze(arr);

  expect(result).toBe(arr);
  expect(Object.isFrozen(arr)).toBe(true);
});

test('deepFreeze: throws when attempting to modify frozen object', () => {
  const obj = { value: 1 };
  deepFreeze(obj);

  expect(() => {
    obj.value = 2;
  }).toThrow();
});

test('deepFreeze: handles primitives in nested structures', () => {
  const obj = {
    str: 'text',
    num: 42,
    bool: true,
    nil: null,
    undef: undefined,
    nested: {
      arr: [1, 'two', true, null]
    }
  };

  const result = deepFreeze(obj);

  expect(Object.isFrozen(obj)).toBe(true);
  expect(Object.isFrozen(obj.nested)).toBe(true);
  expect(Object.isFrozen(obj.nested.arr)).toBe(true);
});

test('deepFreeze: returns the same reference', () => {
  const obj = { a: 1 };
  const result = deepFreeze(obj);

  expect(result).toBe(obj);
});
