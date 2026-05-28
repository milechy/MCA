const { test, expect } = require('@playwright/test');
const { pickKeys } = require('../../src/ralph/utils/pick-keys');

test('pickKeys: happy path — filters object to specified keys', () => {
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  const result = pickKeys(obj, ['a', 'c']);
  expect(result).toEqual({ a: 1, c: 3 });
});

test('pickKeys: spec example — {a:1,b:2,c:3} with [a,c] returns {a:1,c:3}', () => {
  const result = pickKeys({ a: 1, b: 2, c: 3 }, ['a', 'c']);
  expect(result).toEqual({ a: 1, c: 3 });
});

test('pickKeys: empty keys array returns empty object', () => {
  const obj = { a: 1, b: 2, c: 3 };
  const result = pickKeys(obj, []);
  expect(result).toEqual({});
});

test('pickKeys: keys not present in object are skipped', () => {
  const obj = { a: 1, b: 2 };
  const result = pickKeys(obj, ['a', 'x', 'y']);
  expect(result).toEqual({ a: 1 });
});

test('pickKeys: throws when first argument is not an object', () => {
  expect(() => pickKeys(null, ['a'])).toThrow('pickKeys: first argument must be a non-null object');
  expect(() => pickKeys('string', ['a'])).toThrow('pickKeys: first argument must be a non-null object');
  expect(() => pickKeys([1, 2, 3], ['a'])).toThrow('pickKeys: first argument must be a non-null object');
});

test('pickKeys: throws when second argument is not an array', () => {
  expect(() => pickKeys({ a: 1 }, 'a')).toThrow('pickKeys: second argument must be an array');
  expect(() => pickKeys({ a: 1 }, { a: true })).toThrow('pickKeys: second argument must be an array');
});

test('pickKeys: returns new object (not mutating original)', () => {
  const original = { a: 1, b: 2, c: 3 };
  const result = pickKeys(original, ['a', 'b']);
  result.a = 999;
  expect(original.a).toBe(1);
});
