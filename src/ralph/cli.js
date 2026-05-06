#!/usr/bin/env node
const fs = require('node:fs');
const { evaluateRisk, decideControlAction, targetEnv } = require('./risk-evaluator');
const { createApproval, approveApproval, denyApproval, supersedeApprovalForModify, expirePendingApprovals } = require('./approval-manager');
const { phaseForControlDecision, transitionState, triggerSecurityStop, loadState } = require('./state-machine');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function usage() {
  console.log(`Ralph CLI

Commands:
  node src/ralph/cli.js risk <plan.json>
  node src/ralph/cli.js create-approval <plan.json>
  node src/ralph/cli.js approve <approval_id> <user_id> <plan.json>
  node src/ralph/cli.js deny <approval_id> <user_id>
  node src/ralph/cli.js modify <approval_id> <instruction>
  node src/ralph/cli.js expire
  node src/ralph/cli.js state
`);
}

function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'state') {
    console.log(JSON.stringify(loadState(), null, 2));
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

module.exports = { main };
