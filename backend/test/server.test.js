import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const originalCwd = process.cwd();
const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalOpenRouterModel = process.env.OPENROUTER_MODEL;
const temporaryDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'callguide-server-test-'));
process.chdir(temporaryDataDirectory);
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENROUTER_MODEL = 'test/openrouter-model';

const { app, configureQuestionGeneratorForTests, configureSummaryGeneratorForTests, consumeSummaryRateLimitForTests, resetSummaryControlsForTests } = await import('../dist/server.js');
const store = await import('../dist/store.js');
const { createSummaryContext } = await import('../dist/summary.js');
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function replaceSavedStageNote(callId, note) {
  const file = path.join(temporaryDataDirectory, 'data', 'calls.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const stage = state.stageResults.find((result) => result.call_id === callId && result.stage_number === 1);
  assert.ok(stage);
  stage.notes = note;
  stage.updated_at = new Date().toISOString();
  await writeFile(file, JSON.stringify(state, null, 2));
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  process.chdir(originalCwd);
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  if (originalOpenRouterModel === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = originalOpenRouterModel;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const requestBody = route === '/calls' && method === 'POST' && body !== undefined && rawBody === undefined
    ? { contact_name: 'Synthetic prospect', contact_role: 'Operations Manager', company_name: 'Example Test Org', call_purpose: 'Test call purpose', ...body }
    : body;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(requestBody !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('call creation rejects missing and whitespace-only required fields while allowing omitted preparation notes', async () => {
  const incomplete = await request('/calls', { method: 'POST', rawBody: JSON.stringify({ contact_name: 'Only name' }) });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error.message, /contact_role is required/);

  const whitespace = await request('/calls', { method: 'POST', rawBody: JSON.stringify({
    contact_name: 'Valid name', contact_role: '   ', company_name: 'Example Test Org', call_purpose: 'Understand workflow',
  }) });
  assert.equal(whitespace.status, 400);
  assert.match(whitespace.body.error.message, /contact_role is required/);

  const complete = await request('/calls', { method: 'POST', rawBody: JSON.stringify({
    contact_name: ' Valid name ', contact_role: ' Operations Manager ', company_name: ' Example Test Org ', call_purpose: ' Understand workflow ',
  }) });
  assert.equal(complete.status, 201);
  assert.equal(complete.body.data.contact_name, 'Valid name');
  assert.equal(complete.body.data.initial_context, null);
});

test('call routes enforce in-progress updates, one-time closure, and outcome validation', async () => {
  const created = await request('/calls', {
    method: 'POST',
    body: { contact_name: 'Synthetic audit call', company_name: 'Example Test Org' },
  });
  assert.equal(created.status, 201);
  const callId = created.body.data.id;

  const stageSaved = await request(`/calls/${callId}/stages`, {
    method: 'POST',
    body: {
      stage_number: 1,
      stage_status: 'completed',
      notes: 'Synthetic stage note',
      structured_result: { interaction: 'right_person' },
      questions: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        question_text: 'Where do you need help?',
        source: 'suggested',
        asked: true,
        response: 'Tracking follow-ups is difficult.',
        position: 0,
      }],
    },
  });
  assert.equal(stageSaved.status, 200);
  assert.equal(stageSaved.body.data.notes, 'Synthetic stage note');
  const listedCalls = await request('/calls');
  assert.equal(listedCalls.body.data.find((call) => call.id === callId).stage_count, 1);

  const missingOutcome = await request(`/calls/${callId}/close`, { method: 'POST', body: {} });
  assert.equal(missingOutcome.status, 400);
  const invalidOutcome = await request(`/calls/${callId}/close`, {
    method: 'POST',
    body: { final_outcome: 'not_a_valid_outcome' },
  });
  assert.equal(invalidOutcome.status, 400);

  const firstClose = await request(`/calls/${callId}/close`, {
    method: 'POST',
    body: { final_outcome: 'next_step_agreed', final_notes: 'Synthetic closure' },
  });
  assert.equal(firstClose.status, 200);
  assert.equal(firstClose.body.data.final_outcome, 'next_step_agreed');

  const completedStageUpdate = await request(`/calls/${callId}/stages`, {
    method: 'POST',
    body: { stage_number: 1, stage_status: 'completed', notes: 'Must not replace saved note' },
  });
  assert.equal(completedStageUpdate.status, 409);

  const repeatedClose = await request(`/calls/${callId}/close`, {
    method: 'POST',
    body: { final_outcome: 'not_interested', final_notes: 'Must not replace original outcome' },
  });
  assert.equal(repeatedClose.status, 409);
  const retrieved = await request(`/calls/${callId}`);
  assert.equal(retrieved.body.data.final_outcome, 'next_step_agreed');
  assert.equal(retrieved.body.data.final_notes, 'Synthetic closure');
  assert.equal(retrieved.body.data.stageResults[0].notes, 'Synthetic stage note');
  assert.equal(retrieved.body.data.stageResults[0].structured_result.interaction, 'right_person');
  assert.equal(retrieved.body.data.stageResults[0].questions[0].asked, true);
  assert.equal(retrieved.body.data.stageResults[0].questions[0].response, 'Tracking follow-ups is difficult.');
  assert.equal(retrieved.body.data.callback_at, null);
  assert.equal(retrieved.body.data.summary.model_name, 'local-deterministic-summary');
  assert.match(retrieved.body.data.summary.summary_text, /Tracking follow-ups is difficult/);
  const completedList = await request('/calls');
  assert.match(completedList.body.data.find((call) => call.id === callId).summary_preview, /Call overview/);

  const invalidId = await request('/calls/not-a-uuid');
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error.code, 'VALIDATION_ERROR');
});

