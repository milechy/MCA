const { test, expect } = require('@playwright/test');
const { normalizePosixPath } = require('../../src/ralph/path-normalize');

test('normalizePosixPath: empty string returns empty string', () => {
  expect(normalizePosixPath('')).toBe('');
});

test('normalizePosixPath: null returns empty string', () => {
  expect(normalizePosixPath(null)).toBe('');
});

test('normalizePosixPath: undefined returns empty string', () => {
  expect(normalizePosixPath(undefined)).toBe('');
});

test('normalizePosixPath: root path stays root', () => {
  expect(normalizePosixPath('/')).toBe('/');
});

test('normalizePosixPath: Windows backslashes converted to forward slashes', () => {
  expect(normalizePosixPath('a\\b\\c')).toBe('a/b/c');
});

test('normalizePosixPath: mixed slashes normalized', () => {
  expect(normalizePosixPath('a\\b/c\\d')).toBe('a/b/c/d');
});

test('normalizePosixPath: multiple consecutive slashes collapsed', () => {
  expect(normalizePosixPath('a//b///c')).toBe('a/b/c');
});

test('normalizePosixPath: multiple consecutive backslashes collapsed', () => {
  expect(normalizePosixPath('a\\\\b\\\\\\c')).toBe('a/b/c');
});

test('normalizePosixPath: mixed consecutive slashes collapsed', () => {
  expect(normalizePosixPath('a\\/b//\\c')).toBe('a/b/c');
});

test('normalizePosixPath: trailing slash preserved on non-root paths', () => {
  expect(normalizePosixPath('a/b/')).toBe('a/b/');
});

test('normalizePosixPath: trailing backslash preserved on non-root paths', () => {
  expect(normalizePosixPath('a\\b\\')).toBe('a/b/');
});

test('normalizePosixPath: absolute path with trailing slash', () => {
  expect(normalizePosixPath('/a/b/')).toBe('/a/b/');
});

test('normalizePosixPath: absolute path without trailing slash', () => {
  expect(normalizePosixPath('/a/b')).toBe('/a/b');
});

test('normalizePosixPath: Windows absolute path', () => {
  expect(normalizePosixPath('C:\\Users\\test')).toBe('C:/Users/test');
});

test('normalizePosixPath: simple relative path', () => {
  expect(normalizePosixPath('a/b/c')).toBe('a/b/c');
});

test('normalizePosixPath: single segment path', () => {
  expect(normalizePosixPath('file.txt')).toBe('file.txt');
});

test('normalizePosixPath: path with dots', () => {
  expect(normalizePosixPath('./a/b')).toBe('./a/b');
});

test('normalizePosixPath: path with parent directory references', () => {
  expect(normalizePosixPath('../a/b')).toBe('../a/b');
});
