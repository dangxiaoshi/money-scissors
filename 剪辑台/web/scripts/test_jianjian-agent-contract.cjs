'use strict';

const assert = require('node:assert/strict');
const {
  STRATEGIES,
  PLANNER_SCHEMA,
  LEDGER_STATES,
  Ledger,
  V1Provider,
  BatchOrchestrator,
  normalizeBatchPlan,
  WAITING_FOR_TA,
  CLAIM_DEADLINE_MS,
  assertClaimDeadline,
  buildSuspiciousBoundaryChecklist,
  generateDay1Intro,
  OnboardingProvider,
  OnboardingRunner,
  ONBOARDING_WAITING_FOR_OTP,
  dashscopeToV1S,
  outputQa,
  normalizeRequirements,
  chunkTranscript,
  buildPlannerPrompt,
  injectPriorFeedback,
  validatePlannerOutput,
  decisionsToArtifacts,
  mergeSegments,
  qaPlan,
  buildAuditRecord,
  sanitizeLedgerMetadata,
  redactSecrets,
  isProductionUrl,
  assertSafetyGates,
  reconcileBeforeCreate,
  snapshotBeforeMutation,
} = require('../lib/jianjian-agent-core.cjs');
const { parseArgs, run, main, serializeSuccessResult } = require('./jianjian-agent.cjs');

const transcript = [
  { idx: 0, sp: '主持人', t: '欢迎来到节目。', s: 0, e: 2, w: [{ t: '欢迎', s: 0, e: 0.8 }, { t: '来到', s: 0.8, e: 1.3 }, { t: '节目。', s: 1.3, e: 2 }] },
  { idx: 1, sp: '嘉宾', t: '必须保留这个核心观点。', s: 2.05, e: 6, w: [{ t: '必须保留', s: 2.05, e: 3.5 }, { t: '这个核心观点。', s: 3.5, e: 6 }] },
  { idx: 2, sp: '嘉宾', t: '嗯嗯这句必须删除。', s: 6.08, e: 9, w: [{ t: '嗯嗯', s: 6.08, e: 6.8 }, { t: '这句必须删除。', s: 6.8, e: 9 }] },
  { idx: 3, sp: '主持人', t: '最后给听众一个行动建议。', s: 9.2, e: 13 },
];

const requirements = normalizeRequirements({
  must_keep: [{ id: 'keep-core', text: '核心观点' }],
  requiredDelete: [{ id: 'delete-filler', text: '嗯嗯' }],
  target_duration: { min: 9, max: 13 },
  deliveryFormats: ['mp3', 'wav', 'mp3'],
});

