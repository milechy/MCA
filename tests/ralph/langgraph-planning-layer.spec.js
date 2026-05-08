const { test, expect } = require('@playwright/test');

const { PLANNING_NODES, canonicalJson, sha256Json, normalizeStory, buildPlanDraft, routeForDecision, createPlanningGraph } = require('../../src/ralph/langgraph-planning-layer');

test('canonicalJson and sha256Json are deterministic for plan_hash', () => {
  const a = { b: 2, a: 1, nested: { z: true, c: null } };
  const b = { nested: { c: null, z: true }, a: 1, b: 2 };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(sha256Json(a)).toBe(sha256Json(b));
  expect(sha256Json(a)).toMatch(/^sha256:[a-f0-9]{64}$/);
});

test('normalizeStory and buildPlanDraft preserve constraints and forbidden actions', () => {
  const story = normalizeStory({ story_id: 'STORY-1', title: 'Add thing', prompt: 'Do work\nnow', requested_paths: ['src/a.js'], constraints: ['no DB'] });
  const plan = buildPlanDraft(story);
  expect(story).toMatchObject({ story_id: 'STORY-1', title: 'Add thing', objective: 'Do work now', requested_paths: ['src/a.js'] });
  expect(plan).toMatchObject({ story_id: 'STORY-1', planned_files: ['src/a.js'], constraints: ['no DB'] });
  expect(plan.acceptance_criteria).toContain('Generated diff must be separately reviewed before apply/commit/push/PR.');
  expect(plan.forbidden_actions).toContain('git reset --hard');
});

test('routeForDecision maps control decisions to approval, execution, or stop nodes', () => {
  expect(routeForDecision({ action: 'auto_execute' })).toMatchObject({ next_node: PLANNING_NODES.EXECUTION_HANDOFF });
  expect(routeForDecision({ action: 'require_plan_approval', reason: 'x' })).toMatchObject({ next_node: PLANNING_NODES.APPROVAL_ROUTING, approval_type: 'plan' });
  expect(routeForDecision({ action: 'require_diff_approval', reason: 'x' })).toMatchObject({ next_node: PLANNING_NODES.APPROVAL_ROUTING, approval_type: 'diff' });
  expect(routeForDecision({ action: 'stop', reason: 'risk_5' })).toMatchObject({ next_node: PLANNING_NODES.STOP });
});

test('createPlanningGraph returns non-executing bounded planning graph', () => {
  const graph = createPlanningGraph({ story_id: 'STORY-2', title: 'Add test', objective: 'Add one test', requested_paths: ['tests/foo.spec.js'], mode: 'approval' });
  expect(graph).toMatchObject({
    ok: true,
    stage: 'langgraph_planning_layer',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
  expect(graph.nodes).toEqual(['intake', 'plan', 'risk_evaluation', 'control_decision', 'approval_routing', 'execution_handoff']);
  expect(graph.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
});

test('createPlanningGraph routes production migration through approval and not execution', () => {
  const graph = createPlanningGraph({ story_id: 'STORY-DB', target_env: 'production', objective: 'Add migration', requested_paths: ['supabase/migrations/001_add.sql'], mode: 'fullauto' });
  expect(graph.production_policy.plan_approval_required).toBe(true);
  expect(graph.production_policy.diff_approval_required).toBe(true);
  expect(graph.control_decision.action).toBe('require_diff_approval');
  expect(graph.route).toMatchObject({ next_node: PLANNING_NODES.APPROVAL_ROUTING, approval_type: 'diff' });
  expect(graph.next_action).toBe('create_required_approval');
});
