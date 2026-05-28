const { test, expect } = require('@playwright/test');
const { capitalize } = require('../../src/ralph/utils/capitalize');

test('capitalize: happy path — uppercases first character', () => {
  expect(capitalize('hello')).toBe('Hello');
});

test('capitalize: edge case — empty string returns empty string', () => {
  expect(capitalize('')).toBe('');
});

test('capitalize: edge case — single character', () => {
  expect(capitalize('a')).toBe('A');
});

test('capitalize: error case — non-string throws TypeError', () => {
  expect(() => capitalize(123)).toThrow(TypeError);
  expect(() => capitalize(null)).toThrow(TypeError);
  expect(() => capitalize(undefined)).toThrow(TypeError);
});
