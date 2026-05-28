function parseBoolEnv(value) {
  const normalized = String(value || '').toLowerCase().trim();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean environment value: "${value}"`);
}

module.exports = { parseBoolEnv };
