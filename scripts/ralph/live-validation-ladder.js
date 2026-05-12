#!/usr/bin/env node

const LADDER_VERSION = 'ralph_live_validation_ladder_v0_1';

const LEVELS = Object.freeze({
  0: {
    name: 'local_deterministic_smoke',
    purpose: 'Verify lifecycle routing without provider, network, push, or PR side effects.',
    command: 'npm run ralph:issue-to-pr-smoke',
    env_gate: null,
    allowed_side_effects: ['temporary .ralph runtime under test root'],
    forbidden_side_effects: ['provider_call', 'network_call', 'git_push', 'github_pr_create', 'merge', 'deploy', 'migration'],
    pass_evidence: ['ok=true', 'final_story.current_phase=DONE', 'push_performed=false', 'pr_created=false']
  },
  1: {
    name: 'live_provider_patch_only',
    purpose: 'Validate live provider/NemoClaw candidate.patch generation while stopping before apply.',
    command: 'RALPH_LIVE_VALIDATION_LEVEL=1 npm run ralph:real-external-agent-smoke',
    env_gate: 'RALPH_LIVE_VALIDATION_LEVEL=1',
    allowed_side_effects: ['provider_call', 'sandbox candidate.patch'],
    forbidden_side_effects: ['repository_source_modification', 'apply', 'commit', 'git_push', 'github_pr_create', 'merge', 'deploy', 'migration'],
    pass_evidence: ['candidate_patch_path=.ralph/tmp/.../candidate.patch', 'working_tree_clean_after=true', 'apply_allowed=false']
  },
  2: {
    name: 'live_provider_apply_gates_commit_local_only',
    purpose: 'Validate patch quality, apply path, gates, and local commit without remote push.',
    command: 'Use a ralph-ready sandbox issue; approve through commit only; stop before push approval.',
    env_gate: 'RALPH_LIVE_VALIDATION_LEVEL=2',
    allowed_side_effects: ['provider_call', 'repository_apply', 'local_gates', 'local_commit'],
    forbidden_side_effects: ['git_push', 'github_pr_create', 'merge', 'deploy', 'migration'],
    pass_evidence: ['gates ok=true', 'commit_created=true', 'push_performed=false', 'pr_created=false']
  },
  3: {
    name: 'live_push_test_branch_no_pr',
    purpose: 'Validate explicit push approval and remote branch write to a test branch only.',
    command: 'Use a sandbox branch prefix; approve push; stop before PR approval.',
    env_gate: 'RALPH_LIVE_VALIDATION_LEVEL=3',
    allowed_side_effects: ['provider_call', 'repository_apply', 'local_commit', 'git_push_to_test_branch'],
    forbidden_side_effects: ['github_pr_create', 'merge', 'deploy', 'migration'],
    pass_evidence: ['push_performed=true', 'remote branch created/updated', 'pr_created=false']
  },
  4: {
    name: 'live_pr_sandbox_no_merge',
    purpose: 'Validate explicit PR approval and GitHub PR creation in sandbox scope.',
    command: 'Use sandbox issue/repo or ralph-smoke label; approve PR; do not merge.',
    env_gate: 'RALPH_LIVE_VALIDATION_LEVEL=4',
    allowed_side_effects: ['provider_call', 'repository_apply', 'local_commit', 'git_push_to_test_branch', 'github_pr_create'],
    forbidden_side_effects: ['merge', 'deploy', 'migration'],
    pass_evidence: ['pr_created=true', 'pr_url present', 'merge_performed=false']
  },
  5: {
    name: 'real_issue_canary_batch',
    purpose: 'Run 3-10 bounded real issues to measure success rate, review load, and repair behavior.',
    command: 'Select labeled low-risk issues; run with approval boundaries; merge remains human-only.',
    env_gate: 'RALPH_LIVE_VALIDATION_LEVEL=5',
    allowed_side_effects: ['provider_call', 'repository_apply', 'local_commit', 'git_push_to_test_branch', 'github_pr_create'],
    forbidden_side_effects: ['auto_merge', 'deploy', 'migration', 'production_db_change'],
    pass_evidence: ['success_rate recorded', 'failure taxonomy recorded', 'review burden recorded', 'no policy violations']
  }
});

function parseArgs(argv = process.argv.slice(2)) {
  const options = { level: null, json: false, assert_gate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--level') options.level = Number(argv[index += 1]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--assert-gate') options.assert_gate = true;
  }
  return options;
}

function levelGateSatisfied(level, env = process.env) {
  if (level === 0) return true;
  return String(env.RALPH_LIVE_VALIDATION_LEVEL || '') === String(level);
}

function summarizeLevel(level, env = process.env) {
  const spec = LEVELS[level];
  if (!spec) return null;
  return {
    level,
    ...spec,
    gate_satisfied: levelGateSatisfied(level, env),
    next_action: levelGateSatisfied(level, env) ? 'run_level_command_and_record_evidence' : `set_RALPH_LIVE_VALIDATION_LEVEL_${level}_only_when_ready`
  };
}

function runLadder(options = parseArgs(), env = process.env) {
  const levels = options.level === null
    ? Object.keys(LEVELS).map(Number)
    : [options.level];
  const summaries = levels.map((level) => summarizeLevel(level, env)).filter(Boolean);
  if (summaries.length === 0) {
    return {
      ok: false,
      stage: 'ralph_live_validation_ladder',
      version: LADDER_VERSION,
      reason: 'level_not_found',
      requested_level: options.level,
      levels: [],
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: [],
      next_action: 'choose_level_0_to_5'
    };
  }
  const gatesOk = summaries.every((item) => item.gate_satisfied);
  const ok = options.assert_gate ? gatesOk : true;
  return {
    ok,
    stage: 'ralph_live_validation_ladder',
    version: LADDER_VERSION,
    reason: ok ? null : 'required_live_validation_gate_not_set',
    levels: summaries,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    next_action: ok ? 'follow_ladder_one_level_at_a_time' : 'set_explicit_live_validation_gate_or_lower_level'
  };
}

function renderMarkdown(result) {
  const lines = ['# Ralph live validation ladder', ''];
  for (const level of result.levels) {
    lines.push(`## Level ${level.level}: ${level.name}`);
    lines.push('');
    lines.push(`Purpose: ${level.purpose}`);
    lines.push('');
    lines.push(`Command: \`${level.command}\``);
    lines.push(`Env gate: ${level.env_gate ? `\`${level.env_gate}\`` : 'none'}`);
    lines.push(`Gate satisfied: ${level.gate_satisfied ? 'yes' : 'no'}`);
    lines.push('');
    lines.push(`Allowed side effects: ${level.allowed_side_effects.join(', ')}`);
    lines.push(`Forbidden side effects: ${level.forbidden_side_effects.join(', ')}`);
    lines.push(`Pass evidence: ${level.pass_evidence.join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const options = parseArgs();
  const result = runLadder(options);
  console.log(options.json ? JSON.stringify(result, null, 2) : renderMarkdown(result));
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  LADDER_VERSION,
  LEVELS,
  parseArgs,
  levelGateSatisfied,
  summarizeLevel,
  runLadder,
  renderMarkdown
};
