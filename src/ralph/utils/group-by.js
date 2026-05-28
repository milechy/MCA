function groupBy(arr, keyFn) {
  if (!Array.isArray(arr)) {
    throw new TypeError('First argument must be an array');
  }
  if (typeof keyFn !== 'function') {
    throw new TypeError('Second argument must be a function');
  }

  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

module.exports = { groupBy };
