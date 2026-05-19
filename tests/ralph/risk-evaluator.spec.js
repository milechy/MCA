const { test, expect } = require('@playwright/test');
const { CONTROL_ACTIONS, APPROVAL_TYPES, CONTROL_REASONS } = require('../../src/ralph/types');
const { evaluateRisk, decideControlAction } = require('../../src/ralph/risk-evaluator');

test('destructive SQL produces Risk 5 stop decision', () => {
  const plan = {
    story_id: 'STORY-SECURITY',
    migration_plan: {
      files: ['supabase/migrations/001_drop.sql'],
      sql: 'DROP TABLE users;'
    }
  };

  const risk = evaluateRisk(plan);
  const decision = decideControlAction(risk, 'fullauto', 'production');

  expect(risk.score).toBe(5);
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.STOP,
    reason: CONTROL_REASONS.RISK_5_SECURITY_STOP,
    requires_human: true,
    executable: false
  });
});

test('staging migration requires approval in approval mode', () => {
  const plan = {
    story_id: 'STORY-DB',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_add_profile.sql']
  };

  const risk = evaluateRisk(plan);
  const decision = decideControlAction(risk, 'approval', 'staging');

  expect(risk).toMatchObject({ score: 3, category: 'local_or_staging_db_migration', label: 'RISK_3A_DB_MIGRATION', control_model: 'control_decision_v1' });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.APPROVAL_MODE_RISK_THRESHOLD,
    approval_type: APPROVAL_TYPES.PLAN,
    target_env: 'staging',
    risk_score: 3,
    requires_human: true,
    executable: false
  });
});

test('production risk requires plan approval even outside approval mode threshold', () => {
  const risk = { score: 3, category: 'rls_policy_change', label: 'RISK_3C_RLS_POLICY' };
  const decision = decideControlAction(risk, { mode: 'fullauto', target_env: 'production' });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.PLAN
  });
});

test('diff approval is explicit and never confused with auto execute', () => {
  const risk = { score: 0, category: 'low', label: 'RISK_0_LOW' };
  const decision = decideControlAction(risk, { mode: 'fullauto', target_env: 'local', approval_type: APPROVAL_TYPES.DIFF });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL,
    reason: CONTROL_REASONS.DIFF_APPROVAL_REQUIRED,
    approval_type: APPROVAL_TYPES.DIFF,
    requires_human: true,
    executable: false
  });
});

test('mode change and resume after security stop require approval', () => {
  const risk = { score: 0, category: 'low', label: 'RISK_0_LOW' };
  expect(decideControlAction(risk, { mode_change: true })).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.MODE_CHANGE_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.MODE_CHANGE
  });
  expect(decideControlAction(risk, { resume_after_security_stop: true })).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.RESUME_AFTER_SECURITY_STOP_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP
  });
});

test('low risk fullauto can auto execute with explicit decision object', () => {
  const risk = { score: 1, category: 'low', label: 'RISK_1_LOW' };
  expect(decideControlAction(risk, { mode: 'fullauto', target_env: 'local' })).toMatchObject({
    action: CONTROL_ACTIONS.AUTO_EXECUTE,
    reason: CONTROL_REASONS.AUTO_EXECUTE_ALLOWED,
    requires_human: false,
    executable: true
  });
});

// ============================================================
// Phase 2 #2: path-aware risk evaluation tests
// ============================================================

const { riskForPath, riskForPaths, pathsFromPlan } = require('../../src/ralph/risk-paths');

