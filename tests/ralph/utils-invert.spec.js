const { test, expect } = require('@playwright/test');
const { invert } = require('../../src/ralph/utils/invert');

test('invert: happy path with string values', () => {
  const input = { a: 'x', b: 'y' };
  const result = invert(input);
  expect(result).toEqual({ x: 'a', y: 'b' });
});

test('invert: numeric values become string keys', () => {
  const input = { a: 1, b: 2, c: 3 };
  const result = invert(input);
  expect(result).toEqual({ '1': 'a', '2': 'b', '3': 'c' });
});

test('invert: empty object returns empty object', () => {
  const input = {};
  const result = invert(input);
  expect(result).toEqual({});
});

test('invert: throws on non-object input', () => {
  expect(() => invert(null)).toThrow(TypeError);
  expect(() => invert(undefined)).toThrow(TypeError);
  expect(() => invert('string')).toThrow(TypeError);
  expect(() => invert(42)).toThrow(TypeError);
  expect(() => invert([1, 2, 3])).toThrow(TypeError);
});
