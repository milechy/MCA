function uniqueBy(arr, keyFn) {
  if (!Array.isArray(arr)) {
    throw new TypeError('First argument must be an array');
  }
  if (typeof keyFn !== 'function') {
    throw new TypeError('Second argument must be a function');
  }

  const seen = new Set();
  const result = [];

  for (const item of arr) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

module.exports = { uniqueBy };
