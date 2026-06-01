const { test, expect } = require('@playwright/test');

const { KINDS, slug, planProject, COPY_FILES } = require('../../src/ralph/project-bootstrap');

test('slug normalizes names to repo-safe slugs', () => {
  expect(slug('My Cool Thing!')).toBe('my-cool-thing');
  expect(slug('  Spaces  ')).toBe('spaces');
  expect(slug('UPPER_Case.v2')).toBe('upper_case.v2');
  expect(slug('')).toBe('project');
});

test('planProject rejects missing name / unknown kind', () => {
  expect(planProject({}).reason).toBe('name_required');
  expect(planProject({ name: 'x', kind: 'bogus' }).reason).toBe('unknown_kind');
});

test('planProject (node-lib) produces repo + files + secrets + first issue', () => {
  const p = planProject({ name: 'Widget Lib', kind: 'node-lib', description: 'a widget lib', owner: 'milechy' });
  expect(p.ok).toBe(true);
  expect(p.repo.full_name).toBe('milechy/widget-lib');
  expect(p.repo.visibility).toBe('private');
  const paths = p.files.map((f) => f.path);
  expect(paths).toContain('README.md');
  expect(paths).toContain('package.json');
  expect(paths).toContain('.github/ralph-backlog.json');
  expect(paths).toContain('src/index.js');
  expect(paths).toContain('test/index.test.js');
  // proven workflows are copied, not embedded
  expect(paths).toContain('.github/workflows/aider-resolver.yml');
  expect(paths).toContain('.github/workflows/issue-supplier.yml');
  expect(p.secrets_needed).toContain('LLM_API_KEY');
  expect(p.variables.AIDER_TEST_CMD).toBe('npm test');
  // brain + D1 learning config is inherited by new projects
  expect(p.secrets_needed).toContain('CLOUDFLARE_API_TOKEN');
  expect(p.variables.RALPH_D1_DATABASE_ID).toBeTruthy();
  expect(p.variables.CLOUDFLARE_ACCOUNT_ID).toBeTruthy();
  expect(p.variables.AIDER_DAILY_CAP_USD).toBe('100.00'); // $5 cap removed
  expect(p.cloudflare).toBe(null);
  expect(p.first_issue.title).toMatch(/Scaffold/);
});

test('planProject package.json has a runnable test script', () => {
  const p = planProject({ name: 'x', kind: 'node-lib' });
  const pkg = JSON.parse(p.files.find((f) => f.path === 'package.json').content);
  expect(pkg.scripts.test).toBe('node --test');
  expect(pkg.private).toBe(true);
});

test('planProject (cf-worker) adds wrangler + worker + cloudflare deploy', () => {
  const p = planProject({ name: 'edge-api', kind: 'cf-worker' });
  const paths = p.files.map((f) => f.path);
  expect(paths).toContain('wrangler.toml');
  expect(paths).toContain('src/index.mjs');
  expect(p.cloudflare.type).toBe('worker');
  expect(p.cloudflare.deploy_cmd).toContain('wrangler deploy');
  // REPO_SLUG substituted in wrangler.toml
  const wt = p.files.find((f) => f.path === 'wrangler.toml').content;
  expect(wt).toContain('name = "edge-api"');
  expect(wt).not.toContain('REPO_SLUG');
});

test('planProject (cf-pages) targets pages deploy', () => {
  const p = planProject({ name: 'site', kind: 'cf-pages' });
  expect(p.files.map((f) => f.path)).toContain('public/index.html');
  expect(p.cloudflare.type).toBe('pages');
  expect(p.cloudflare.deploy_cmd).toContain('pages deploy');
});

test('planProject honors public visibility', () => {
  const p = planProject({ name: 'oss', visibility: 'public' });
  expect(p.repo.visibility).toBe('public');
});

test('COPY_FILES reference real, existing source paths in this repo', () => {
  const fs = require('node:fs');
  for (const f of COPY_FILES) {
    expect(fs.existsSync(f.copyFrom)).toBe(true);
  }
});

test('KINDS is the canonical kind list', () => {
  expect(KINDS).toEqual(['node-lib', 'cf-worker', 'cf-pages']);
});

test('seeded backlog is valid empty ralph-backlog-v1', () => {
  const p = planProject({ name: 'x' });
  const bl = JSON.parse(p.files.find((f) => f.path === '.github/ralph-backlog.json').content);
  expect(bl.version).toBe('ralph-backlog-v1');
  expect(Array.isArray(bl.items)).toBe(true);
});
