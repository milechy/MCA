function kebabCase(str) {
  if (typeof str !== 'string') {
    throw new TypeError('Input must be a string');
  }

  return str
    // Insert a hyphen before uppercase letters that follow lowercase letters
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    // Replace underscores and spaces with hyphens
    .replace(/[_\s]+/g, '-')
    // Convert to lowercase
    .toLowerCase()
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');
}

module.exports = { kebabCase };
