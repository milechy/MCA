function snakeCase(str) {
  if (typeof str !== 'string') {
    throw new TypeError('snakeCase expects a string argument');
  }

  return str
    // Insert underscore before uppercase letters that follow lowercase letters
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    // Insert underscore before an uppercase letter followed by a lowercase letter when preceded by uppercase letters
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Replace hyphens and spaces with underscores
    .replace(/[-\s]+/g, '_')
    // Convert to lowercase
    .toLowerCase()
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '');
}

module.exports = { snakeCase };
