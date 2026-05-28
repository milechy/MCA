const { test, expect } = require('@playwright/test');
const { parseBoolEnv } = require('../../src/ralph/utils/parse-bool-env');

test('parseBoolEnv returns true for "1"', () => {
  expect(parseBoolEnv('1')).toBe(true);
});

test('parseBoolEnv returns true for "true" (case-insensitive)', () => {
  expect(parseBoolEnv('true')).toBe(true);
  expect(parseBoolEnv('TRUE')).toBe(true);
  expect(parseBoolEnv('True')).toBe(true);
});

test('parseBoolEnv returns true for "yes" and "on"', () => {
  expect(parseBoolEnv('yes')).toBe(true);
  expect(parseBoolEnv('on')).toBe(true);
});

test('parseBoolEnv returns false for "0"', () => {
  expect(parseBoolEnv('0')).toBe(false);
});

test('parseBoolEnv returns false for "false" (case-insensitive)', () => {
  expect(parseBoolEnv('false')).toBe(false);
  expect(parseBoolEnv('FALSE')).toBe(false);
});

test('parseBoolEnv returns false for "no" and "off"', () => {
  expect(parseBoolEnv('no')).toBe(false);
  expect(parseBoolEnv('off')).toBe(false);
});

test('parseBoolEnv returns false for empty string', () => {
  expect(parseBoolEnv('')).toBe(false);
});

test('parseBoolEnv throws on invalid input', () => {
  expect(() => parseBoolEnv('maybe')).toThrow();
  expect(() => parseBoolEnv('2')).toThrow();
  expect(() => parseBoolEnv('invalid')).toThrow();
});

test('parseBoolEnv handles null/undefined as empty string (falsy)', () => {
  expect(parseBoolEnv(null)).toBe(false);
  expect(parseBoolEnv(undefined)).toBe(false);
});
