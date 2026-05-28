function deepFreeze(obj) {
  // If already frozen, skip to avoid loops
  if (Object.isFrozen(obj)) {
    return obj;
  }

  // Freeze the current object/array
  Object.freeze(obj);

  // Recursively freeze all properties
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = obj[prop];
    
    // Only recurse into plain objects and arrays
    if (value !== null && (typeof value === 'object')) {
      if (!Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
  });

  return obj;
}

module.exports = { deepFreeze };
