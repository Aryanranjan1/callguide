import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GEMINI_MODEL, GEMINI_REQUEST_TIMEOUT_MS, generateCallSummary } from '../dist/summary.js';

const call = {
  id: 'call-1',
  contact_name: 'Alex',
  company_name: 'Example Co',
  call_purpose: 'Discuss workflow needs',
  final_outcome: null,
};

const stages = [{
  id: 'stage-1',
  call_id: 'call-1',
  stage_number: 1,
  stage_status: 'completed',
  notes: 'Needs faster reporting.',
  structured_result: { need: 'Faster reporting' },
}];

test('uses the deterministic summary when the Gemini key is absent', async () => {
  let called = false;
  const result = await generateCallSummary(call, stages, {
    apiKey: '',
    request: async () => { called = true; return 'unexpected'; },
  });

  assert.equal(called, false);
  assert.equal(result.modelName, 'local-deterministic-summary');
  assert.match(result.summary, /Alex/);
  assert.match(result.summary, /Needs faster reporting/);
});

test('sends the preserved source and safety instructions to the configured Gemini model', async () => {
  let captured;
  const result = await generateCallSummary(call, stages, {
    apiKey: 'placeholder-key',
    model: 'gemini-test-model',
    request: async (request) => {
      captured = request;
      return '  Prospect needs faster reporting.  ';
    },
  });

  assert.equal(captured.model, 'gemini-test-model');
  assert.equal(captured.apiKey, 'placeholder-key');
  assert.equal(captured.timeoutMs, GEMINI_REQUEST_TIMEOUT_MS);
  assert.match(captured.systemInstruction, /Never invent facts/);
  assert.match(captured.contents, /Do not fabricate names, dates, or commitments/);
  assert.match(captured.contents, /Needs faster reporting/);
  assert.equal(result.summary, 'Prospect needs faster reporting.');
  assert.equal(result.modelName, 'gemini-test-model');
});

test('uses the official SDK through the supplied mock fetch without contacting Google', async () => {
  const result = await generateCallSummary(call, stages, {
    apiKey: 'mock-api-key',
    model: 'gemini-test-model',
    fetch: async (input, init) => {
      const url = new URL(input);
      assert.match(url.pathname, /models\/gemini-test-model:generateContent$/);
      assert.equal(init.method, 'POST');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-goog-api-key'), 'mock-api-key');
      assert.equal(headers.get('x-server-timeout'), '15');
      assert.ok(init.signal instanceof AbortSignal);
      const requestBody = JSON.parse(init.body);
      assert.equal(requestBody.generationConfig.temperature, 0.2);
      assert.match(JSON.stringify(requestBody), /Do not fabricate names, dates, or commitments/);
      assert.match(JSON.stringify(requestBody), /Needs faster reporting/);
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini mock summary.' }] }, finishReason: 'STOP' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(result.summary, 'Gemini mock summary.');
  assert.equal(result.modelName, 'gemini-test-model');
});

test('uses the documented model default and falls back for empty model responses', async () => {
  const previousModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = '';
  let result;
  try {
    result = await generateCallSummary(call, stages, {
      apiKey: 'placeholder-key',
      request: async (request) => {
        assert.equal(request.model, DEFAULT_GEMINI_MODEL);
        return '  ';
      },
    });
  } finally {
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }

  assert.equal(result.modelName, 'local-deterministic-summary');
  assert.match(result.summary, /No unrecorded|original notes/i);
});

test('falls back safely when the Gemini request fails or times out', async () => {
  const result = await generateCallSummary(call, stages, {
    apiKey: 'placeholder-key',
    request: async () => { throw new Error('mock timeout'); },
  });

  assert.equal(result.modelName, 'local-deterministic-summary');
  assert.match(result.summary, /Needs faster reporting/);
  assert.doesNotMatch(result.summary, /placeholder-key|mock timeout/);
});