test('Phase 2 #2: docs-only story mentioning "RLS" stays at Risk 0 (downgrade applied)', () => {
  // The Phase 1 soak regression case. Glossary stories that *describe* RLS
  // / auth / secrets must not be gated as if they implement those concepts.
  const plan = {
    story_id: 'STORY-SOAK-GLOSSARY-RLS',
    requested_paths: ['docs/soak/glossary-rls-row-level-security.md'],
    title: 'Glossary: RLS row level security',
    requirement: 'Define RLS in 4-6 sentences. Mention policy, ENABLE ROW LEVEL SECURITY.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(0);
  expect(risk.label).toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
  // The original content risk is preserved for observability.
  expect(risk.content_risk_pre_downgrade.score).toBeGreaterThanOrEqual(3);
  expect(risk.path_risk.score).toBe(0);
});

test('Phase 2 #2: docs-only story mentioning "auth" + "jwt" stays at Risk 0', () => {
  const plan = {
    story_id: 'STORY-SOAK-GLOSSARY-AUTH',
    requested_paths: ['docs/soak/glossary-auth-jwt-session.md'],
    title: 'Glossary: auth / JWT / session',
    requirement: 'Define authentication and JWT session lifecycle.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(0);
  expect(risk.label).toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2: docs-only story mentioning "api key" + "token" (Risk 4 content) stays at Risk 0', () => {
  // touchesSecrets keywords are aggressive (matches "token", "api key").
  // Glossary entries explaining these stay Risk 0. Note: "service_role" is
  // in the destructive keyword list (Risk 5) by pre-Phase-2 design and is
  // intentionally NOT downgraded (see dedicated test below).
  const plan = {
    story_id: 'STORY-SOAK-GLOSSARY-SECRETS',
    requested_paths: ['docs/soak/glossary-api-keys.md'],
    title: 'Glossary: API keys and tokens',
    requirement: 'Define api key and token handling for the autonomous loop.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(0);
  expect(risk.label).toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
  expect(risk.content_risk_pre_downgrade.score).toBeGreaterThanOrEqual(4);
});

test('Phase 2 #2: docs-only story containing destructive keyword (service_role) is NOT downgraded — stays Risk 5', () => {
  // The destructive keyword set is intentional and small (DROP TABLE,
  // service_role, force push, etc.). Even a docs file mentioning these
  // verbatim must not be auto-approved because they may be operational
  // runbooks where the exact phrasing is dangerous in context.
  const plan = {
    story_id: 'STORY-SOAK-GLOSSARY-SERVICE-ROLE',
    requested_paths: ['docs/soak/glossary-supabase-service-role.md'],
    title: 'Glossary: Supabase service_role',
    requirement: 'Define service_role.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(5);
  expect(risk.label).not.toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2: docs story with destructive keyword stays at Risk 5 (no downgrade)', () => {
  // The destructive keyword set (DROP TABLE, force push, etc.) is intentional
  // and small. Even a docs file containing those phrases must not be auto-
  // approved — they may be operational runbooks where the exact phrasing
  // matters.
  const plan = {
    story_id: 'STORY-SOAK-RUNBOOK-DESTRUCTIVE',
    requested_paths: ['docs/soak/runbook-dangerous.md'],
    title: 'Runbook: drop table users',
    requirement: 'Procedure for: drop table users in emergency'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(5);
  // No downgrade applied.
  expect(risk.label).not.toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2: src/** change stays at content-based Risk 3 (no downgrade)', () => {
  const plan = {
    story_id: 'STORY-AUTH-FIX',
    requested_paths: ['src/auth/session-validator.ts'],
    title: 'Fix session validation',
    requirement: 'Update JWT validation to handle expired tokens.'
  };
  const risk = evaluateRisk(plan);
  // src/auth path triggers path-based Risk 3, content also triggers 3 — both align.
  expect(risk.score).toBeGreaterThanOrEqual(3);
  // No downgrade: path risk > 0.
  expect(risk.label).not.toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2.5: tests/** test addition is Risk 1 even with content keywords (safe-scope downgrade)', () => {
  // Phase 2 #2 originally returned 3 here (content wins via touchesRls).
  // Phase 2 #2.5 introduced the safe-scope downgrade: when path_risk <= 2
  // and content_risk is 3-4 (non-destructive), the path-based risk wins.
  // Result: a test file *mentioning* RLS in its title/requirement is Risk 1.
  const plan = {
    story_id: 'STORY-TEST-RLS',
    requested_paths: ['tests/ralph/rls-policy.spec.js'],
    title: 'Add RLS test',
    requirement: 'Test that RLS policy blocks cross-tenant queries.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(1);
  expect(risk.label).toBe('RISK_1_SAFE_SCOPE_DOWNGRADE');
  expect(risk.content_risk_pre_downgrade.score).toBe(3);
});

test('Phase 2 #2: tests/rls/** RLS-specific test is Risk 3d (path-based, not downgraded)', () => {
  const plan = {
    story_id: 'STORY-PGTAP-RLS',
    requested_paths: ['tests/rls/001_users_isolation.sql'],
    title: 'Add pgTAP cross-tenant isolation test'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(3);
  // Path-based risk is 3 (RISK_3D_RLS_TEST). No downgrade because path_risk.score > 0.
  expect(risk.label).not.toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2: .env touching is Risk 5 STOP regardless of content', () => {
  const plan = {
    story_id: 'STORY-ENV-EDIT',
    requested_paths: ['.env.local'],
    title: 'Update env'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(5);
});

test('Phase 2 #2: docs/legal/** is Risk 4 (legal review required)', () => {
  const plan = {
    story_id: 'STORY-PRIVACY-POLICY',
    requested_paths: ['docs/legal/privacy-policy.md'],
    title: 'Draft privacy policy v0.1'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(4);
});

test('Phase 2 #2: config/client-keywords.txt is Risk 4 (NDA list)', () => {
  const plan = {
    story_id: 'STORY-NDA-KEYWORDS',
    requested_paths: ['config/client-keywords.txt'],
    title: 'Add new client keyword'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(4);
});

test('Phase 2 #2: mixed paths (docs + src) uses src risk', () => {
  // A story that touches both a docs file and a source file must not be
  // downgraded to 0. Path-based risk is max(docs=0, src=2) = 2.
  const plan = {
    story_id: 'STORY-FEATURE-WITH-DOCS',
    requested_paths: ['docs/feature.md', 'src/ralph/something.js'],
    title: 'Add feature X'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBeGreaterThanOrEqual(2);
  expect(risk.label).not.toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2: empty requested_paths falls back to content-based risk', () => {
  // Backwards compatibility: plans without requested_paths still get the old
  // content-based risk. (This is the pre-Phase-2 default behavior.)
  const plan = {
    story_id: 'STORY-LEGACY',
    title: 'Some auth change',
    requirement: 'Modify authentication flow.'
  };
  const risk = evaluateRisk(plan);
  // No paths -> no docs-only downgrade. Content risk wins.
  expect(risk.score).toBeGreaterThanOrEqual(3);
});

test('Phase 2 #2: riskForPath direct calls', () => {
  expect(riskForPath('docs/x.md')).toMatchObject({ score: 0 });
  expect(riskForPath('README.md')).toMatchObject({ score: 0 });
  expect(riskForPath('tests/x.spec.js')).toMatchObject({ score: 1 });
  expect(riskForPath('src/ralph/foo.js')).toMatchObject({ score: 2 });
  expect(riskForPath('src/auth/login.ts')).toMatchObject({ score: 3, label: 'RISK_3B_AUTH_LOGIC' });
  expect(riskForPath('src/pii/detect.py')).toMatchObject({ score: 3, label: 'RISK_3C_PII_LOGIC' });
  expect(riskForPath('supabase/migrations/001_init.sql')).toMatchObject({ score: 3 });
  expect(riskForPath('supabase/migrations/010_rls_policy.sql')).toMatchObject({ score: 3, label: 'RISK_3D_RLS_POLICY' });
  expect(riskForPath('docs/legal/privacy.md')).toMatchObject({ score: 4 });
  expect(riskForPath('config/client-keywords.txt')).toMatchObject({ score: 4 });
  expect(riskForPath('.github/workflows/ci.yml')).toMatchObject({ score: 4 });
  expect(riskForPath('.env')).toMatchObject({ score: 5 });
  expect(riskForPath('.env.production')).toMatchObject({ score: 5 });
  expect(riskForPath('app-credentials.json')).toMatchObject({ score: 5 });
  expect(riskForPath('foo.secret')).toMatchObject({ score: 5 });
});

test('Phase 2 #2: riskForPaths max + unmatched handling', () => {
  // All docs -> Risk 0
  expect(riskForPaths(['docs/a.md', 'docs/b.md']).score).toBe(0);
  // Mixed docs + src -> Risk 2
  expect(riskForPaths(['docs/a.md', 'src/x.js']).score).toBe(2);
  // Unmatched path (no rule fires) -> conservative Risk 2
  const r = riskForPaths(['random/unknown/file.xyz']);
  expect(r.score).toBe(2);
  expect(r.paths_unmatched).toBe(1);
  expect(r.label).toBe('RISK_2_UNMATCHED_PATH');
  // Empty list -> Risk 0
  expect(riskForPaths([]).score).toBe(0);
});

test('Phase 2 #2: pathsFromPlan deduplicates and normalizes', () => {
  const paths = pathsFromPlan({
    requested_paths: ['docs/x.md', './docs/x.md'],
    planned_files: ['src/y.js'],
    migration_plan: { files: ['supabase\\migrations\\001.sql'] }
  });
  expect(paths).toEqual(['docs/x.md', 'src/y.js', 'supabase/migrations/001.sql']);
});

test('Phase 2 #2: backwards-compat — existing migration plan still triggers Risk 3', () => {
  // The pre-existing staging-migration test should still pass with the new
  // implementation. Verify that the plan structure used by older tests
  // continues to produce Risk 3.
  const plan = {
    story_id: 'STORY-DB',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_add_profile.sql']
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(3);
});

// ============================================================
// Phase 2 #2.5: safe-scope downgrade tests
// ============================================================

test('Phase 2 #2.5: scripts/** story with "secret-scan" keyword stays at Risk 2 (the original smoke-test scenario)', () => {
  // This is the exact scenario from the first Phase 2 #3 smoke test
  // (STORY-PHASE2-03-SMOKE-PATH-FILTER). The requirement legitimately
  // mentioned the gate name "pre-secret-scan" multiple times; before
  // Phase 2 #2.5, touchesSecrets matched "secret" -> content_risk=4 ->
  // story stuck at PLAN_APPROVAL_PENDING even though path_risk=2 (scripts).
  const plan = {
    story_id: 'STORY-PATH-FILTER',
    requested_paths: ['scripts/gates/path-filter.sh', 'tests/ralph/path-filter.spec.js'],
    title: 'Add path-filter gate suite',
    requirement: [
      'Add scripts/gates/path-filter.sh that selects which gates to run.',
      'Always emit pre-secret-scan.',
      'Emit ralph-tests if any tests/ralph/ path changed.',
      'Emit telegram-tests if any tests/telegram/ path changed.'
    ].join(' ')
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(2);
  expect(risk.label).toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
  expect(risk.content_risk_pre_downgrade.score).toBeGreaterThanOrEqual(3);
  expect(risk.path_label).toBe('RISK_2_SCRIPT');
});

test('Phase 2 #2.5: src/** story mentioning "auth" and "token" stays at Risk 2', () => {
  // A regular source code task that *mentions* auth/token in passing —
  // for example refactoring a request handler that happens to validate
  // a bearer token — must not be gated.
  const plan = {
    story_id: 'STORY-SRC-REFACTOR',
    requested_paths: ['src/ralph/request-handler.js'],
    title: 'Refactor request-handler',
    requirement: 'Extract the auth token parsing into a helper.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(2);
  expect(risk.label).toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
  expect(risk.content_risk_pre_downgrade.score).toBeGreaterThanOrEqual(3);
});

test('Phase 2 #2.5: src/auth/** story mentioning "auth" is NOT downgraded (path is auth-scoped)', () => {
  // When the touched path is itself in an auth scope (src/auth/**, Risk 3b),
  // the safe-scope downgrade must NOT apply. Real auth changes require
  // proper plan approval.
  const plan = {
    story_id: 'STORY-AUTH-CHANGE',
    requested_paths: ['src/auth/session-validator.ts'],
    title: 'Update auth flow',
    requirement: 'Modify auth token validation.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBeGreaterThanOrEqual(3);
  // Either content_risk (3) wins or path-based RISK_3B_AUTH_LOGIC wins.
  expect(risk.label).not.toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
});

test('Phase 2 #2.5: supabase/migrations/** is NOT downgraded (Risk 3a always wins)', () => {
  // Migration files must always require plan approval.
  const plan = {
    story_id: 'STORY-MIGRATION',
    requested_paths: ['supabase/migrations/050_add_table.sql'],
    title: 'Add new table',
    requirement: 'Add ghi.skills table with proper indexes.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBeGreaterThanOrEqual(3);
  expect(risk.label).not.toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
});

test('Phase 2 #2.5: destructive keyword (drop table) in scripts is Risk 5 (no downgrade)', () => {
  // The destructive keyword set always wins. A migration runner script
  // that contains the literal phrase "drop table" — even in scripts/ —
  // stays at Risk 5.
  const plan = {
    story_id: 'STORY-RUNNER',
    requested_paths: ['scripts/db/runner.sh'],
    title: 'Migration runner',
    requirement: 'Helper that can run drop table cleanup in dev.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(5);
  expect(risk.label).not.toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
});

test('Phase 2 #2.5: service_role keyword in scripts is Risk 5 (no downgrade)', () => {
  // service_role is in the destructive set by long-standing design and
  // is never downgraded.
  const plan = {
    story_id: 'STORY-SR-HELPER',
    requested_paths: ['scripts/utils/db-helper.sh'],
    title: 'Add db helper',
    requirement: 'Helper script that uses service_role to seed test data.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(5);
});

test('Phase 2 #2.5: docs-only downgrade still wins when both apply (docs path + content risk)', () => {
  // Backwards-compat with Phase 2 #2: docs-only path keeps its
  // RISK_0_DOCS_ONLY_DOWNGRADE label (not RISK_0_SAFE_SCOPE_DOWNGRADE).
  const plan = {
    story_id: 'STORY-DOC-AUTH',
    requested_paths: ['docs/soak/glossary-auth.md'],
    title: 'Glossary: auth',
    requirement: 'Describe the auth token lifecycle.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(0);
  expect(risk.label).toBe('RISK_0_DOCS_ONLY_DOWNGRADE');
});

test('Phase 2 #2.5: mixed paths (scripts + supabase/migrations) is NOT downgraded — Risk 3 wins', () => {
  // Mixed-scope path lists: any path with Risk >= 3 disqualifies the
  // safe-scope downgrade (path_risk for the set is 3).
  const plan = {
    story_id: 'STORY-MIXED-MIGRATION',
    requested_paths: ['scripts/utils/runner.sh', 'supabase/migrations/060_seed.sql'],
    title: 'Add migration + runner'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBeGreaterThanOrEqual(3);
  expect(risk.label).not.toBe('RISK_2_SAFE_SCOPE_DOWNGRADE');
});

test('Phase 2 #2.5: content_risk = 2 (touchesAuthOrRls returns false) does not trigger safe-scope downgrade', () => {
  // The safe-scope downgrade only fires when content_risk >= 3 (because
  // a content_risk of 2 = clean of soft mentions; no downgrade needed).
  // A plain scripts story with no security keywords should just be path-
  // based Risk 2, no downgrade label.
  const plan = {
    story_id: 'STORY-PLAIN-SCRIPT',
    requested_paths: ['scripts/utils/echo.sh'],
    title: 'Add echo helper',
    requirement: 'Print stdin to stdout.'
  };
  const risk = evaluateRisk(plan);
  expect(risk.score).toBe(2);
  // path-based (not a "downgrade" because no content risk to suppress)
  expect(risk.label).toBe('RISK_2_SCRIPT');
});