test('malformed JSON preserves the client error status without exposing parser details', async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (entry) => logged.push(String(entry));
  try {
    const malformed = await request('/calls', {
      method: 'POST',
      rawBody: '{"private":"DO_NOT_LOG_SYNTHETIC_TRANSCRIPT"',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body.error, {
      code: 'REQUEST_ERROR',
      message: 'Request could not be processed.',
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged.join('\n'), /DO_NOT_LOG_SYNTHETIC_TRANSCRIPT/);
});

test('do-not-call closure requires and preserves explicit confirmation', async () => {
  const created = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic DNC confirmation' } });
  const denied = await request(`/calls/${created.body.data.id}/close`, { method: 'POST', body: { final_outcome: 'do_not_call' } });
  assert.equal(denied.status, 400);
  const closed = await request(`/calls/${created.body.data.id}/close`, { method: 'POST', body: { final_outcome: 'do_not_call', do_not_call_confirmed: true } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.data.final_outcome, 'do_not_call');
  assert.equal(closed.body.data.do_not_call_confirmed, true);
});

test('stage validation rejects unknown fields and invalid conditional combinations', async () => {
  const call = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic validation' } });
  const id = call.body.data.id;
  const badInteraction = await request(`/calls/${id}/stages`, { method: 'POST', body: { stage_number: 3, structured_result: { interaction: 'clear_nope' } } });
  assert.equal(badInteraction.status, 400);
  const wrongConditional = await request(`/calls/${id}/stages`, { method: 'POST', body: { stage_number: 7, structured_result: { interaction: 'nothing_agreed', next_step_owner: 'caller' } } });
  assert.equal(wrongConditional.status, 400);
  const badCallback = await request(`/calls/${id}/stages`, { method: 'POST', body: { stage_number: 3, structured_result: { interaction: 'clear_no' }, callback_at: '2030-01-01T10:00:00Z' } });
  assert.equal(badCallback.status, 400);
  const valid = await request(`/calls/${id}/stages`, { method: 'POST', body: { stage_number: 7, structured_result: { interaction: 'time_agreed', next_step_owner: 'caller' }, callback_at: '2030-01-01T10:00:00Z' } });
  assert.equal(valid.status, 200);
  const closed = await request(`/calls/${id}/close`, { method: 'POST', body: { final_outcome: 'next_step_agreed' } });
  assert.equal(closed.status, 200);
  assert.equal(Date.parse(closed.body.data.callback_at), Date.parse('2030-01-01T10:00:00Z'));
});

test('history list limit is bounded and validated', async () => {
  assert.equal((await request('/calls?limit=201')).status, 400);
  const created = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic list', call_purpose: 'Private purpose fixture', initial_context: 'Private preparation fixture' } });
  const limited = await request('/calls?limit=2');
  assert.equal(limited.status, 200);
  const listed = limited.body.data.find((call) => call.id === created.body.data.id);
  assert.equal('initial_context' in listed, false);
  assert.equal('final_notes' in listed, false);
  assert.equal('call_purpose' in listed, false);
});

test('analytics returns real period metrics, zero-filled buckets, and validates timezone', async () => {
  const result = await request('/calls/analytics?period=daily&timezone=UTC');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.buckets.length, 7);
  assert.equal(result.body.data.buckets.reduce((sum, bucket) => sum + bucket.count, 0), result.body.data.total);
  assert.equal(result.body.data.completed + result.body.data.in_progress, result.body.data.total);
  assert.ok(result.body.data.buckets.every((bucket) => Number.isInteger(bucket.count) && bucket.count >= 0));
  const rangeCall = await store.createCall({ contact_name: 'Selected range analytics fixture' });
  const dataFile = path.join(temporaryDataDirectory, 'data', 'calls.json');
  const state = JSON.parse(await readFile(dataFile, 'utf8'));
  state.calls.find((call) => call.id === rangeCall.id).started_at = '2025-02-03T10:00:00.000Z';
  await writeFile(dataFile, JSON.stringify(state), 'utf8');
  const selectedRange = await request('/calls/analytics?period=daily&timezone=UTC&from=2025-02-03&to=2025-02-03');
  assert.equal(selectedRange.status, 200);
  assert.equal(selectedRange.body.data.total, 1);
  assert.equal(selectedRange.body.data.buckets.length, 1);
  assert.equal(selectedRange.body.data.buckets[0].count, 1);
  assert.equal((await request('/calls/analytics?period=monthly&timezone=UTC')).status, 400);
  assert.equal((await request('/calls/analytics?period=daily&timezone=Not%2FaZone')).status, 400);
  assert.equal((await request('/calls/analytics?period=daily&timezone=UTC&from=2025-02-04&to=2025-02-03')).status, 400);
  assert.equal((await request('/calls/analytics?period=daily&timezone=UTC&from=2025-02-30')).status, 400);
});

test('cursor pagination is stable for tied timestamps and excludes calls created during browsing', async () => {
  const calls = [];
  for (let index = 0; index < 105; index += 1) calls.push(await store.createCall({ contact_name: `Cursor fixture ${String(index).padStart(3, '0')}` }));
  const dataFile = path.join(temporaryDataDirectory, 'data', 'calls.json');
  const state = JSON.parse(await readFile(dataFile, 'utf8'));
  const tiedTimestamp = '2025-01-01T00:00:00.000Z';
  for (const call of state.calls) if (call.contact_name?.startsWith('Cursor fixture ')) call.created_at = tiedTimestamp;
  await writeFile(dataFile, JSON.stringify(state), 'utf8');

  const query = '/calls?limit=50&q=Cursor%20fixture&status=in_progress&sort=newest';
  const first = await request(query);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.length, 50);
  assert.equal(first.headers.get('x-total-count'), '105');
  assert.equal(first.headers.get('x-page-count'), '50');
  assert.equal(first.headers.get('x-has-more'), 'true');
  assert.ok(first.headers.get('x-next-cursor'));

  const addedDuringBrowse = await store.createCall({ contact_name: 'Cursor fixture inserted later' });
  const seen = new Set(first.body.data.map((call) => call.id));
  let cursor = first.headers.get('x-next-cursor');
  while (cursor) {
    const page = await request(`${query}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(page.status, 200);
    for (const call of page.body.data) {
      assert.equal(seen.has(call.id), false, 'cursor pages must not duplicate calls');
      seen.add(call.id);
    }
    cursor = page.headers.get('x-next-cursor');
    if (!cursor) assert.equal(page.headers.get('x-has-more'), 'false');
  }
  assert.equal(seen.size, 105);
  assert.equal(seen.has(addedDuringBrowse.id), false, 'new calls are excluded by the first page snapshot');

  const noResults = await request('/calls?limit=50&q=No%20matching%20cursor%20fixture');
  assert.equal(noResults.status, 200);
  assert.deepEqual(noResults.body.data, []);
  assert.equal(noResults.headers.get('x-total-count'), '0');
  const invalid = await request('/calls?cursor=%%%');
  assert.equal(invalid.status, 400);
});

test('callback reminders query scheduled callbacks independently of history pagination', async () => {
  const callbacks = [];
  for (let index = 0; index < 6; index += 1) {
    const call = await store.createCall({ contact_name: `Callback fixture ${index + 1}` });
    await store.closeCall(call.id, 'follow_up', 'Synthetic follow-up', new Date(Date.now() + (index + 1) * 60 * 60 * 1000).toISOString());
    callbacks.push(call.id);
  }
  const reminders = await request('/calls/callbacks');
  assert.equal(reminders.status, 200);
  assert.ok(reminders.body.data.length >= 6, 'callback queue includes all scheduled records beyond the previous four-row cap');
  assert.ok(callbacks.every((id) => reminders.body.data.some((call) => call.id === id)));
});

test('question generation validates its request, caches successful output, and leaves call records unchanged', async () => {
  resetSummaryControlsForTests();
  let generations = 0;
  configureQuestionGeneratorForTests(async () => {
    generations += 1;
    return { status: 'ok', source: 'openrouter', questions: [1, 2, 3].map((number) => ({
      question: `Question ${number}?`, reason: 'Grounded in saved context.', intent: 'Clarify the stated need.', priority: 'medium',
    })) };
  });
  try {
    const created = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic question call', call_purpose: 'Understand the current workflow' } });
    const id = created.body.data.id;
    const before = await request(`/calls/${id}`);
    const invalid = await request(`/calls/${id}/questions`, { method: 'POST', body: { stage_number: 1, extra: true } });
    assert.equal(invalid.status, 400);
    const first = await request(`/calls/${id}/questions`, { method: 'POST', body: { stage_number: 1 } });
    const cached = await request(`/calls/${id}/questions`, { method: 'POST', body: { stage_number: 1 } });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.questions.length, 3);
    assert.deepEqual(cached.body.data, first.body.data);
    assert.equal(generations, 1);
    const after = await request(`/calls/${id}`);
    assert.deepEqual(after.body.data.stageResults, before.body.data.stageResults);
    assert.equal(after.body.data.final_outcome, before.body.data.final_outcome);
  } finally {
    resetSummaryControlsForTests();
  }
});

test('repeated summary requests reuse one source-matched record', async () => {
  const call = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic summary' } });
  const id = call.body.data.id;
  await store.closeCall(id, 'interested', null);
  const [first, second] = await Promise.all([
    request(`/calls/${id}/summary`, { method: 'POST', body: {} }),
    request(`/calls/${id}/summary`, { method: 'POST', body: {} }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.match(first.body.data.source_hash, /^[a-f0-9]{64}$/);
});

test('summary cache identity regenerates when the configured model changes', async () => {
  resetSummaryControlsForTests();
  const previousModel = process.env.OPENROUTER_MODEL;
  const previousKey = process.env.OPENROUTER_API_KEY;
  let generations = 0;
  configureSummaryGeneratorForTests(async () => {
    generations += 1;
    return { summary: `Summary from model ${process.env.OPENROUTER_MODEL}`, modelName: process.env.OPENROUTER_MODEL };
  });
  try {
    process.env.OPENROUTER_API_KEY = 'mock-only-key';
    process.env.OPENROUTER_MODEL = 'openrouter/model-a';
    const call = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic model cache' } });
    await store.closeCall(call.body.data.id, 'interested', null);
    const first = await request(`/calls/${call.body.data.id}/summary`, { method: 'POST', body: {} });
    const cached = await request(`/calls/${call.body.data.id}/summary`, { method: 'POST', body: {} });
    assert.equal(first.body.data.model_name, 'openrouter/model-a');
    assert.equal(cached.body.data.summary_text, first.body.data.summary_text);
    assert.equal(generations, 1);

    process.env.OPENROUTER_MODEL = 'openrouter/model-b';
    const changedModel = await request(`/calls/${call.body.data.id}/summary`, { method: 'POST', body: {} });
    assert.equal(changedModel.body.data.model_name, 'openrouter/model-b');
    assert.equal(changedModel.body.data.summary_text, 'Summary from model openrouter/model-b');
    assert.equal(generations, 2);

    process.env.OPENROUTER_MODEL = 'openrouter/model-c';
    configureSummaryGeneratorForTests(async () => ({ summary: 'Rejected provider output fallback.', modelName: 'local-deterministic-summary' }));
    const failedModelChange = await request(`/calls/${call.body.data.id}/summary`, { method: 'POST', body: {} });
    assert.equal(failedModelChange.body.data.model_name, 'openrouter/model-b');
    assert.equal(failedModelChange.body.data.summary_text, 'Summary from model openrouter/model-b');
  } finally {
    resetSummaryControlsForTests();
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('summary generation is rejected until the call is complete', async () => {
  const created = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic in-progress summary' } });
  const response = await request(`/calls/${created.body.data.id}/summary`, { method: 'POST', body: {} });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'CALL_IN_PROGRESS');
});

test('changed-input summary races never persist or return the earlier snapshot', async () => {
  resetSummaryControlsForTests();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock-only-key';
  let startFirst;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  const firstBarrier = new Promise((resolve) => { releaseFirst = resolve; });
  configureSummaryGeneratorForTests(async (_call, stageResults) => {
    const note = stageResults[0]?.notes;
    if (note === 'snapshot A') {
      startFirst();
      await firstBarrier;
      return { summary: 'Summary for snapshot A', modelName: 'mock-openrouter' };
    }
    return { summary: `Summary for ${note}`, modelName: 'mock-openrouter' };
  });
  try {
    const call = await store.createCall({ contact_name: 'Synthetic snapshot race' });
    await store.upsertStageResult({ callId: call.id, stage_number: 1, stage_status: 'completed', notes: 'snapshot A' });
    await store.closeCall(call.id, 'interested', null);
    const snapshotA = await store.getCallById(call.id);
    const sourceA = createSummaryContext(snapshotA.call, snapshotA.stageResults).sourceHash;
    const requestA = request(`/calls/${call.id}/summary`, { method: 'POST', body: {} });
    await firstStarted;

    await replaceSavedStageNote(call.id, 'snapshot B');
    const snapshotB = await store.getCallById(call.id);
    const sourceB = createSummaryContext(snapshotB.call, snapshotB.stageResults).sourceHash;
    const responseB = await request(`/calls/${call.id}/summary`, { method: 'POST', body: {} });
    assert.equal(responseB.status, 200);
    assert.equal(responseB.body.data.summary_text, 'Summary for snapshot B');

    releaseFirst();
    const responseA = await requestA;
    assert.equal(responseA.status, 200);
    assert.equal(responseA.body.data.summary_text, 'Summary for snapshot B');
    assert.equal(await store.findSummaryBySourceHash(call.id, sourceA), null);
    const storedB = await store.findSummaryBySourceHash(call.id, sourceB);
    assert.equal(storedB.summary_text, 'Summary for snapshot B');
    assert.equal((await store.getCallById(call.id)).summary.source_hash, sourceB);
  } finally {
    resetSummaryControlsForTests();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('identical concurrent summary requests share one provider generation', async () => {
  resetSummaryControlsForTests();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock-only-key';
  let generationCount = 0;
  let release;
  let started;
  const barrier = new Promise((resolve) => { release = resolve; });
  const startSignal = new Promise((resolve) => { started = resolve; });
  configureSummaryGeneratorForTests(async () => {
    generationCount += 1;
    started();
    await barrier;
    return { summary: 'One shared summary', modelName: 'mock-openrouter' };
  });
  try {
    const call = await store.createCall({ contact_name: 'Synthetic identical concurrency' });
    await store.closeCall(call.id, 'interested', null);
    const first = request(`/calls/${call.id}/summary`, { method: 'POST', body: {} });
    await startSignal;
    const second = request(`/calls/${call.id}/summary`, { method: 'POST', body: {} });
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    assert.equal(left.body.data.id, right.body.data.id);
    assert.equal(generationCount, 1);
  } finally {
    resetSummaryControlsForTests();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('a local fallback is preserved after a failed retry and upgraded after success', async () => {
  resetSummaryControlsForTests();
  const previousKey = process.env.OPENROUTER_API_KEY;
  const created = await request('/calls', { method: 'POST', body: { contact_name: 'Synthetic fallback upgrade' } });
  const callId = created.body.data.id;
  const closed = await request(`/calls/${callId}/close`, { method: 'POST', body: { final_outcome: 'follow_up', final_notes: 'Recorded local fallback' } });
  assert.equal(closed.body.data.status, 'completed');
  const original = await store.getCallById(callId);
  assert.equal(original.summary.model_name, 'local-deterministic-summary');
  const rowId = original.summary.id;

  process.env.OPENROUTER_API_KEY = 'mock-only-key';
  try {
    configureSummaryGeneratorForTests(async () => ({ summary: 'Local fallback remains available.', modelName: 'local-deterministic-summary' }));
    const failed = await request(`/calls/${callId}/summary`, { method: 'POST', body: {} });
    assert.equal(failed.body.data.model_name, 'local-deterministic-summary');
    assert.equal(failed.body.data.id, rowId);
    assert.equal(failed.body.data.summary_text, original.summary.summary_text);

    configureSummaryGeneratorForTests(async () => ({ summary: 'AI draft with an unsupported commitment: purchase agreed.', modelName: 'mock-openrouter' }));
    const upgraded = await request(`/calls/${callId}/summary`, { method: 'POST', body: {} });
    assert.equal(upgraded.body.data.model_name, 'mock-openrouter');
    assert.equal(upgraded.body.data.id, rowId);
    const after = await store.getCallById(callId);
    assert.equal(after.summary.summary_text, 'AI draft with an unsupported commitment: purchase agreed.');
    assert.equal(after.call.final_outcome, 'follow_up');
    assert.equal(after.call.callback_at, null);
    assert.equal(after.call.do_not_call_confirmed, false);
  } finally {
    resetSummaryControlsForTests();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('summary endpoint limits uncached generation to five requests per minute per IP', async () => {
  resetSummaryControlsForTests();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock-only-key';
  configureSummaryGeneratorForTests(async () => ({ summary: 'Rate fixture summary', modelName: 'mock-openrouter' }));
  const statuses = [];
  for (let index = 0; index < 6; index += 1) {
    const call = await request('/calls', { method: 'POST', body: { contact_name: `Synthetic rate ${index}` } });
    await store.closeCall(call.body.data.id, 'interested', null);
    statuses.push((await request(`/calls/${call.body.data.id}/summary`, { method: 'POST', body: {} })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  resetSummaryControlsForTests();
  if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousKey;
});

test('forwarded IP headers cannot bypass the local rate-limit identity', async () => {
  resetSummaryControlsForTests();
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock-only-key';
  configureSummaryGeneratorForTests(async () => ({ summary: 'Spoof test summary', modelName: 'mock-openrouter' }));
  try {
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const call = await store.createCall({ contact_name: `Synthetic proxy spoof ${index}` });
      await store.closeCall(call.id, 'interested', null);
      statuses.push((await request(`/calls/${call.id}/summary`, { method: 'POST', body: {}, headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` } })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally {
    resetSummaryControlsForTests();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('summary quota windows are independent for distinct trusted client identities', () => {
  resetSummaryControlsForTests();
  for (let index = 0; index < 5; index += 1) consumeSummaryRateLimitForTests('client-a');
  assert.throws(() => consumeSummaryRateLimitForTests('client-a'), { name: 'SummaryRateLimitError' });
  assert.doesNotThrow(() => consumeSummaryRateLimitForTests('client-b'));
  resetSummaryControlsForTests();
});

test('corrupt local data is reported and preserved byte for byte', async () => {
  const dataFile = path.join(temporaryDataDirectory, 'data', 'calls.json');
  const original = '{broken JSON';
  await writeFile(dataFile, original, 'utf8');
  const response = await request('/calls');
  assert.equal(response.status, 500);
  assert.equal(await readFile(dataFile, 'utf8'), original);
  await writeFile(dataFile, JSON.stringify({ calls: [], stageResults: [], summaries: [] }), 'utf8');
  assert.equal((await request('/calls')).status, 200);
});

test('concurrent local JSON mutations preserve stage writes and call closure', async () => {
  const stageCall = await store.createCall({ contact_name: 'Concurrent stage test' });
  const stageResults = await Promise.all([
    store.upsertStageResult({ callId: stageCall.id, stage_number: 1, stage_status: 'completed', notes: 'stage one' }),
    store.upsertStageResult({ callId: stageCall.id, stage_number: 2, stage_status: 'completed', notes: 'stage two' }),
  ]);
  assert.equal(stageResults.length, 2);
  const stagesAfterConcurrentSaves = await store.getCallById(stageCall.id);
  assert.deepEqual(stagesAfterConcurrentSaves.stageResults.map((stage) => stage.notes), ['stage one', 'stage two']);

  const closeRaceCall = await store.createCall({ contact_name: 'Concurrent close test' });
  const [savedStage, closedCall] = await Promise.all([
    store.upsertStageResult({ callId: closeRaceCall.id, stage_number: 3, stage_status: 'completed', notes: 'saved before close' }),
    store.closeCall(closeRaceCall.id, 'next_step_agreed', 'original outcome'),
  ]);
  assert.equal(savedStage.notes, 'saved before close');
  assert.equal(closedCall.final_outcome, 'next_step_agreed');
  const afterCloseRace = await store.getCallById(closeRaceCall.id);
  assert.equal(afterCloseRace.call.status, 'completed');
  assert.equal(afterCloseRace.call.final_outcome, 'next_step_agreed');
  assert.equal(afterCloseRace.stageResults[0].notes, 'saved before close');

  const reverseRaceCall = await store.createCall({ contact_name: 'Concurrent reverse-order test' });
  const reverseResults = await Promise.allSettled([
    store.closeCall(reverseRaceCall.id, 'not_interested', 'first mutation closes'),
    store.upsertStageResult({ callId: reverseRaceCall.id, stage_number: 4, stage_status: 'completed', notes: 'must be rejected' }),
  ]);
  assert.equal(reverseResults[0].status, 'fulfilled');
  assert.equal(reverseResults[1].status, 'rejected');
  assert.ok(reverseResults[1].reason instanceof store.CallAlreadyCompletedError);
  const afterReverseRace = await store.getCallById(reverseRaceCall.id);
  assert.equal(afterReverseRace.call.status, 'completed');
  assert.equal(afterReverseRace.call.final_outcome, 'not_interested');
  assert.deepEqual(afterReverseRace.stageResults, []);
});

test('storage failures return a generic 500 and a later queued mutation can succeed', async () => {
  const dataPath = path.join(temporaryDataDirectory, 'data');
  const backupPath = path.join(temporaryDataDirectory, 'data-preserved');
  const originalConsoleError = console.error;
  const logged = [];
  await rename(dataPath, backupPath);
  await writeFile(dataPath, 'temporary blocker');
  console.error = (entry) => logged.push(String(entry));
  try {
    const failure = await request('/calls', {
      method: 'POST',
      body: { contact_name: 'DO_NOT_LOG_SYNTHETIC_STORAGE_DETAIL' },
    });
    assert.equal(failure.status, 500);
    assert.deepEqual(failure.body.error, {
      code: 'SERVER_ERROR',
      message: 'Internal server error.',
    });
    assert.doesNotMatch(JSON.stringify(failure.body), /EEXIST|temporary blocker|DO_NOT_LOG_SYNTHETIC_STORAGE_DETAIL/);
  } finally {
    console.error = originalConsoleError;
    await unlink(dataPath);
    await rename(backupPath, dataPath);
  }
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged.join('\n'), /EEXIST|DO_NOT_LOG_SYNTHETIC_STORAGE_DETAIL/);

  const createdAfterFailure = await store.createCall({ contact_name: 'Queue recovery check' });
  assert.equal(typeof createdAfterFailure.id, 'string');
});
