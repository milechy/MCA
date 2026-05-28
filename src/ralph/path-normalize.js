function normalizePosixPath(p) {
  // Handle null/undefined by returning empty string
  if (p == null) {
    return '';
  }

  // Convert to string and handle empty string
  const str = String(p);
  if (str === '') {
    return '';
  }

  // Convert all backslashes to forward slashes
  let normalized = str.replaceAll('\\', '/');

  // Collapse repeated slashes, but preserve root
  // Split by '/', filter out empty strings, then rejoin
  const parts = normalized.split('/').filter(part => part !== '');
  
  // Determine if path started with '/' (root path)
  const isAbsolute = normalized.startsWith('/');
  
  // Determine if path ended with '/' (trailing slash)
  const hasTrailingSlash = normalized.endsWith('/') && normalized !== '/';
  
  // Reconstruct the path
  let result = parts.join('/');
  
  if (isAbsolute) {
    result = '/' + result;
  }
  
  if (hasTrailingSlash) {
    result = result + '/';
  }
  
  // Special case: if input was just '/', return '/'
  if (normalized === '/') {
    return '/';
  }
  
  return result;
}

module.exports = { normalizePosixPath };
