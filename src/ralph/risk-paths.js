// Phase 2 #2: path-aware risk evaluation.
//
// Until Phase 1, risk_evaluator only inspected the *text* of the plan
// (`JSON.stringify(plan).toLowerCase()`) for substrings like "rls", "auth",
// "secret". That made docs-only stories that *describe* security concepts
// — e.g. `docs/soak/glossary-risk-score-*.md` mentioning RLS — get the same
// Risk 3+ score as stories that actually change those concepts. The result:
// every docs story about security got stuck at PLAN_APPROVAL_PENDING in
// fullauto mode, and the autonomous loop could never write its own code
// (chicken-and-egg for Phase 2 dogfood).
//
// This module introduces a strictly-path-based risk dimension, derived from
// the file paths a plan actually touches. The downgrade rule (applied in
// risk-evaluator.js):
//   - If the path-based max risk is 0 (docs only) and the content-based
//     risk is >= 2 because of keyword matches, ignore the content risk and
//     use the path-based 0. The story is *describing*, not implementing.
//   - Otherwise use max(path_risk, content_risk).
//
// The rules below are intentionally a single ordered list; the first
// matching rule wins per-path. Specific patterns must come BEFORE general
// ones (e.g. `src/**/auth/**` before `src/**`).

const PATH_RISK_RULES = Object.freeze([
  // Risk 5 — never touch via autonomous loop
  { pattern: /^\.env(\..*)?$/i, score: 5, label: 'RISK_5_SECRETS_FILE' },
  { pattern: /credentials?\.(json|yaml|yml|toml|env)$/i, score: 5, label: 'RISK_5_CREDENTIALS_FILE' },
  { pattern: /\.secret(s)?(\..*)?$/i, score: 5, label: 'RISK_5_SECRETS_FILE' },

  // Risk 4 — legal / NDA / production-critical config
  { pattern: /^docs\/legal\//i, score: 4, label: 'RISK_4_LEGAL_DOCS' },
  { pattern: /^config\/client-keywords\.txt$/i, score: 4, label: 'RISK_4_CLIENT_KEYWORD_LIST' },
  { pattern: /^\.github\/workflows\//i, score: 4, label: 'RISK_4_CI_WORKFLOW' },

  // Risk 3d — RLS / policy SQL (NEW path-based, separate from substring detection)
  { pattern: /supabase\/migrations\/.+(policy|rls).*\.sql$/i, score: 3, label: 'RISK_3D_RLS_POLICY' },
  { pattern: /tests\/rls\//i, score: 3, label: 'RISK_3D_RLS_TEST' },

  // Risk 3c — PII detection logic
  { pattern: /\/pii\//i, score: 3, label: 'RISK_3C_PII_LOGIC' },

  // Risk 3b — auth flow
  { pattern: /\/auth\//i, score: 3, label: 'RISK_3B_AUTH_LOGIC' },
  { pattern: /\/invitations?\//i, score: 3, label: 'RISK_3B_AUTH_LOGIC' },

  // Risk 3a — DB migrations (any)
  { pattern: /^supabase\/migrations\//i, score: 3, label: 'RISK_3A_DB_MIGRATION' },

  // Risk 2 — general source (everything under src/, scripts/, etc.)
  { pattern: /^src\//i, score: 2, label: 'RISK_2_SOURCE_CODE' },
  { pattern: /^scripts\//i, score: 2, label: 'RISK_2_SCRIPT' },

  // Risk 1 — tests, lint config, etc.
  { pattern: /^tests\//i, score: 1, label: 'RISK_1_TEST' },
  { pattern: /^(\.eslintrc|\.prettierrc|tsconfig|playwright\.config).*$/i, score: 1, label: 'RISK_1_LINT_CONFIG' },
  { pattern: /\.(test|spec)\.(js|ts|jsx|tsx|py)$/i, score: 1, label: 'RISK_1_TEST' },

  // Risk 0 — docs / readme / changelog (default for *.md inside docs/)
  { pattern: /^docs\//i, score: 0, label: 'RISK_0_DOCS' },
  { pattern: /\.md$/i, score: 0, label: 'RISK_0_MARKDOWN' },
  { pattern: /^README/i, score: 0, label: 'RISK_0_README' }
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// Return the risk for a single path, or null if no rule matches.
// Caller is responsible for deciding the default when null is returned.
function riskForPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return null;
  for (const rule of PATH_RISK_RULES) {
    if (rule.pattern.test(normalized)) {
      return { score: rule.score, label: rule.label, matched_path: normalized };
    }
  }
  return null;
}

// Return { score, label, paths_evaluated, paths_unmatched } for a list of paths.
// `score` is the max across all paths. If no rule matches *any* path (e.g.
// the plan touches paths we don't have rules for), score defaults to 2
// (treat as source-level) on the conservative side, unless `paths` is empty
// in which case score is 0 (no paths -> no path-based risk to apply).
function riskForPaths(paths = []) {
  const normalized = (Array.isArray(paths) ? paths : []).map(normalizePath).filter(Boolean);
  if (normalized.length === 0) {
    return { score: 0, label: 'RISK_0_NO_PATHS', paths_evaluated: 0, paths_unmatched: 0, matched: [], unmatched: [] };
  }
  let maxScore = -1;
  let maxLabel = null;
  const matched = [];
  const unmatched = [];
  for (const p of normalized) {
    const r = riskForPath(p);
    if (r === null) {
      unmatched.push(p);
      continue;
    }
    matched.push({ path: p, score: r.score, label: r.label });
    if (r.score > maxScore) {
      maxScore = r.score;
      maxLabel = r.label;
    }
  }
  // Conservative default for unmatched paths: treat as source (Risk 2). This
  // is rare; rules above cover the common MCA + GHI layout. If an unmatched
  // path appears, the conservative default prevents autonomous loop from
  // touching uncategorized areas without surfacing.
  if (unmatched.length > 0) {
    if (maxScore < 2) {
      maxScore = 2;
      maxLabel = 'RISK_2_UNMATCHED_PATH';
    }
  }
  if (maxScore < 0) {
    maxScore = 0;
    maxLabel = 'RISK_0_NO_PATHS';
  }
  return {
    score: maxScore,
    label: maxLabel,
    paths_evaluated: normalized.length,
    paths_unmatched: unmatched.length,
    matched,
    unmatched
  };
}

// Collect all file paths a plan touches. Mirrors allPlannedFiles in
// risk-evaluator.js but also pulls from requested_paths (which the
// soak supplier and Telegram operators always populate).
function pathsFromPlan(plan = {}) {
  const arrays = [
    Array.isArray(plan?.requested_paths) ? plan.requested_paths : [],
    Array.isArray(plan?.planned_files) ? plan.planned_files : [],
    Array.isArray(plan?.files) ? plan.files : [],
    Array.isArray(plan?.migration_plan?.files) ? plan.migration_plan.files : [],
    Array.isArray(plan?.migration_files) ? plan.migration_files : []
  ];
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const normalized = normalizePath(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

module.exports = {
  PATH_RISK_RULES,
  normalizePath,
  riskForPath,
  riskForPaths,
  pathsFromPlan
};
