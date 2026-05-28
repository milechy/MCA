import { test, expect } from '@playwright/test';
import { omitKeys } from '../../src/ralph/utils/omit-keys.js';

test('omitKeys: happy path — removes specified keys from object', () => {
  const result = omitKeys({ a: 1, b: 2, c: 3 }, ['b']);
  expect(result).toEqual({ a: 1, c: 3 });
});

test('omitKeys: spec example — {a:1,b:2,c:3} with [b] returns {a:1,c:3}', () => {
  const result = omitKeys({ a: 1, b: 2, c: 3 }, ['b']);
  expect(result).toEqual({ a: 1, c: 3 });
});

test('omitKeys: empty keys array — returns copy of original object', () => {
  const original = { x: 10, y: 20 };
  const result = omitKeys(original, []);
  expect(result).toEqual(original);
  expect(result).not.toBe(original); // verify it's a new object
});

test('omitKeys: throws when first argument is not an object', () => {
  expect(() => omitKeys(null, ['a'])).toThrow('First argument must be an object');
  expect(() => omitKeys(undefined, ['a'])).toThrow('First argument must be an object');
  expect(() => omitKeys('string', ['a'])).toThrow('First argument must be an object');
  expect(() => omitKeys(42, ['a'])).toThrow('First argument must be an object');
});

test('omitKeys: throws when second argument is not an array', () => {
  expect(() => omitKeys({ a: 1 }, 'b')).toThrow('Second argument must be an array');
  expect(() => omitKeys({ a: 1 }, null)).toThrow('Second argument must be an array');
  expect(() => omitKeys({ a: 1 }, { b: true })).toThrow('Second argument must be an array');
});

test('omitKeys: removes multiple keys', () => {
  const result = omitKeys({ a: 1, b: 2, c: 3, d: 4 }, ['b', 'd']);
  expect(result).toEqual({ a: 1, c: 3 });
});

test('omitKeys: handles non-existent keys gracefully', () => {
  const result = omitKeys({ a: 1, b: 2 }, ['c', 'd']);
  expect(result).toEqual({ a: 1, b: 2 });
});
