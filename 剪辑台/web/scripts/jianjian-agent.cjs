#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  STRATEGIES,
  Ledger,
  V1Provider,
  BatchOrchestrator,
  normalizeBatchPlan,
  OnboardingProvider,
  OnboardingRunner,
  validateOnboardingInput,
  assertSafetyGates,
  redactSecrets,
  sanitizeValue,
  stableHash,
} = require('../lib/jianjian-agent-core.cjs');

function parseArgs(argv) {
  const options = {
    dryRun: true,
    strategy: 'structure_first',
    claim: false,
    submit: false,
    allowProduction: false,
    approveClaim: false,
    approveSubmit: false,
    speakerCount: 2,
    maxPollAttempts: 20,
    pollIntervalMs: 1500,
    onboard: false,
  };
  const valueFlags = new Set([
    'base-url', 'task-id', 'task-ids', 'approved-task-ids', 'strategies', 'strategy-version',
    'token', 'strategy', 'ledger', 'checkpoint', 'input',
    'phone', 'otp', 'nickname', 'confirm-day1-hash',
    'speaker-count', 'max-poll-attempts', 'poll-interval-ms',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (valueFlags.has(name)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      index += 1;
      options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      continue;
    }
    if (name === 'execute') options.dryRun = false;
    else if (name === 'dry-run') options.dryRun = true;
    else if (name === 'onboard') options.onboard = true;
    else if ([
      'claim', 'submit', 'allow-production', 'approve-claim', 'approve-submit',
      'approve-send-code', 'approve-verify', 'approve-nickname', 'approve-day1', 'approve-day2-submit',
    ].includes(name)) {
      options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
    } else if (name === 'help') options.help = true;
    else throw new Error(`unknown option: --${name}`);
  }
  for (const key of ['speakerCount', 'maxPollAttempts', 'pollIntervalMs']) {
    options[key] = Number(options[key]);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/jianjian-agent.cjs --base-url URL [options]',
    '',
    'Default: dry run; performs no HTTP calls and no mutations.',
    '  --strategy structure_first|density_first|audience_retention',
    '  --task-ids a,b,c        Ordered batch of 3 to 5 distinct orders',
    '  --strategies a,b,c       Optional exact ordered strategy sequence',
    '  --approved-task-ids a,b,c  Must exactly match batch task IDs and order',
    '  --input FILE              Explicit local order fixture for dry-run inspection',
    '  --ledger FILE             Explicit ledger snapshot to validate/resume',
    '  --checkpoint FILE         Explicit execute-only checkpoint path (read/resume/write)',
    '  --execute                 Enable provider execution (provider wiring required)',
    '  --speaker-count N         DashScope speaker count (default 2)',
    '  --max-poll-attempts N     Bounded polling attempts (default 20)',
    '  --poll-interval-ms N      Poll delay in milliseconds (default 1500)',
    '  --allow-production        Required for production URLs',
    '  --claim --task-id ID --approve-claim',
    '  --submit --approve-submit',
    '  --token TOKEN             Explicit credential (or JIANJIAN_AGENT_TOKEN env)',
    '',
    'Onboarding (default is still dry-run):',
    '  --onboard --phone 138... --nickname 金钱剪剪',
    '  --approve-send-code       Explicit approval to send one SMS; never auto-retries',
    '  --otp 123456 --approve-verify',
    '  --approve-nickname',
    '  --approve-day1 --confirm-day1-hash HASH',
    '  --approve-day2-submit     Covers practice creation/edit/cut/QA/snapshot only',
    '  Existing --token resumes with GET /api/auth/me and does not send SMS.',
    '',
    'Examples:',
    '  node scripts/jianjian-agent.cjs --base-url http://8.136.133.196:8090 --onboard --phone 13800138000 --nickname 金钱剪剪',
    '  node scripts/jianjian-agent.cjs --base-url http://8.136.133.196:8090 --onboard --execute --phone 13800138000 --approve-send-code',
    '  node scripts/jianjian-agent.cjs --base-url http://8.136.133.196:8090 --onboard --execute --phone 13800138000 --otp 123456 --approve-verify --approve-nickname --approve-day1 --confirm-day1-hash HASH --approve-day2-submit',
  ].join('\n');
}

function readJson(file, label) {
  const resolved = path.resolve(file);
  let source;
  try { source = fs.readFileSync(resolved, 'utf8'); }
  catch (error) { throw new Error(`${label} unavailable: ${error.code || error.message}`); }
  try { return JSON.parse(source); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function run(options, dependencies = {}) {
  assertSafetyGates(options);
  const credential = options.token || process.env.JIANJIAN_AGENT_TOKEN || '';
  if (options.onboard) {
    const onboardingInput = validateOnboardingInput({ ...options, token: credential });
    const dryPlan = {
      mode: options.dryRun ? 'dry-run' : 'execute',
      onboarding: true,
      baseUrl: new URL(options.baseUrl).origin,
      credentialPresent: Boolean(credential),
      maskedPhone: credential ? null : `${onboardingInput.phone.slice(0, 3)}****${onboardingInput.phone.slice(-4)}`,
      nickname: onboardingInput.nickname,
      day1Text: {
        nickname: onboardingInput.intro.nickname,
        field1: onboardingInput.intro.field1,
        field2: onboardingInput.intro.field2,
        field3: onboardingInput.intro.field3,
        field4: onboardingInput.intro.field4,
      },
      day1ConfirmationHash: onboardingInput.intro.confirmationHash,
      requestedApprovals: {
        sendCode: Boolean(options.approveSendCode),
        verify: Boolean(options.approveVerify),
        nickname: Boolean(options.approveNickname),
        day1: Boolean(options.approveDay1),
        day2Submit: Boolean(options.approveDay2Submit),
      },
    };
    if (options.dryRun) return dryPlan;
    const checkpoint = async (snapshot) => {
      if (!options.checkpoint) return;
      fs.writeFileSync(path.resolve(options.checkpoint), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    };
    const provider = dependencies.onboardingProvider || new OnboardingProvider({
      baseUrl: options.baseUrl,
      token: credential,
      fetchImpl: dependencies.fetchImpl,
      maxPollAttempts: options.maxPollAttempts,
      pollIntervalMs: options.pollIntervalMs,
      sleep: dependencies.sleep,
    });
    const runner = dependencies.onboardingRunner || new OnboardingRunner({ provider, checkpoint });
    return runner.run({ ...options, token: credential });
  }
  const batchMode = Boolean(options.taskIds);
  const batchPlan = batchMode ? normalizeBatchPlan(options) : null;
  if (!STRATEGIES[options.strategy]) throw new Error(`unknown strategy: ${options.strategy}`);
  if (!options.dryRun && !credential) {
    const error = new Error('execute requires an explicit token or JIANJIAN_AGENT_TOKEN');
    error.code = 'CREDENTIAL_REQUIRED';
    throw error;
  }
  if (!options.dryRun && !options.taskId && !batchMode) {
    const error = new Error('execute requires --task-id or --task-ids');
    error.code = 'TASK_ID_REQUIRED';
    throw error;
  }
  if (!options.dryRun && !options.submit) {
    const error = new Error('execute requires --submit and --approve-submit');
    error.code = 'SUBMIT_APPROVAL_REQUIRED';
    throw error;
  }
  if (!options.dryRun && batchMode && (!options.claim || !options.approveClaim)) {
    const error = new Error('batch execute requires --claim and --approve-claim');
    error.code = 'CLAIM_APPROVAL_REQUIRED';
    throw error;
  }
  const ledgerOptions = { knownSecrets: [credential].filter(Boolean) };
  const resumePath = options.checkpoint || options.ledger;
  const resumeSnapshot = resumePath && fs.existsSync(path.resolve(resumePath)) ? readJson(resumePath, batchMode ? 'batch checkpoint' : 'ledger') : null;
  const ledger = batchMode ? null : new Ledger(resumeSnapshot, ledgerOptions);
  const input = options.input ? readJson(options.input, 'input') : dependencies.inputArtifact || null;
  const plan = {
    mode: options.dryRun ? 'dry-run' : 'execute',
    baseUrl: new URL(options.baseUrl).origin,
    strategy: options.strategy,
    taskId: options.taskId || null,
    batch: batchPlan,
    requested: { claim: options.claim, submit: options.submit },
    credentialPresent: Boolean(credential),
    resumeState: batchMode ? (resumeSnapshot && resumeSnapshot.state || null) : ledger.current,
    inputHash: input == null ? null : stableHash(input),
    nextState: batchMode ? (resumeSnapshot ? resumeSnapshot.nextTaskId || null : batchPlan.taskIds[0]) : ledger.current == null ? 'AUTHED' : null,
  };
  if (options.dryRun) return plan;
  const checkpoint = async (snapshot) => {
    if (!options.checkpoint) return;
    fs.writeFileSync(path.resolve(options.checkpoint), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  };
  const provider = dependencies.provider || new V1Provider({
    baseUrl: options.baseUrl,
    token: credential,
    fetchImpl: dependencies.fetchImpl,
    maxPollAttempts: options.maxPollAttempts,
    pollIntervalMs: options.pollIntervalMs,
    sleep: dependencies.sleep,
    checkpoint: batchMode ? async () => {} : checkpoint,
  });
  if (!provider || typeof provider.run !== 'function') {
    const error = new Error('V1 provider is unavailable');
    error.code = 'PROVIDER_MISSING';
    throw error;
  }
  if (batchMode) {
    const orchestrator = dependencies.batchOrchestrator || new BatchOrchestrator({ provider, checkpoint });
    return orchestrator.run(batchPlan, resumeSnapshot);
  }
  return provider.run({
    ...options,
    credential,
    ledger,
    input,
    speakerCount: options.speakerCount,
  });
}

function serializeSuccessResult(result, knownSecrets = []) {
  return JSON.stringify(sanitizeValue(result, knownSecrets), null, 2);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = await run(options, dependencies);
    const explicitSecrets = [options.token, process.env.JIANJIAN_AGENT_TOKEN].filter(Boolean);
    process.stdout.write(`${serializeSuccessResult(result, explicitSecrets)}\n`);
    return 0;
  } catch (error) {
    const explicitSecrets = [options && options.token, process.env.JIANJIAN_AGENT_TOKEN].filter(Boolean);
    process.stderr.write(`${redactSecrets(error && error.message || String(error), explicitSecrets)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, run, main, usage, serializeSuccessResult };
