#!/usr/bin/env node
const fs = require('node:fs');
const { evaluateRisk, decideControlAction, targetEnv } = require('./risk-evaluator');
const { createApproval, approveApproval, approveApprovalRecordOnly, denyApproval, supersedeApprovalForModify, expirePendingApprovals } = require('./approval-manager');
const { phaseForControlDecision, transitionState, triggerSecurityStop, loadState } = require('./state-machine');
const { loadRoles } = require('./roles');
const { loadMode, requestFullautoMode, confirmFullautoMode, setApprovalMode, autoRevertExpiredMode } = require('./mode-manager');
const { dryRunApprovalCommand } = require('./approval-validator');
const { runExecutionHarness } = require('./execution-harness');
const { dryRunShellCommand } = require('./shell-dry-run');
const { runShellDryRunWithPreflight } = require('./shell-preflight-wrapper');
const { runAllApprovedSmoke } = require('./run-all-smoke-helper');
const { describeGateSequence, runGateSequence } = require('./gate-runner');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function usage() {
  console.log(`Ralph CLI

Commands:
  node src/ralph/cli.js risk <plan.json>
  node src/ralph/cli.js create-approval <plan.json>
  node src/ralph/cli.js approve <approval_id> <user_id> <plan.json>
  node src/ralph/cli.js approve-record-only <approval_id> <user_id>
  node src/ralph/cli.js approval-dry-run <approve|deny|modify> <approval_id> <user_id>
  node src/ralph/cli.js execute-noop <approval_id> <plan.json> [--current-diff-hash sha256:...]
  node src/ralph/cli.js gate-runner [--describe]
  node src/ralph/cli.js shell-dry-run <command>
  node src/ralph/cli.js shell-dry-run-approved <approval_id> <plan.json> <command> [--current-diff-hash sha256:...]
  node src/ralph/cli.js smoke-run-all-approved <approval_id> <plan.json> [--current-diff-hash sha256:...]
  node src/ralph/cli.js deny <approval_id> <user_id>
  node src/ralph/cli.js modify <approval_id> <instruction>
  node src/ralph/cli.js expire
  node src/ralph/cli.js state
  node src/ralph/cli.js mode
  node src/ralph/cli.js mode approval <user_id>
  node src/ralph/cli.js mode fullauto-request <user_id> [hours]
  node src/ralph/cli.js mode fullauto-confirm <token> <user_id>
  node src/ralph/cli.js mode auto-revert
`);
}

function handleModeCommand(args) {
  const [subcommand, ...rest] = args;
  const roles = loadRoles();

  if (!subcommand) {
    console.log(JSON.stringify(loadMode(), null, 2));
    return;
  }

  if (subcommand === 'approval') {
    const [userId] = rest;
    console.log(JSON.stringify(setApprovalMode(Number(userId), { roles }), null, 2));
    return;
  }

  if (subcommand === 'fullauto-request') {
    const [userId, hours] = rest;
    console.log(JSON.stringify(requestFullautoMode(Number(userId), { roles, hours: hours ? Number(hours) : undefined }), null, 2));
    return;
  }

  if (subcommand === 'fullauto-confirm') {
    const [token, userId] = rest;
    console.log(JSON.stringify(confirmFullautoMode(token, Number(userId), { roles }), null, 2));
    return;
  }

  if (subcommand === 'auto-revert') {
    console.log(JSON.stringify(autoRevertExpiredMode(), null, 2));
    return;
  }

  usage();
  process.exitCode = 1;
}

