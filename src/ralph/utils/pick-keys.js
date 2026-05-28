function pickKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('pickKeys: first argument must be a non-null object');
  }
  if (!Array.isArray(keys)) {
    throw new Error('pickKeys: second argument must be an array');
  }

  const result = {};
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

module.exports = { pickKeys };