function fullPlan(strategy = 'structure_first') {
  return {
    strategy,
    decisions: [
      { action: 'keep', sentenceIdx: 0, scope: 'full', reason: '保留开场', requirementIds: [] },
      { action: 'keep', sentenceIdx: 1, scope: 'full', reason: '硬性保留', requirementIds: ['keep-core'] },
      { action: 'delete', sentenceIdx: 2, scope: 'partial', cs: 0, ce: 2, reason: '删除口头填充', requirementIds: ['delete-filler'] },
      { action: 'keep', sentenceIdx: 3, scope: 'full', reason: '保留结尾', requirementIds: [] },
    ],
  };
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

(async () => {
  await test('three named strategies', () => {
    assert.deepEqual(Object.keys(STRATEGIES), ['structure_first', 'density_first', 'audience_retention']);
    for (const strategy of Object.keys(STRATEGIES)) {
      const prompt = buildPlannerPrompt({ strategy, chunk: chunkTranscript(transcript)[0], requirements });
      assert.match(prompt[0].content, new RegExp(STRATEGIES[strategy].instruction.slice(0, 4)));
    }
  });

  await test('requirement order and formats normalize', () => {
    assert.equal(requirements.mustKeep[0].id, 'keep-core');
    assert.equal(requirements.mustDelete[0].id, 'delete-filler');
    assert.deepEqual(requirements.formats, ['mp3', 'wav']);
    assert.deepEqual(requirements.targetDuration, { min: 9, max: 13 });
  });

  await test('deterministic chunks cover middle without gaps', () => {
    const long = Array.from({ length: 30 }, (_, idx) => ({ idx, t: `句子${idx}${'字'.repeat(30)}`, s: idx, e: idx + 0.9 }));
    const first = chunkTranscript(long, { maxChars: 200 });
    const second = chunkTranscript(long, { maxChars: 200 });
    assert.deepEqual(first, second);
    assert.deepEqual(first.flatMap((chunk) => chunk.sentenceIds), long.map((sentence) => sentence.idx));
    assert.ok(first.length > 2);
  });

  await test('prompt carries strict schema', () => {
    const prompt = buildPlannerPrompt({ strategy: 'structure_first', chunk: chunkTranscript(transcript)[0], requirements });
    assert.match(prompt[0].content, /additionalProperties/);
    assert.equal(PLANNER_SCHEMA.additionalProperties, false);
  });

  await test('planner validation and must-keep fail closed', () => {
    const valid = validatePlannerOutput(fullPlan(), { transcript, requirements });
    assert.equal(valid.decisions.length, 4);
    const bad = fullPlan();
    bad.decisions[1] = { action: 'delete', sentenceIdx: 1, scope: 'full', reason: '误删', requirementIds: [] };
    assert.throws(() => validatePlannerOutput(bad, { transcript, requirements }), (error) => error.code === 'MUST_KEEP_VIOLATION');
    assert.throws(() => validatePlannerOutput({ strategy: 'structure_first', decisions: [] }, { transcript, requirements }), /cover/);
    const partlyUnresolved = normalizeRequirements({
      mustKeep: [
        { id: 'resolved', text: '核心观点' },
        { id: 'unresolved', text: '逐字稿里不存在的硬性保留内容' },
      ],
    });
    assert.throws(
      () => validatePlannerOutput(fullPlan(), { transcript, requirements: partlyUnresolved }),
      (error) => error.code === 'MUST_KEEP_UNRESOLVED' && /unresolved/.test(error.message)
    );
  });

  await test('V1 editState and cutPayload formats', () => {
    const valid = validatePlannerOutput(fullPlan(), { transcript, requirements });
    const artifacts = decisionsToArtifacts({ transcript, decisions: valid.decisions, audioUrl: '/audio.m4a' });
    assert.deepEqual(artifacts.editState.d, []);
    assert.deepEqual(Object.keys(artifacts.editState.p), ['2']);
    assert.deepEqual(Object.keys(artifacts.editState.p[2][0]), ['cs', 'ce', 's', 'e']);
    assert.deepEqual(Object.keys(artifacts.cutPayload.segments[0]), ['start', 'end']);
  });

  await test('merge overlaps and gaps at most 0.08 only', () => {
    assert.deepEqual(mergeSegments([{ start: 0, end: 1 }, { start: 1.08, end: 2 }]), [{ start: 0, end: 2 }]);
    assert.deepEqual(mergeSegments([{ start: 0, end: 1 }, { start: 1.081, end: 2 }]), [{ start: 0, end: 1 }, { start: 1.081, end: 2 }]);
    assert.throws(() => mergeSegments([], 0.081), (error) => error.code === 'UNSAFE_MERGE_GAP');
  });

  await test('required-delete duration and coverage QA', () => {
    const valid = validatePlannerOutput(fullPlan(), { transcript, requirements });
    const artifacts = decisionsToArtifacts({ transcript, decisions: valid.decisions });
    const qa = qaPlan({ transcript, requirements, decisions: valid.decisions, artifacts });
    assert.equal(qa.pass, true);
    assert.equal(qa.checks.find((check) => check.id === 'required-delete:delete-filler').pass, true);
    assert.equal(qa.checks.find((check) => check.id === 'target-duration').pass, true);
    const missing = qaPlan({ transcript, requirements, decisions: valid.decisions.slice(0, 3), artifacts });
    assert.equal(missing.checks.find((check) => check.id === 'coverage').pass, false);
  });

  await test('prior TA feedback is injected', () => {
    const messages = injectPriorFeedback([{ role: 'user', content: '订单' }], [{ comment: '开头再快一点' }]);
    assert.match(messages[0].content, /开头再快一点/);
  });

  await test('audit stores reasons but no transcript body', () => {
    const plan = fullPlan();
    const audit = buildAuditRecord({ orderId: 1, taskId: 2, strategy: plan.strategy, decisions: plan.decisions, requirements, qa: { pass: true } });
    assert.equal(audit.reasons.length, 4);
    assert.doesNotMatch(JSON.stringify(audit), /逐字稿|欢迎来到节目/);
  });

  await test('ledger transitions and resume are strict', () => {
    const ledger = new Ledger();
    for (const state of LEDGER_STATES.slice(0, 4)) ledger.transition(state);
    const resumed = new Ledger(ledger.snapshot());
    assert.equal(resumed.current, 'TRANSCRIBED');
    resumed.transition('PLANNED');
    assert.throws(() => resumed.transition('CUT_DONE'), (error) => error.code === 'INVALID_LEDGER_TRANSITION');
    assert.throws(() => new Ledger({ entries: [{ state: 'CLAIMED' }] }), /resumed transition/);
  });

  await test('ledger recursively redacts credential values under generic keys', () => {
    const secret = 'VeryLongKnownCredential_ABC123456789';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiMSJ9.signatureABC123';
    const cleanId = '550e8400-e29b-41d4-a716-446655440000';
    const sanitized = sanitizeLedgerMetadata({
      value: secret,
      note: `Bearer ${secret}`,
      nested: { header: jwt, id: cleanId, shortId: 'task-123' },
    }, [secret]);
    assert.equal(sanitized.value, '[REDACTED]');
    assert.equal(sanitized.note, 'Bearer [REDACTED]');
    assert.equal(sanitized.nested.header, '[REDACTED]');
    assert.equal(sanitized.nested.id, cleanId);
    assert.equal(sanitized.nested.shortId, 'task-123');
    const ledger = new Ledger(null, { knownSecrets: [secret] });
    ledger.transition('AUTHED', { value: secret });
    assert.equal(ledger.entries[0].metadata.value, '[REDACTED]');
  });

  await test('credential redaction and CLI success output never exposes provider echo', async () => {
    const secret = 'VeryLongProviderCredential_ABC123456789';
    assert.doesNotMatch(redactSecrets(`Authorization: Bearer ${secret}; token=${secret}`, [secret]), new RegExp(secret));
    const result = await run({ ...parseArgs(['--base-url', 'http://localhost:3004', '--token', secret]), token: secret });
    assert.equal(result.credentialPresent, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    const providerResult = await run({
      ...parseArgs(['--base-url', 'http://localhost:3004', '--token', secret, '--execute', '--submit', '--approve-submit', '--task-id', '1']),
      token: secret,
    }, {
      inputArtifact: { orderId: 'normal-short-id' },
      provider: {
        run: async ({ credential }) => ({
          ok: true,
          debug: {
            value: credential,
            note: `Bearer ${credential}`,
            request: { headers: { generic: credential } },
          },
        }),
      },
    });
    const serialized = serializeSuccessResult(providerResult, [secret]);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /normal|true/);
    let stdout = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    try {
      const code = await main(['--base-url', 'http://localhost:3004', '--token', secret, '--execute', '--submit', '--approve-submit', '--task-id', '1'], {
        inputArtifact: { orderId: 'task-123' },
        provider: { run: async ({ credential }) => ({ ok: true, value: credential, note: `Bearer ${credential}` }) },
      });
      assert.equal(code, 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.doesNotMatch(stdout, new RegExp(secret));
    assert.match(stdout, /\[REDACTED\]/);
  });

  await test('all safety gates', async () => {
    assert.throws(() => assertSafetyGates({}), (error) => error.code === 'BASE_URL_REQUIRED');
    assert.throws(() => assertSafetyGates({ baseUrl: 'https://bokejianji.cn' }), (error) => error.code === 'PRODUCTION_APPROVAL_REQUIRED');
    assert.throws(() => assertSafetyGates({ baseUrl: 'http://localhost:3004', claim: true, taskId: '1' }), (error) => error.code === 'CLAIM_APPROVAL_REQUIRED');
    assert.throws(() => assertSafetyGates({ baseUrl: 'http://localhost:3004', claim: true, approveClaim: true }), (error) => error.code === 'CLAIM_APPROVAL_REQUIRED');
    assert.throws(() => assertSafetyGates({ baseUrl: 'http://localhost:3004', submit: true }), (error) => error.code === 'SUBMIT_APPROVAL_REQUIRED');
    assert.equal(assertSafetyGates({ baseUrl: 'https://bokejianji.cn', allowProduction: true, claim: true, approveClaim: true, taskId: '1', submit: true, approveSubmit: true }), true);
    assert.equal(isProductionUrl('http://8.136.133.196:8090'), false);
    assert.equal(isProductionUrl('http://localhost:8090'), false);
    assert.equal(isProductionUrl('http://127.0.0.1:8090'), false);
    assert.equal(isProductionUrl('http://203.0.113.10:8090'), true);
    assert.equal(isProductionUrl('https://arbitrary-public.example:8090'), true);
    assert.throws(
      () => assertSafetyGates({ baseUrl: 'http://203.0.113.10:8090' }),
      (error) => error.code === 'PRODUCTION_APPROVAL_REQUIRED'
    );
  });

  await test('dry run is default and execute fails closed without provider/artifact', async () => {
    const options = parseArgs(['--base-url', 'http://localhost:3004']);
    assert.equal(options.dryRun, true);
    const dry = await run(options);
    assert.equal(dry.mode, 'dry-run');
    await assert.rejects(() => run({ ...options, dryRun: false }), (error) => error.code === 'CREDENTIAL_REQUIRED');
    await assert.rejects(
      () => run({ ...options, dryRun: false, token: 'test-token' }),
      (error) => error.code === 'TASK_ID_REQUIRED'
    );
  });

  await test('reconcile before create and snapshot before mutation', async () => {
    let creates = 0;
    const existing = await reconcileBeforeCreate({ identity: 'a', findExisting: async () => ({ id: 1 }), create: async () => { creates += 1; } });
    assert.equal(existing.created, false);
    assert.equal(creates, 0);
    const created = await reconcileBeforeCreate({ identity: 'b', findExisting: async () => null, create: async () => ({ id: 2 }) });
    assert.equal(created.created, true);
    const snap = await snapshotBeforeMutation({ target: 1, read: async () => ({ value: 1 }), mutate: async (_, before) => ({ value: before.value + 1 }) });
    assert.equal(snap.result.value, 2);
  });

  await test('DashScope millisecond sentences convert to exact V1 S shape', () => {
    const converted = dashscopeToV1S({
      transcripts: [{
        sentences: [{
          speaker_id: 7,
          text: '你好世界',
          begin_time: 1250,
          end_time: 3250,
          words: [
            { text: '你好', begin_time: 1250, end_time: 2200 },
            { text: '世界', begin_time: 2200, end_time: 3250 },
          ],
        }],
      }],
    });
    assert.deepEqual(converted, [{
      idx: 0,
      sp: '7',
      t: '你好世界',
      s: 1.25,
      e: 3.25,
      ts: '0:01',
      w: [{ t: '你好', s: 1.25, e: 2.2 }, { t: '世界', s: 2.2, e: 3.25 }],
    }]);
  });

  await test('V1Provider exact mocked success flow, bodies, polling, reconcile and final visibility', async () => {
    const calls = [];
    const counters = { sourcePoll: 0, cutPoll: 0, outputPoll: 0, claims: 0 };
    const sourceResult = {
      transcripts: [{
        sentences: [
          { speaker_id: 0, text: '欢迎来到节目。', begin_time: 0, end_time: 2000, words: [{ text: '欢迎来到节目。', begin_time: 0, end_time: 2000 }] },
          { speaker_id: 1, text: '嗯嗯这句删除。', begin_time: 2050, end_time: 5000, words: [{ text: '嗯嗯', begin_time: 2050, end_time: 2800 }, { text: '这句删除。', begin_time: 2800, end_time: 5000 }] },
          { speaker_id: 0, text: '最后行动建议。', begin_time: 5100, end_time: 8000, words: [{ text: '最后行动建议。', begin_time: 5100, end_time: 8000 }] },
        ],
      }],
    };
    const outputResult = {
      transcripts: [{
        sentences: [
          { speaker_id: 0, text: '欢迎来到节目。', begin_time: 0, end_time: 2000, words: [{ text: '欢迎来到节目。', begin_time: 0, end_time: 2000 }] },
          { speaker_id: 1, text: '这句删除。', begin_time: 2050, end_time: 4300, words: [{ text: '这句删除。', begin_time: 2050, end_time: 4300 }] },
          { speaker_id: 0, text: '最后行动建议。', begin_time: 4400, end_time: 7300, words: [{ text: '最后行动建议。', begin_time: 4400, end_time: 7300 }] },
        ],
      }],
    };
    const jsonResponse = (data, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    });
    const fetchImpl = async (urlValue, init) => {
      const url = new URL(urlValue);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: `${url.pathname}${url.search}`, headers: init.headers, body });
      assert.equal(init.headers.authorization, 'Bearer mock-provider-token');
      if (init.method === 'GET' && url.pathname === '/api/orders/tasks') {
        return jsonResponse({ tasks: [{ id: 'task-7', title: '真实订单', demand: { mustDelete: [{ id: 'filler', text: '嗯嗯' }], targetDuration: { min: 7, max: 8 } }, audioUrl: 'https://media.example/source.m4a', storage: 'oss', objectKey: 'orders/source.m4a', fileName: 'source.m4a' }] });
      }
      if (init.method === 'GET' && url.pathname === '/api/orders/my-claims') {
        counters.claims += 1;
        if (counters.claims < 3) return jsonResponse({ claims: [{ id: 'claim-7', taskId: 'task-7' }] });
        return jsonResponse({ claims: [{ id: 'claim-7', taskId: 'task-7', projectId: 'project-7', snapshotId: 'snapshot-7', status: 'reviewed', reviewNote: '结构清楚', reviewedAt: '2026-07-27T00:00:00Z' }] });
      }
      if (init.method === 'POST' && url.pathname === '/dashscope/transcription') {
        assert.deepEqual(Object.keys(body), ['audioUrl', 'speakerCount', 'storage', 'objectKey']);
        if (body.audioUrl.includes('/api/cut/download/')) {
          assert.equal(body.audioUrl, 'http://localhost:3004/api/cut/download/cut-7');
          return jsonResponse({ output: { task_id: 'trans-output' } });
        }
        assert.deepEqual(body, { audioUrl: 'https://media.example/source.m4a', speakerCount: 2, storage: 'oss', objectKey: 'orders/source.m4a' });
        return jsonResponse({ output: { task_id: 'trans-source' } });
      }
      if (init.method === 'GET' && url.pathname === '/dashscope/tasks/trans-source') {
        counters.sourcePoll += 1;
        return jsonResponse(counters.sourcePoll === 1
          ? { output: { task_status: 'PENDING' } }
          : { output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope.example/source-result' }] } });
      }
      if (init.method === 'GET' && url.pathname === '/dashscope/tasks/trans-output') {
        counters.outputPoll += 1;
        return jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope.example/output-result' }] } });
      }
      if (init.method === 'GET' && url.pathname === '/dashscope/result') {
        return jsonResponse(url.searchParams.get('url').includes('source-result') ? sourceResult : outputResult);
      }
      if (init.method === 'POST' && url.pathname === '/api/deepseek/chat') {
        assert.equal(body.model, 'deepseek-v4-flash');
        assert.equal(body.max_tokens, 4096);
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.equal(body.purpose, 'decision_bundle');
        assert.match(body.messages[1].content, /原始 task\.demand/);
        assert.match(body.messages[1].content, /\[0\].*\[1\].*\[2\]/s);
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({
          strategy: 'structure_first',
          decisions: [
            { action: 'keep', sentenceIdx: 0, scope: 'full', reason: '开场', requirementIds: [] },
            { action: 'delete', sentenceIdx: 1, scope: 'partial', cs: 0, ce: 2, reason: '口癖', requirementIds: ['filler'] },
            { action: 'keep', sentenceIdx: 2, scope: 'full', reason: '结尾', requirementIds: [] },
          ],
        }) } }] });
      }
      if (init.method === 'GET' && url.pathname === '/api/projects') return jsonResponse({ projects: [] });
      if (init.method === 'POST' && url.pathname === '/api/projects') {
        assert.equal(body.payload.version, 'jinqian_m1');
        assert.deepEqual(body.payload.BLK, []);
        assert.deepEqual(body.payload.CHAPS, []);
        assert.deepEqual(body.payload.subtitlesWords, []);
        assert.deepEqual(body.payload.dispatchTask, { id: 'task-7', claimId: 'claim-7', title: '真实订单', demand: { mustDelete: [{ id: 'filler', text: '嗯嗯' }], targetDuration: { min: 7, max: 8 } } });
        assert.ok(body.metrics);
        return jsonResponse({ project: { id: 'project-7', fileName: 'source.m4a' } });
      }
      if (init.method === 'PATCH' && url.pathname === '/api/projects/project-7') {
        assert.deepEqual(body.payload.editState.p['1'][0].cs, 0);
        return jsonResponse({ id: 'project-7' });
      }
      if (init.method === 'POST' && url.pathname === '/api/cut/start') {
        assert.deepEqual(Object.keys(body), ['audioUrl', 'storage', 'objectKey', 'segments', 'originalDuration', 'fileName', 'goldenSegments', 'introMusic']);
        assert.deepEqual(body.goldenSegments, []);
        assert.equal(body.introMusic, null);
        return jsonResponse({ jobId: 'cut-7' });
      }
      if (init.method === 'GET' && url.pathname === '/api/cut/status/cut-7') {
        counters.cutPoll += 1;
        return jsonResponse(counters.cutPoll === 1 ? { status: 'QUEUED' } : { status: 'DONE' });
      }
      if (init.method === 'POST' && url.pathname === '/api/projects/project-7/snapshots') {
        assert.equal(body.cutPayload.version, 'roughcut_v1');
        assert.deepEqual(Object.keys(body.cutPayload), ['version', 'audioUrl', 'segments', 'original_duration', 'roughcut_duration', 'removed_duration']);
        return jsonResponse({ snapshot: { id: 'snapshot-7', projectId: 'project-7' } });
      }
      throw new Error(`unexpected mock route ${init.method} ${url.pathname}${url.search}`);
    };
    const provider = new V1Provider({
      baseUrl: 'http://localhost:3004',
      token: 'mock-provider-token',
      fetchImpl,
      maxPollAttempts: 4,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    const result = await provider.run({
      taskId: 'task-7',
      strategy: 'structure_first',
      claim: false,
      submit: true,
      speakerCount: 2,
      ledger: new Ledger(null, { knownSecrets: ['mock-provider-token'] }),
    });
    assert.equal(result.status, 'reviewed');
    assert.equal(result.snapshotId, 'snapshot-7');
    assert.equal(result.ledger.entries.at(-1).state, 'TA_VISIBLE');
    assert.equal(counters.sourcePoll, 2);
    assert.equal(counters.cutPoll, 2);
    assert.equal(counters.outputPoll, 1);
    assert.doesNotMatch(serializeSuccessResult(result, ['mock-provider-token']), /mock-provider-token/);
  });

  await test('claim/project/snapshot reconciliation avoids duplicate POSTs', async () => {
    const calls = [];
    const fetchImpl = async (urlValue, init) => {
      const url = new URL(urlValue);
      calls.push(`${init.method} ${url.pathname}`);
      const data = url.pathname === '/api/orders/my-claims'
        ? { claims: [{ id: 'claim-1', taskId: 'task-1', snapshotId: 'snapshot-1' }] }
        : url.pathname === '/api/projects/project-1'
          ? { id: 'project-1', payload: { dispatchTask: { id: 'task-1' } } }
          : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    };
    const provider = new V1Provider({ baseUrl: 'http://localhost:3004', token: 'token', fetchImpl, sleep: async () => {} });
    const claim = await provider.reconcileClaim('task-1', true);
    assert.equal(claim.id, 'claim-1');
    const snapshot = await provider.reconcileSnapshot('project-1', 'task-1', { shouldNotPost: true });
    assert.equal(snapshot.created, false);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 0);
  });

  await test('unknown create responses reconcile without duplicate claim/project/snapshot POST', async () => {
    const counts = { claim: 0, project: 0, snapshot: 0 };
    const state = { claimed: false, project: false, snapshot: false };
    const projectPayload = {
      dispatchTask: { id: '41', claimId: '91', title: '订单', demand: {} },
    };
    const fetchImpl = async (urlValue, init) => {
      const url = new URL(urlValue);
      const respond = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
      if (init.method === 'GET' && url.pathname === '/api/orders/my-claims') {
        return respond({ claims: state.claimed ? [{
          id: 91,
          taskId: 41,
          projectId: state.project ? 'project-41' : '',
          snapshotId: state.snapshot ? 'snapshot-41' : '',
        }] : [] });
      }
      if (init.method === 'POST' && url.pathname === '/api/orders/tasks/41/claim') {
        counts.claim += 1;
        state.claimed = true;
        throw new Error('simulated connection loss after claim commit');
      }
      if (init.method === 'GET' && url.pathname === '/api/projects') {
        return respond({ projects: state.project ? [{ id: 'project-41', updatedAt: '2026-07-26T00:00:00Z' }] : [] });
      }
      if (init.method === 'GET' && url.pathname === '/api/projects/project-41') {
        return respond({ project: { id: 'project-41' }, payload: projectPayload });
      }
      if (init.method === 'POST' && url.pathname === '/api/projects') {
        counts.project += 1;
        state.project = true;
        throw new Error('simulated connection loss after project commit');
      }
      if (init.method === 'POST' && url.pathname === '/api/projects/project-41/snapshots') {
        counts.snapshot += 1;
        state.snapshot = true;
        throw new Error('simulated connection loss after snapshot commit');
      }
      throw new Error(`unexpected ${init.method} ${url.pathname}`);
    };
    const provider = new V1Provider({ baseUrl: 'http://localhost:3004', token: 'token', fetchImpl, sleep: async () => {} });
    const firstClaim = await provider.reconcileClaim('41', true);
    const secondClaim = await provider.reconcileClaim('41', true);
    assert.equal(firstClaim.id, 91);
    assert.equal(secondClaim.id, 91);
    const fakeTask = { id: 41, title: '订单', demand: {} };
    const fakeMaterial = { audioUrl: 'https://media.example/41.m4a', storage: '', objectKey: '', fileName: '41.m4a' };
    const fakeS = [{ idx: 0, t: '正文', s: 0, e: 2 }];
    const firstProject = await provider.reconcileProject(firstClaim, fakeTask, fakeMaterial, fakeS, { d: [], p: {} });
    const secondProject = await provider.reconcileProject(secondClaim, fakeTask, fakeMaterial, fakeS, { d: [], p: {} });
    assert.equal(firstProject.id, 'project-41');
    assert.equal(secondProject.id, 'project-41');
    const firstSnapshot = await provider.reconcileSnapshot('project-41', '41', { payload: projectPayload });
    const secondSnapshot = await provider.reconcileSnapshot('project-41', '41', { payload: projectPayload });
    assert.equal(firstSnapshot.snapshotId, 'snapshot-41');
    assert.equal(secondSnapshot.snapshotId, 'snapshot-41');
    assert.deepEqual(counts, { claim: 1, project: 1, snapshot: 1 });
  });

  await test('output QA checks must-keep presence, must-delete absence, and actual duration', () => {
    const outputTranscript = [
      { idx: 0, t: '这里保留核心观点。', s: 0, e: 4 },
      { idx: 1, t: '最后行动建议。', s: 4, e: 8 },
    ];
    const outputRequirements = normalizeRequirements({
      mustKeep: [{ id: 'core', text: '核心观点' }],
      mustDelete: [{ id: 'filler', text: '嗯嗯' }],
      targetDuration: { min: 7, max: 9 },
    });
    assert.equal(outputQa({ transcript: outputTranscript, requirements: outputRequirements, plannedDuration: 8 }).pass, true);
    assert.equal(outputQa({
      transcript: [{ idx: 0, t: '嗯嗯核心观点不见了。', s: 0, e: 3 }],
      requirements: outputRequirements,
      plannedDuration: 8,
      toleranceSeconds: 0,
    }).pass, false);
    const unverifiable = normalizeRequirements({ mustKeep: [{ id: 'positional-only', sentenceIdx: 0 }] });
    assert.equal(outputQa({ transcript: outputTranscript, requirements: unverifiable, plannedDuration: 8 }).pass, false);
  });

  await test('QA failure blocks snapshot creation', async () => {
    const snapshotCalls = [];
    const provider = new V1Provider({
      baseUrl: 'http://localhost:3004',
      token: 'token',
      fetchImpl: async () => { throw new Error('network should be replaced by method stubs'); },
      sleep: async () => {},
    });
    provider.client.get = async (route) => {
      if (route === '/api/orders/tasks') return { tasks: [{ id: 'task-fail', title: '失败订单', demand: { targetDuration: { min: 1, max: 1 } }, audioUrl: 'https://media.example/source.m4a' }] };
      if (route === '/api/orders/my-claims') return { claims: [{ id: 'claim-fail', taskId: 'task-fail' }] };
      if (route === '/api/projects') return { projects: [] };
      throw new Error(`unexpected GET ${route}`);
    };
    provider.client.post = async (route) => {
      snapshotCalls.push(route);
      if (route === '/api/projects') return { id: 'project-fail' };
      throw new Error(`unexpected POST ${route}`);
    };
    provider.client.patch = async () => ({ id: 'project-fail' });
    provider.transcribe = async (material) => ({
      taskId: material.audioUrl.includes('/api/cut/download/') ? 'out' : 'source',
      S: [{ idx: 0, sp: 'a', t: '保留完整内容', s: 0, e: 5, ts: '0:00', w: [{ t: '保留完整内容', s: 0, e: 5 }] }],
    });
    provider.plan = async () => ({
      strategy: 'structure_first',
      decisions: [{ action: 'keep', sentenceIdx: 0, scope: 'full', reason: '保留', requirementIds: [] }],
      requirements: normalizeRequirements({ targetDuration: { min: 1, max: 1 } }),
    });
    provider.cut = async () => ({ jobId: 'cut-fail', downloadUrl: 'http://localhost:3004/api/cut/download/cut-fail' });
    await assert.rejects(() => provider.run({
      taskId: 'task-fail',
      strategy: 'structure_first',
      claim: false,
      submit: true,
      ledger: new Ledger(),
    }), (error) => error.code === 'QA_FAILED');
    assert.equal(snapshotCalls.some((route) => route.includes('/snapshots')), false);
  });

  await test('batch plan enforces 3-5 distinct tasks and exact ordered approvals', () => {
    assert.throws(() => normalizeBatchPlan({ taskIds: ['1', '2'], approvedTaskIds: ['1', '2'] }), (error) => error.code === 'INVALID_BATCH_SIZE');
    assert.throws(() => normalizeBatchPlan({ taskIds: ['1', '2', '3', '4', '5', '6'], approvedTaskIds: ['1', '2', '3', '4', '5', '6'] }), (error) => error.code === 'INVALID_BATCH_SIZE');
    assert.throws(() => normalizeBatchPlan({ taskIds: ['1', '2', '1'], approvedTaskIds: ['1', '2', '1'] }), (error) => error.code === 'DUPLICATE_TASK_ID');
    assert.throws(() => normalizeBatchPlan({ taskIds: ['1', '2', '3'], approvedTaskIds: ['1', '3', '2'] }), (error) => error.code === 'BATCH_APPROVAL_MISMATCH');
    assert.throws(() => normalizeBatchPlan({ taskIds: ['1', '2', '3'], approvedTaskIds: [] }), (error) => error.code === 'BATCH_APPROVAL_MISMATCH');
    const five = normalizeBatchPlan({ taskIds: ['1', '2', '3', '4', '5'], approvedTaskIds: ['1', '2', '3', '4', '5'] });
    assert.deepEqual(five.strategies, ['structure_first', 'density_first', 'audience_retention', 'structure_first', 'density_first']);
  });

  await test('CLI batch dry run preserves explicit task, approval, and strategy order', async () => {
    const options = parseArgs([
      '--base-url', 'http://localhost:3004',
      '--task-ids', 'a,b,c',
      '--approved-task-ids', 'a,b,c',
      '--strategies', 'audience_retention,structure_first,density_first',
    ]);
    const result = await run(options);
    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(result.batch.taskIds, ['a', 'b', 'c']);
    assert.deepEqual(result.batch.approvedTaskIds, ['a', 'b', 'c']);
    assert.deepEqual(result.batch.strategies, ['audience_retention', 'structure_first', 'density_first']);
    await assert.rejects(
      () => run(parseArgs(['--base-url', 'http://localhost:3004', '--task-ids', 'a,b,c', '--approved-task-ids', 'a,c,b'])),
      (error) => error.code === 'BATCH_APPROVAL_MISMATCH'
    );
  });

  await test('48-hour CLAIMED deadline fails closed with blocking summary', () => {
    const ledger = new Ledger();
    ledger.transition('AUTHED');
    ledger.transition('BOOTSTRAPPED');
    ledger.transition('CLAIMED');
    ledger.entries[2].at = '2026-07-24T00:00:00.000Z';
    assert.throws(
      () => assertClaimDeadline(ledger, Date.parse('2026-07-26T00:00:00.000Z')),
      (error) => error.code === 'CLAIM_DEADLINE_EXCEEDED'
        && error.details.blocker === 'CLAIM_DEADLINE_EXCEEDED'
        && Date.parse(error.details.deadlineAt) - Date.parse(error.details.claimedAt) === CLAIM_DEADLINE_MS
    );
    const warning = assertClaimDeadline(ledger, Date.parse('2026-07-25T00:00:00.000Z'));
    assert.equal(warning.status, 'WARNING');
    assert.equal(warning.reportRequired, true);
    const freeze = assertClaimDeadline(ledger, Date.parse('2026-07-25T12:00:00.000Z'));
    assert.equal(freeze.status, 'FREEZE_EXTRA_OPTIMIZATION');
    assert.equal(freeze.freezeExtraOptimization, true);
  });

  await test('machine QA produces suspicious-boundary evidence and fails obvious fragments', () => {
    const boundaryTranscript = [
      { idx: 0, t: '第一句', s: 0, e: 1, w: [{ t: '第一句', s: 0, e: 1 }] },
      { idx: 1, t: '第二句', s: 1, e: 2, w: [{ t: '第二句', s: 1, e: 2 }] },
    ];
    const safe = buildSuspiciousBoundaryChecklist({ transcript: boundaryTranscript, segments: [{ start: 0, end: 0.5 }] });
    assert.equal(safe.mode, 'machine-full-retranscription-plus-suspicious-boundary-list');
    assert.equal(safe.pass, true);
    assert.ok(safe.suspicious.some((item) => item.severity === 'review'));
    const risky = buildSuspiciousBoundaryChecklist({
      transcript: boundaryTranscript,
      segments: [{ start: 0, end: 0.5 }, { start: 0.59, end: 1 }],
    });
    assert.equal(risky.pass, false);
    assert.ok(risky.suspicious.some((item) => item.severity === 'high'));
  });

  await test('three-run batch rotates strategies and injects TA plus QA learning without transcript', async () => {
    const calls = [];
    const provider = {
      run: async ({ taskId, strategy, strategyVersion, ledger, priorFeedback }) => {
        calls.push({ taskId, strategy, strategyVersion, priorFeedback });
        for (const state of LEDGER_STATES) ledger.transition(state);
        return {
          state: 'TA_VISIBLE',
          taskId,
          strategy,
          strategyVersion,
          projectId: `project-${taskId}`,
          snapshotId: `snapshot-${taskId}`,
          status: 'reviewed',
          reviewNote: `助教反馈-${taskId}`,
          reviewedAt: `2026-07-27T0${taskId}:00:00Z`,
          qa: { pass: true, metrics: { outputDuration: Number(taskId) }, checks: [{ id: `qa-${taskId}`, pass: true }] },
          ledger: ledger.snapshot(),
        };
      },
      getClaims: async () => [],
    };
    const orchestrator = new BatchOrchestrator({ provider });
    const result = await orchestrator.run({ taskIds: ['1', '2', '3'], approvedTaskIds: ['1', '2', '3'] });
    assert.equal(result.state, 'COMPLETE');
    assert.deepEqual(calls.map((call) => call.strategy), ['structure_first', 'density_first', 'audience_retention']);
    assert.deepEqual(calls.map((call) => call.taskId), ['1', '2', '3']);
    assert.equal(calls[0].priorFeedback.length, 0);
    assert.match(calls[1].priorFeedback.join('\n'), /助教反馈-1/);
    assert.match(calls[1].priorFeedback.join('\n'), /机器 QA 摘要/);
    assert.doesNotMatch(calls[1].priorFeedback.join('\n'), /transcript|逐字稿|欢迎来到/);
    assert.equal(new Set(result.runs.map((run) => run.runId)).size, 3);
    assert.equal(new Set(result.runs.map((run) => run.ledger)).size, 3);
    assert.deepEqual(result.runs.map((run) => run.strategyVersion), ['jianjian-strategy-v1', 'jianjian-strategy-v1', 'jianjian-strategy-v1']);
    assert.notDeepEqual(result.runs[0].evidence, result.runs[1].evidence);
    assert.deepEqual(result.runs.map((run) => run.evidenceHistory.map((event) => event.kind)), [
      ['machine_qa', 'ta_review', 'artifacts'],
      ['machine_qa', 'ta_review', 'artifacts'],
      ['machine_qa', 'ta_review', 'artifacts'],
    ]);
  });

  await test('pending TA prevents task2 claim and returns resumable wait state', async () => {
    const claimed = [];
    const provider = {
      run: async ({ taskId, ledger }) => {
        claimed.push(taskId);
        for (const state of LEDGER_STATES.slice(0, -1)) ledger.transition(state);
        return {
          state: WAITING_FOR_TA,
          taskId,
          projectId: `project-${taskId}`,
          snapshotId: `snapshot-${taskId}`,
          status: 'submitted',
          reviewNote: '',
          reviewedAt: '',
          qa: { pass: true, metrics: {}, checks: [] },
          ledger: ledger.snapshot(),
        };
      },
      getClaims: async () => [{ taskId: '1', status: 'submitted', reviewNote: '', reviewedAt: '' }],
    };
    const result = await new BatchOrchestrator({ provider }).run({ taskIds: ['1', '2', '3'], approvedTaskIds: ['1', '2', '3'] });
    assert.equal(result.state, WAITING_FOR_TA);
    assert.equal(result.waitingForTaskId, '1');
    assert.equal(result.nextTaskId, '2');
    assert.deepEqual(claimed, ['1']);
    assert.equal(result.runs.length, 1);
  });

  await test('batch restart resumes waiting run and never duplicates prior order', async () => {
    const calls = [];
    let reviewed = false;
    const provider = {
      run: async ({ taskId, strategy, ledger, priorFeedback }) => {
        calls.push({ taskId, strategy, priorFeedback });
        for (const state of LEDGER_STATES.slice(ledger.entries.length)) ledger.transition(state);
        return {
          state: 'TA_VISIBLE',
          taskId,
          projectId: `project-${taskId}`,
          snapshotId: `snapshot-${taskId}`,
          status: 'reviewed',
          reviewNote: `反馈-${taskId}`,
          reviewedAt: '2026-07-27T01:00:00Z',
          qa: { pass: true, metrics: { run: taskId }, checks: [] },
          ledger: ledger.snapshot(),
        };
      },
      getClaims: async () => reviewed
        ? [{ taskId: '1', projectId: 'project-1', snapshotId: 'snapshot-1', status: 'reviewed', reviewNote: '反馈-1', reviewedAt: '2026-07-27T00:30:00Z' }]
        : [{ taskId: '1', status: 'submitted', reviewNote: '', reviewedAt: '' }],
    };
    const plan = { taskIds: ['1', '2', '3'], approvedTaskIds: ['1', '2', '3'] };
    const firstLedger = new Ledger();
    for (const state of LEDGER_STATES.slice(0, -1)) firstLedger.transition(state);
    const first = {
      ...normalizeBatchPlan(plan),
      version: 1,
      state: WAITING_FOR_TA,
      waitingForTaskId: '1',
      nextTaskId: '2',
      runs: [{
        runId: `${normalizeBatchPlan(plan).batchId}-1-1`,
        taskId: '1',
        strategy: 'structure_first',
        strategyVersion: 'jianjian-strategy-v1',
        state: WAITING_FOR_TA,
        ledger: firstLedger.snapshot(),
        evidence: { machineQa: { pass: true, metrics: { run: '1' }, checks: [] }, taReview: { status: 'submitted', reviewNote: '', reviewedAt: '' } },
      }],
    };
    reviewed = true;
    const result = await new BatchOrchestrator({ provider }).run(plan, first);
    assert.equal(result.state, 'COMPLETE');
    assert.deepEqual(calls.map((call) => call.taskId), ['2', '3']);
    assert.equal(result.runs.filter((run) => run.taskId === '1').length, 1);
    assert.match(calls[0].priorFeedback.join('\n'), /反馈-1/);
  });

  await test('five-run batch is supported with separated evidence', async () => {
    const provider = {
      run: async ({ taskId, strategy, ledger }) => {
        for (const state of LEDGER_STATES) ledger.transition(state);
        return {
          state: 'TA_VISIBLE',
          taskId,
          strategy,
          projectId: `p-${taskId}`,
          snapshotId: `s-${taskId}`,
          status: 'reviewed',
          reviewNote: `note-${taskId}`,
          reviewedAt: '2026-07-27T02:00:00Z',
          qa: { pass: true, metrics: { taskId }, checks: [] },
          ledger: ledger.snapshot(),
        };
      },
      getClaims: async () => [],
    };
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const result = await new BatchOrchestrator({ provider }).run({ taskIds: ids, approvedTaskIds: ids });
    assert.equal(result.runs.length, 5);
    assert.deepEqual(result.runs.map((run) => run.taskId), ids);
    assert.equal(new Set(result.runs.map((run) => run.evidence.projectId)).size, 5);
  });

  await test('onboarding CLI dry run displays fixed Day1 text and masks phone', async () => {
    const result = await run(parseArgs([
      '--base-url', 'http://localhost:3004',
      '--onboard',
      '--phone', '13800138000',
      '--nickname', '金钱剪剪',
    ]));
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.maskedPhone, '138****8000');
    assert.equal(result.nickname, '金钱剪剪');
    assert.equal(result.day1ConfirmationHash, generateDay1Intro('金钱剪剪').confirmationHash);
    assert.match(result.day1Text.field4, /全量重转写/);
    assert.doesNotMatch(JSON.stringify(result), /13800138000/);
  });

  await test('onboarding exact mocked OTP success flow unlocks orders', async () => {
    const calls = [];
    let meCount = 0;
    let currentUser = { id: 77, phone: '13800138000', maskedPhone: '138****8000', nickname: '', day1Complete: false, day2Complete: false };
    const project = { id: 'practice-77', fileName: 'D2 练习项目｜开营直播', audioUrl: 'https://media.example/practice.m4a', status: 'draft' };
    const respond = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    const fetchImpl = async (urlValue, init) => {
      const url = new URL(urlValue);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: url.pathname, body, authorization: init.headers.authorization || '' });
      if (url.pathname === '/api/auth/verify') {
        assert.deepEqual(body, { phone: '13800138000', code: '123456' });
        assert.equal(init.headers.authorization, undefined);
        return respond({ token: 'onboarding-bearer-token', expiresAt: '2026-09-01T00:00:00Z', user: currentUser, needsNickname: true });
      }
      assert.equal(init.headers.authorization, 'Bearer onboarding-bearer-token');
      if (url.pathname === '/api/auth/set-nickname') {
        assert.deepEqual(body, { nickname: '金钱剪剪' });
        currentUser = { ...currentUser, nickname: '金钱剪剪' };
        return respond({ user: currentUser });
      }
      if (url.pathname === '/api/auth/complete-day1') {
        assert.deepEqual(Object.keys(body), ['nickname', 'field1', 'field2', 'field3', 'field4']);
        assert.ok(Object.values(body).every(Boolean));
        currentUser = { ...currentUser, day1Complete: true, day1Intro: { nickname: body.nickname, fields: [body.field1, body.field2, body.field3, body.field4] } };
        return respond({ user: currentUser });
      }
      if (url.pathname === '/api/projects' && init.method === 'GET') return respond({ projects: [] });
      if (url.pathname === '/api/projects/practice/launch') {
        assert.deepEqual(body, {});
        return respond({ project, reused: false });
      }
      if (url.pathname === '/api/projects/practice-77' && init.method === 'GET') {
        return respond({ project, payload: { version: 'jinqian_m1', S: [{ idx: 0, t: '练习正文', s: 0, e: 1600 }], editState: { d: [], p: {} } } });
      }
      if (url.pathname === '/api/auth/me') {
        meCount += 1;
        return respond({ user: currentUser });
      }
      if (url.pathname === '/api/projects/practice-77/snapshots') {
        assert.equal(body.cutPayload.version, 'roughcut_v1');
        currentUser = { ...currentUser, day2Complete: true };
        project.status = 'pending_review';
        return respond({ snapshot: { id: 'snap-77', projectId: 'practice-77' } });
      }
      if (url.pathname === '/api/orders/tasks') return respond({ tasks: [] });
      throw new Error(`unexpected onboarding route ${init.method} ${url.pathname}`);
    };
    const provider = new OnboardingProvider({ baseUrl: 'http://localhost:3004', fetchImpl, sleep: async () => {} });
    provider.prepareDay2 = async (practice) => ({
      project: practice,
      payload: { version: 'jinqian_m1', S: [{ idx: 0, t: '练习正文', s: 0, e: 1600 }], editState: { d: [], p: {} } },
      qa: {
        pass: true,
        checks: [{ id: 'output-target-duration', pass: true }],
        metrics: { originalDuration: 3000, roughcutDuration: 1600, removedDuration: 1400, outputDuration: 1600 },
        boundaryEvidence: { mode: 'machine-full-retranscription-plus-suspicious-boundary-list', pass: true, suspicious: [] },
      },
      cutPayload: { version: 'roughcut_v1', audioUrl: practice.audioUrl, segments: [], original_duration: 3000, roughcut_duration: 1600, removed_duration: 1400 },
      metrics: { originalDuration: 3000, roughcutDuration: 1600, removedDuration: 1400 },
    });
    const intro = generateDay1Intro('金钱剪剪');
    const result = await new OnboardingRunner({ provider }).run({
      phone: '13800138000',
      otp: '123456',
      nickname: '金钱剪剪',
      approveVerify: true,
      approveNickname: true,
      approveDay1: true,
      confirmDay1Hash: intro.confirmationHash,
      approveDay2Submit: true,
    });
    assert.equal(result.state, 'ORDERS_UNLOCKED');
    assert.equal(result.day1Complete, true);
    assert.equal(result.day2Complete, true);
    assert.equal(calls.filter((call) => call.path === '/api/auth/send-code').length, 0);
    assert.equal(calls.filter((call) => call.path.endsWith('/snapshots')).length, 1);
    assert.doesNotMatch(serializeSuccessResult(result, ['onboarding-bearer-token']), /13800138000|123456|onboarding-bearer-token/);
    assert.ok(meCount >= 2);
  });

  await test('onboarding existing completed token reconciles without writes', async () => {
    const calls = [];
    const provider = {
      token: 'existing-token',
      getMe: async () => ({ id: 1, nickname: '金钱剪剪', day1Complete: true, day2Complete: true }),
      getOrderAccess: async () => ({ user: { nickname: '金钱剪剪', day1Complete: true, day2Complete: true }, taskCount: 4 }),
      sendCode: async () => calls.push('send'),
      verify: async () => calls.push('verify'),
      setNickname: async () => calls.push('nickname'),
      completeDay1: async () => calls.push('day1'),
      reconcilePracticeProject: async () => calls.push('practice'),
      prepareDay2: async () => calls.push('edit'),
      reconcileDay2Snapshot: async () => calls.push('snapshot'),
    };
    const result = await new OnboardingRunner({ provider }).run({ token: 'existing-token', nickname: '金钱剪剪' });
    assert.equal(result.state, 'ORDERS_UNLOCKED');
    assert.deepEqual(calls, []);
  });

  await test('onboarding OTP and every external write gate fail closed', async () => {
    const provider = {
      token: '',
      sendCode: async () => ({ ok: true, cooldownSeconds: 60, expiresAt: 'later' }),
    };
    await assert.rejects(
      () => new OnboardingRunner({ provider }).run({ phone: '13800138000', nickname: '金钱剪剪' }),
      (error) => error.code === 'SEND_CODE_APPROVAL_REQUIRED'
    );
    const waiting = await new OnboardingRunner({ provider }).run({ phone: '13800138000', nickname: '金钱剪剪', approveSendCode: true });
    assert.equal(waiting.state, ONBOARDING_WAITING_FOR_OTP);
    await assert.rejects(
      () => new OnboardingRunner({ provider: { token: '', verify: async () => ({}) } }).run({ phone: '13800138000', otp: '123456', nickname: '金钱剪剪' }),
      (error) => error.code === 'VERIFY_APPROVAL_REQUIRED'
    );
  });

  await test('onboarding unknown practice response reconciles and QA failure blocks snapshot', async () => {
    let projectExists = false;
    let practicePosts = 0;
    const respond = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    const provider = new OnboardingProvider({
      baseUrl: 'http://localhost:3004',
      token: 'token',
      fetchImpl: async (urlValue, init) => {
        const url = new URL(urlValue);
        if (url.pathname === '/api/projects' && init.method === 'GET') {
          return respond({ projects: projectExists ? [{ id: 'practice-x', fileName: 'D2 练习项目｜开营直播' }] : [] });
        }
        if (url.pathname === '/api/projects/practice/launch') {
          practicePosts += 1;
          projectExists = true;
          throw new Error('lost response after practice commit');
        }
        throw new Error(`unexpected ${init.method} ${url.pathname}`);
      },
    });
    assert.equal((await provider.reconcilePracticeProject()).id, 'practice-x');
    assert.equal((await provider.reconcilePracticeProject()).id, 'practice-x');
    assert.equal(practicePosts, 1);
    let snapshotCalls = 0;
    const failingProvider = {
      token: 'token',
      getMe: async () => ({ id: 1, nickname: '金钱剪剪', day1Complete: true, day2Complete: false }),
      reconcilePracticeProject: async () => ({ id: 'practice', fileName: '开营直播' }),
      prepareDay2: async () => {
        const error = new Error('qa failed');
        error.code = 'QA_FAILED';
        throw error;
      },
      reconcileDay2Snapshot: async () => { snapshotCalls += 1; },
    };
    await assert.rejects(
      () => new OnboardingRunner({ provider: failingProvider }).run({ token: 'token', nickname: '金钱剪剪', approveDay2Submit: true }),
      (error) => error.code === 'QA_FAILED'
    );
    assert.equal(snapshotCalls, 0);
  });

  await test('onboarding unknown snapshot response reconciles once and permission failure is explicit', async () => {
    let day2Complete = false;
    let projectStatus = 'draft';
    let snapshotPosts = 0;
    const prepared = {
      project: { id: 'practice-u', fileName: '开营直播', audioUrl: 'https://media.example/u.m4a' },
      payload: { version: 'jinqian_m1', S: [{ idx: 0, t: '正文', s: 0, e: 1 }] },
      cutPayload: { version: 'roughcut_v1', audioUrl: 'https://media.example/u.m4a', segments: [], original_duration: 1, roughcut_duration: 1, removed_duration: 0 },
      metrics: { originalDuration: 1, roughcutDuration: 1, removedDuration: 0 },
    };
    const provider = new OnboardingProvider({
      baseUrl: 'http://localhost:3004',
      token: 'token',
      fetchImpl: async () => { throw new Error('methods are stubbed'); },
    });
    provider.getMe = async () => ({ id: 1, nickname: '金钱剪剪', day1Complete: true, day2Complete });
    provider.getProject = async () => ({ project: { ...prepared.project, status: projectStatus }, payload: prepared.payload });
    provider.client.post = async (route) => {
      assert.equal(route, '/api/projects/practice-u/snapshots');
      snapshotPosts += 1;
      day2Complete = true;
      projectStatus = 'pending_review';
      throw new Error('lost snapshot response after commit');
    };
    assert.equal((await provider.reconcileDay2Snapshot(prepared)).reconciled, true);
    assert.equal((await provider.reconcileDay2Snapshot(prepared)).reconciled, true);
    assert.equal(snapshotPosts, 1);
    const lockedProvider = {
      token: 'token',
      getMe: async () => ({ id: 2, nickname: '金钱剪剪', day1Complete: true, day2Complete: true }),
      getOrderAccess: async () => {
        const error = new Error('Day2 permission is not unlocked');
        error.code = 'DAY2_REQUIRED';
        throw error;
      },
    };
    await assert.rejects(
      () => new OnboardingRunner({ provider: lockedProvider }).run({ token: 'token', nickname: '金钱剪剪' }),
      (error) => error.code === 'DAY2_REQUIRED'
    );
  });
})();