function handleGateRunnerCommand(args, options = {}) {
  if (args.includes('--describe')) {
    const result = {
      ok: true,
      stage: 'ralph_gate_runner_manifest',
      gates: describeGateSequence(),
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      repository_files_modified: [],
      commit_created: false,
      push_performed: false,
      pr_created: false,
      merge_performed: false,
      deploy_performed: false,
      migration_performed: false
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const result = runGateSequence({
    rootDir: options.rootDir || process.cwd(),
    env: options.env || process.env,
    spawn: options.spawn,
    timeout_ms: options.timeout_ms
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

function main(argv = process.argv.slice(2), options = {}) {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'state') {
    console.log(JSON.stringify(loadState(), null, 2));
    return;
  }

  if (command === 'mode') {
    handleModeCommand(args);
    return;
  }

  if (command === 'gate-runner') {
    handleGateRunnerCommand(args, options);
    return;
  }

  if (command === 'risk') {
    const plan = readJson(args[0]);
    const risk = evaluateRisk(plan);
    const decision = decideControlAction(risk, plan.mode || 'approval', targetEnv(plan));
    console.log(JSON.stringify({ risk, decision }, null, 2));
    return;
  }

  if (command === 'create-approval') {
    const plan = readJson(args[0]);
    const risk = evaluateRisk(plan);
    const decision = decideControlAction(risk, plan.mode || 'approval', targetEnv(plan));

    if (decision.action === 'stop') {
      triggerSecurityStop(decision.reason);
      console.log(JSON.stringify({ decision, status: 'security_stop' }, null, 2));
      return;
    }

    const approval = createApproval(plan, risk, {
      approval_type: decision.action === 'require_diff_approval' ? 'diff' : 'plan',
      requested_action: decision.action,
      allowed_user_ids: plan.allowed_user_ids || []
    });

    const nextPhase = phaseForControlDecision(decision);
    try {
      transitionState(nextPhase, { current_approval_id: approval.approval_id, reason: decision.reason });
    } catch (error) {
      // The CLI may be used before the state machine is in RISK_ASSESSMENT. Approval creation should still be testable.
    }

    console.log(JSON.stringify({ approval, decision }, null, 2));
    return;
  }

  if (command === 'approval-dry-run') {
    const [action, approvalId, userId] = args;
    console.log(JSON.stringify(dryRunApprovalCommand(action, approvalId, Number(userId)), null, 2));
    return;
  }

  if (command === 'approve-record-only') {
    const [approvalId, userId] = args;
    console.log(JSON.stringify(approveApprovalRecordOnly(approvalId, Number(userId), { channel: 'cli' }), null, 2));
    return;
  }

  if (command === 'execute-noop') {
    const [approvalId, planPath] = args;
    const plan = readJson(planPath);
    console.log(JSON.stringify(runExecutionHarness(approvalId, plan, {
      executor: 'noop',
      current_diff_hash: optionValue(args, '--current-diff-hash')
    }), null, 2));
    return;
  }

  if (command === 'shell-dry-run') {
    const [shellCommand] = args;
    console.log(JSON.stringify(dryRunShellCommand({ command: shellCommand, args: [], cwd: '.' }), null, 2));
    return;
  }

  if (command === 'shell-dry-run-approved') {
    const [approvalId, planPath, shellCommand] = args;
    const plan = readJson(planPath);
    console.log(JSON.stringify(runShellDryRunWithPreflight(approvalId, plan, {
      command: shellCommand,
      args: [],
      cwd: '.'
    }, {
      current_diff_hash: optionValue(args, '--current-diff-hash')
    }), null, 2));
    return;
  }

  if (command === 'smoke-run-all-approved') {
    const [approvalId, planPath] = args;
    const plan = readJson(planPath);
    console.log(JSON.stringify(runAllApprovedSmoke(approvalId, plan, {
      current_diff_hash: optionValue(args, '--current-diff-hash')
    }), null, 2));
    return;
  }

  if (command === 'approve') {
    const [approvalId, userId, planPath] = args;
    const plan = readJson(planPath);
    console.log(JSON.stringify(approveApproval(approvalId, Number(userId), plan), null, 2));
    return;
  }

  if (command === 'deny') {
    const [approvalId, userId] = args;
    console.log(JSON.stringify(denyApproval(approvalId, Number(userId)), null, 2));
    return;
  }

  if (command === 'modify') {
    const [approvalId, ...instructionParts] = args;
    const instruction = instructionParts.join(' ');
    console.log(JSON.stringify(supersedeApprovalForModify(approvalId, instruction), null, 2));
    return;
  }

  if (command === 'expire') {
    console.log(JSON.stringify(expirePendingApprovals(), null, 2));
    return;
  }

  usage();
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { main, optionValue, handleGateRunnerCommand };
