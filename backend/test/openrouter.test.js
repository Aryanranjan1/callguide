import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENROUTER_ENDPOINT, OpenRouterError, getOpenRouterConfiguration, requestOpenRouterText,
} from '../dist/openrouter.js';

const request = {
  apiKey: 'secret-test-key', model: 'provider/model-configured-in-env', systemInstruction: 'Keep this instruction unchanged.',
  contents: 'Synthetic test input only.', timeoutMs: 1_000,
};

function successResponse(content = 'generated text', extra = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

test('sends a standard OpenRouter chat completion request using the configured model', async () => {
  let captured;
  const result = await requestOpenRouterText({ ...request, siteUrl: 'https://callguide.example', appName: 'CallGuide Test' }, async (url, init) => {
    captured = { url, init };
    return successResponse('  summary text  ', { usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
  });
  assert.equal(captured.url, OPENROUTER_ENDPOINT);
  assert.equal(captured.init.method, 'POST');
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer secret-test-key');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('HTTP-Referer'), 'https://callguide.example');
  assert.equal(headers.get('X-OpenRouter-Title'), 'CallGuide Test');
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: request.model,
    messages: [
      { role: 'system', content: request.systemInstruction },
      { role: 'user', content: request.contents },
    ],
  });
  assert.equal(result.text, 'summary text');
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
});

test('adds JSON response format for live suggested questions', async () => {
  const content = JSON.stringify({ status: 'ok', questions: [] });
  const result = await requestOpenRouterText({ ...request, responseMimeType: 'application/json' }, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return successResponse(content);
  });
  assert.equal(JSON.parse(result.text).status, 'ok');
});

test('configuration requires backend key and model, reads env model, and keeps attribution optional', () => {
  assert.throws(() => getOpenRouterConfiguration({ AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: 'some/model' }), (error) => error.category === 'missing_api_key');
  assert.throws(() => getOpenRouterConfiguration({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'private-key' }), (error) => error.category === 'missing_model');
  const config = getOpenRouterConfiguration({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'private-key', OPENROUTER_MODEL: 'some/model' });
  assert.equal(config.model, 'some/model');
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(config.siteUrl, undefined);
  assert.equal(config.appName, undefined);
  assert.throws(() => getOpenRouterConfiguration({ AI_PROVIDER: 'other', OPENROUTER_API_KEY: 'private-key', OPENROUTER_MODEL: 'some/model' }), (error) => error.category === 'unsupported_provider');
});

test('classifies HTTP errors without exposing provider response bodies', async (t) => {
  const statuses = [
    [400, 'invalid_request'], [401, 'authentication_failure'], [402, 'payment_required'],
    [403, 'forbidden'], [408, 'timeout'], [429, 'rate_limited'], [500, 'provider_server_error'], [503, 'provider_server_error'],
  ];
  for (const [status, category] of statuses) await t.test(String(status), async () => {
    await assert.rejects(requestOpenRouterText(request, async () => new Response('private provider detail with key secret-test-key', { status })), (error) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, status);
      assert.equal(error.category, category);
      assert.doesNotMatch(error.message, /private provider detail|secret-test-key/);
      return true;
    });
  });
});

test('rejects invalid JSON, missing choices, missing content, and empty content', async (t) => {
  const cases = [
    ['invalid JSON', new Response('{', { status: 200 }), 'invalid_json_response'],
    ['missing choices', new Response(JSON.stringify({ choices: [] }), { status: 200 }), 'missing_choices'],
    ['missing content', new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }), 'missing_content'],
    ['empty content', successResponse('  '), 'empty_content'],
  ];
  for (const [name, response, category] of cases) await t.test(name, async () => {
    await assert.rejects(requestOpenRouterText(request, async () => response), (error) => error.category === category);
  });
});

test('classifies network errors and aborts timed-out fetch requests', async () => {
  await assert.rejects(requestOpenRouterText(request, async () => { throw new Error('private network detail'); }), (error) => error.category === 'network_error' && !/private network detail/.test(error.message));
  await assert.rejects(requestOpenRouterText({ ...request, timeoutMs: 10 }, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  })), (error) => error.category === 'timeout');
});
