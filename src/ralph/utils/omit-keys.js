function omitKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('First argument must be an object');
  }
  if (!Array.isArray(keys)) {
    throw new Error('Second argument must be an array');
  }

  const keysSet = new Set(keys);
  const result = {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && !keysSet.has(key)) {
      result[key] = obj[key];
    }
  }

  return result;
}

module.exports = { omitKeys };
