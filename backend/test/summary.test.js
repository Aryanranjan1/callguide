import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleGenAI } from '@google/genai';
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

async function getSdkError({ fetch, config = {} }) {
  const ai = new GoogleGenAI({ apiKey: 'offline-test-key', httpOptions: { fetch } });
  try {
    await ai.models.generateContent({ model: 'gemini-offline-test', contents: 'synthetic test input', config });
  } catch (error) {
    return error;
  }
  assert.fail('Expected the mocked SDK request to fail.');
}

function waitForSdkAbort(_input, init) {
  return new Promise((_resolve, reject) => {
    const rejectOnAbort = () => {
      clearTimeout(watchdog);
      reject(init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    };
    const watchdog = setTimeout(() => reject(new Error('Mock fetch was not aborted.')), 1000);
    if (init.signal.aborted) rejectOnAbort();
    else init.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
}

async function summarizeFailedRequest(error) {
  const events = [];
  const result = await generateCallSummary(call, stages, {
    apiKey: 'never-log-this-key',
    logger: (event) => events.push(event),
    request: async () => { throw error; },
  });
  return { result, events };
}

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
      assert.equal(requestBody.generationConfig.temperature, undefined);
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

test('emits a safe structured fallback event when the API key is missing', async () => {
  const events = [];
  const result = await generateCallSummary(call, stages, { apiKey: '   ', logger: (event) => events.push(event) });

  assert.equal(result.modelName, 'local-deterministic-summary');
  assert.equal(events[0].event, 'gemini_summary_fallback');
  assert.equal(events[0].reason, 'missing_api_key');
  assert.equal(events[0].model, DEFAULT_GEMINI_MODEL);
});

test('logs successful Gemini generation without request content or credentials', async () => {
  const events = [];
  const result = await generateCallSummary(call, stages, {
    apiKey: 'do-not-log-this-key',
    model: 'gemini-test-model',
    logger: (event) => events.push(event),
    request: async () => 'Gemini generated text.',
  });

  assert.equal(result.modelName, 'gemini-test-model');
  assert.deepEqual(events.map(({ event }) => event), ['gemini_summary_generated']);
  assert.doesNotMatch(JSON.stringify(events), /do-not-log-this-key|Needs faster reporting/);
});

test('classifies provider errors safely without logging messages or call data', async (t) => {
  const cases = [
    ['model not found', Object.assign(new Error('model not found private-detail'), { status: 404 }), 'model_not_found'],
    ['quota failure', Object.assign(new Error('quota private-detail'), { status: 429 }), 'quota_or_rate_limit'],
    ['invalid request', Object.assign(new Error('invalid private-detail'), { status: 400 }), 'invalid_request'],
    ['network failure', Object.assign(new Error('fetch failed private-detail'), { cause: { code: 'ECONNRESET' } }), 'network_error'],
  ];

  for (const [name, failure, reason] of cases) {
    await t.test(name, async () => {
      const events = [];
      const result = await generateCallSummary(call, stages, {
        apiKey: 'do-not-log-this-key',
        logger: (event) => events.push(event),
        request: async () => { throw failure; },
      });

      assert.equal(result.modelName, 'local-deterministic-summary');
      assert.equal(events[0].reason, reason);
      assert.doesNotMatch(JSON.stringify(events), /do-not-log-this-key|private-detail|Needs faster reporting/);
    });
  }
});

test('classifies realistic SDK authentication errors before generic HTTP 400 errors', async (t) => {
  const cases = [
    ['Google invalid API key message', { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 'authentication_failure'],
    ['API_KEY_INVALID message', { error: { code: 400, message: 'API_KEY_INVALID', status: 'INVALID_ARGUMENT' } }, 'authentication_failure'],
    ['permission denied', { error: { code: 403, message: 'Permission denied for this API key.', status: 'PERMISSION_DENIED' } }, 'authentication_failure'],
    ['unrelated invalid request', { error: { code: 400, message: 'Unsupported generation parameter.', status: 'INVALID_ARGUMENT' } }, 'invalid_request'],
  ];

  for (const [name, body, reason] of cases) {
    await t.test(name, async () => {
      const error = await getSdkError({
        fetch: async () => new Response(JSON.stringify(body), { status: body.error.code, headers: { 'Content-Type': 'application/json' } }),
      });

      assert.equal(error.name, 'ApiError');
      assert.equal(error.status, body.error.code);
      const { result, events } = await summarizeFailedRequest(error);
      assert.equal(result.modelName, 'local-deterministic-summary');
      assert.equal(events[0].reason, reason);
      assert.equal(events[0].provider_status, body.error.code);
      assert.doesNotMatch(JSON.stringify(events), /never-log-this-key|API key not valid|API_KEY_INVALID|Permission denied|Unsupported generation parameter|Needs faster reporting/);
    });
  }
});

test('classifies the installed SDK timeout error shape from HTTP timeout and abort signal', async (t) => {
  const cases = [
    ['SDK HTTP timeout', async () => getSdkError({
      fetch: waitForSdkAbort,
      config: { httpOptions: { timeout: 20 } },
    })],
    ['SDK caller abort signal', async () => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 10);
      try {
        return await getSdkError({
          fetch: waitForSdkAbort,
          config: { httpOptions: { timeout: 1000 }, abortSignal: controller.signal },
        });
      } finally {
        clearTimeout(abortTimer);
      }
    }],
  ];

  for (const [name, requestSdkError] of cases) {
    await t.test(name, async () => {
      const error = await requestSdkError();
      // @google/genai 2.32.0 exposes the aborted fetch as Node's native DOMException.
      assert.equal(error.constructor.name, 'DOMException');
      assert.equal(error.name, 'AbortError');
      assert.equal(error.message, 'This operation was aborted');

      const { result, events } = await summarizeFailedRequest(error);
      assert.equal(result.modelName, 'local-deterministic-summary');
      assert.equal(events[0].reason, 'timeout');
      assert.doesNotMatch(JSON.stringify(events), /never-log-this-key|This operation was aborted|Needs faster reporting/);
    });
  }
});

test('logs an empty Gemini response distinctly and preserves fallback behavior', async () => {
  const events = [];
  const result = await generateCallSummary(call, stages, {
    apiKey: 'mock-api-key',
    logger: (event) => events.push(event),
    request: async () => '  ',
  });

  assert.equal(result.modelName, 'local-deterministic-summary');
  assert.equal(events[0].reason, 'empty_response');
  assert.match(result.summary, /Needs faster reporting/);
});
