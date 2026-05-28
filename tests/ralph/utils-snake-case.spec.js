import { test, expect } from '@playwright/test';
import { snakeCase } from '../../src/ralph/utils/snake-case.js';

test('snakeCase: happy path — converts camelCase to snake_case', () => {
  expect(snakeCase('helloWorld')).toBe('hello_world');
});

test('snakeCase: converts HELLO-WORLD to hello_world', () => {
  expect(snakeCase('HELLO-WORLD')).toBe('hello_world');
});

test('snakeCase: converts Hello World to hello_world', () => {
  expect(snakeCase('Hello World')).toBe('hello_world');
});

test('snakeCase: handles empty string', () => {
  expect(snakeCase('')).toBe('');
});

test('snakeCase: throws TypeError when given non-string input', () => {
  expect(() => snakeCase(null)).toThrow(TypeError);
  expect(() => snakeCase(undefined)).toThrow(TypeError);
  expect(() => snakeCase(123)).toThrow(TypeError);
  expect(() => snakeCase({})).toThrow(TypeError);
});

test('snakeCase: handles already snake_case strings', () => {
  expect(snakeCase('hello_world')).toBe('hello_world');
});

test('snakeCase: handles multiple consecutive uppercase letters', () => {
  expect(snakeCase('HTTPSConnection')).toBe('https_connection');
});

test('snakeCase: handles multiple spaces and hyphens', () => {
  expect(snakeCase('hello---world  test')).toBe('hello_world_test');
});
