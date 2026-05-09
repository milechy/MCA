const { test, expect } = require('@playwright/test');

const { buildUltraPlan, runUltraPlan, runUltraPlanWithProvider } = require('../../src/ralph/ultraplan-runner');
const {
  canonicalizeUltraPlan,
  taskRequestsForbiddenAction
} = require('../../src/ralph/ultraplan-schema');
const {
  deterministicUltraPlanProvider,
  generateUltraPlanWithProvider,
  llmProviderPreflight,
  PROVIDER_MODES
} = require('../../src/ralph/ultraplan-provider');

const story = {
  story_id: 'STORY-ULTRAPLAN-PROVIDER',
  title: 'Add richer planning provider',
  requirement: 'Add tests for Ralph UltraPlan provider boundary.',
  mode: 'approval',
  target_env: 'local',
  requested_paths: ['src/ralph/ultraplan-provider.js', 'tests/ralph/ultraplan-provider.spec.js']
};

test('deterministic provider remains the default and matches buildUltraPlan', async () => {
  const expected = buildUltraPlan(story);
  const result = await generateUltraPlanWithProvider(story);

  expect(result).toMatchObject({
    ok: true,
    stage: 'ultraplan_provider',
    provider: PROVIDER_MODES.DETERMINISTIC,
    fallback_used: false,
    plan_hash: expected.plan_hash,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
  expect(result.plan).toEqual(expected);
});

test('llm provider can be injected and canonicalized behind preflight', async () => {
  const provider = async ({ deterministic_plan }) => ({
    plan: {
      ...deterministic_plan,
      generated_by: 'fixture-provider',
      model_response_id: 'response-id-ignored-by-hash',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Analyze provider surface',
          objective: 'Inspect planning provider seams without executing repository mutations.',
          requested_paths: ['src/ralph/ultraplan-provider.js'],
          expected_output: 'provider plan summary',
          agent: 'ralph'
        }
      ]
    }
  });

  const result = await generateUltraPlanWithProvider(story, {
    provider,
    providerMode: PROVIDER_MODES.LLM,
    apiKey: 'fixture-key'
  });

  expect(result).toMatchObject({
    ok: true,
    provider: PROVIDER_MODES.LLM,
    fallback_used: false,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
  expect(result.plan.tasks).toHaveLength(1);
  expect(result.plan.tasks[0]).toMatchObject({ id: 'TASK-001', agent: 'ralph' });
  expect(result.plan.generated_by).toBeUndefined();
  expect(result.plan.model_response_id).toBeUndefined();
});

test('canonical plan hash remains stable for semantically identical canonical plans', () => {
  const base = buildUltraPlan(story);
  const withVolatileFields = {
    ...base,
    generated_by: 'llm-a',
    trace_id: 'trace-1',
    latency_ms: 1234,
    tasks: base.tasks.map((task) => ({ ...task }))
  };

  const first = canonicalizeUltraPlan(withVolatileFields, base);
  const second = canonicalizeUltraPlan({ ...withVolatileFields, trace_id: 'trace-2', latency_ms: 9999 }, base);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(first.plan.plan_hash).toBe(second.plan.plan_hash);
});

test('malformed llm output falls back to deterministic plan', async () => {
  const fallback = buildUltraPlan(story);
  const result = await generateUltraPlanWithProvider(story, {
    provider: async () => ({ plan: { story_id: story.story_id, tasks: [] } }),
    providerMode: PROVIDER_MODES.LLM,
    apiKey: 'fixture-key'
  });

  expect(result).toMatchObject({
    ok: true,
    fallback_used: true,
    fallback_reason: 'requirement_required',
    plan_hash: fallback.plan_hash
  });
});

test('missing llm secret/env falls back to deterministic provider', async () => {
  const fallback = buildUltraPlan(story);
  const result = await generateUltraPlanWithProvider(story, {
    provider: async () => { throw new Error('should_not_call_provider'); },
    providerMode: PROVIDER_MODES.LLM,
    apiKey: null
  });

  expect(result).toMatchObject({
    ok: true,
    fallback_used: true,
    fallback_reason: 'llm_api_key_missing',
    plan_hash: fallback.plan_hash
  });
});

test('provider failure falls back to deterministic plan', async () => {
  const fallback = buildUltraPlan(story);
  const result = await generateUltraPlanWithProvider(story, {
    provider: async () => { throw new Error('provider_unavailable'); },
    providerMode: PROVIDER_MODES.LLM,
    apiKey: 'fixture-key'
  });

  expect(result).toMatchObject({
    ok: true,
    fallback_used: true,
    fallback_reason: 'provider_unavailable',
    plan_hash: fallback.plan_hash
  });
});

test('llm provider cannot request direct apply commit push PR deploy or migration actions', async () => {
  const fallback = buildUltraPlan(story);
  const unsafeTask = {
    id: 'TASK-999',
    title: 'Directly push and create PR',
    objective: 'Commit the patch, push the branch, create PR, deploy production, and run migration.',
    requested_paths: ['src/ralph/ultraplan-provider.js'],
    expected_output: 'merged production change',
    agent: 'llm'
  };

  expect(taskRequestsForbiddenAction(unsafeTask)).toBe(true);

  const result = await generateUltraPlanWithProvider(story, {
    provider: async ({ deterministic_plan }) => ({
      plan: { ...deterministic_plan, tasks: [unsafeTask] }
    }),
    providerMode: PROVIDER_MODES.LLM,
    apiKey: 'fixture-key'
  });

  expect(result).toMatchObject({
    ok: true,
    fallback_used: true,
    fallback_reason: 'task_requests_forbidden_direct_action',
    plan_hash: fallback.plan_hash
  });
});

test('runUltraPlan remains deterministic while runUltraPlanWithProvider can use optional provider result', async () => {
  const deterministic = runUltraPlan(story);
  const providerRunner = await runUltraPlanWithProvider(story, {
    provider: async ({ deterministic_plan }) => ({
      plan: {
        ...deterministic_plan,
        tasks: [
          {
            id: 'TASK-010',
            title: 'Plan provider tests',
            objective: 'Prepare bounded provider validation tasks only.',
            requested_paths: ['tests/ralph/ultraplan-provider.spec.js'],
            expected_output: 'test plan',
            agent: 'ralph'
          }
        ]
      }
    }),
    providerMode: PROVIDER_MODES.LLM,
    apiKey: 'fixture-key'
  });

  expect(deterministic.provider).toBe('deterministic');
  expect(providerRunner).toMatchObject({
    ok: true,
    stage: 'ultraplan_runner',
    provider: PROVIDER_MODES.LLM,
    fallback_used: false,
    execution_connected: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
  expect(providerRunner.tasks.map((task) => task.id)).toEqual(['TASK-010']);
});

test('llmProviderPreflight requires explicit enablement and secret', () => {
  expect(llmProviderPreflight({ enabled: false, apiKey: 'fixture-key' })).toMatchObject({ ok: false, reason: 'llm_provider_not_enabled' });
  expect(llmProviderPreflight({ enabled: true, apiKey: null })).toMatchObject({ ok: false, reason: 'llm_api_key_missing' });
  expect(llmProviderPreflight({ enabled: true, apiKey: 'fixture-key' })).toMatchObject({ ok: true });
});

test('deterministicUltraPlanProvider exposes deterministic plan without execution connectivity', () => {
  const result = deterministicUltraPlanProvider(story);
  expect(result).toMatchObject({
    ok: true,
    provider: PROVIDER_MODES.DETERMINISTIC,
    fallback_used: false
  });
  expect(result.plan.plan_hash).toBe(buildUltraPlan(story).plan_hash);
});
