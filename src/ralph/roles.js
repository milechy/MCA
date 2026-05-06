const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROLES = Object.freeze({
  owner_user_ids: [],
  admin_user_ids: [],
  reviewer_user_ids: [],
  observer_user_ids: []
});

function rolesPath(rootDir = process.cwd()) {
  return path.join(rootDir, '.ralph', 'roles.json');
}

function loadRoles(rootDir = process.cwd()) {
  const filePath = rolesPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_ROLES };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    ...DEFAULT_ROLES,
    ...parsed
  };
}

module.exports = {
  DEFAULT_ROLES,
  rolesPath,
  loadRoles
};
