import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuestionResponseSchema, fallbackQuestions, generateLiveQuestions, getQuestionContextHash } from '../dist/questions.js';

const call = {
  id: 'call-q1', contact_name: 'Asha', contact_role: 'Operations Manager', company_name: 'Example Co',
  call_purpose: 'Understand how the team handles customer follow-ups', initial_context: 'Caller prepared a short discovery call.',
  status: 'in_progress', final_outcome: null, do_not_call_confirmed: false, final_notes: null,
  callback_at: null, started_at: '2026-10-30T10:00:00Z', completed_at: null,
};
const stage = (stage_number, structured_result = {}, questions = [], notes = null) => ({
  id: `stage-${stage_number}`, call_id: call.id, stage_number, stage_status: 'completed',
  structured_result, questions, notes, updated_at: '2026-10-30T10:01:00Z', created_at: '2026-10-30T10:01:00Z',
});

test('returns contextual fallback recommendations and never marks them asked', () => {
  const result = fallbackQuestions(call, [stage(5, { need: 'Reduce time spent on manual customer follow-ups' })], 5);
  assert.equal(result.status, 'ok');
  assert.equal(result.questions.length, 3);
  assert.match(result.questions[0].question, /Reduce time spent on manual customer follow-ups/);
  assert.equal('asked' in result.questions[0], false);
});

test('does not manufacture fallback questions when context is insufficient', () => {
  const result = fallbackQuestions({ ...call, call_purpose: null, initial_context: null, contact_name: null, contact_role: null }, [], 1);
  assert.deepEqual(result, { status: 'insufficient_context', questions: [] });
});

test('respects refusal, wrong number, ended calls, and already agreed next steps', () => {
  assert.equal(fallbackQuestions(call, [stage(3, { interaction: 'clear_no' })], 5).status, 'no_recommendation');
  assert.equal(fallbackQuestions(call, [stage(1, { interaction: 'wrong_number' })], 1).status, 'no_recommendation');
  assert.equal(fallbackQuestions({ ...call, status: 'completed' }, [], 4).status, 'no_recommendation');
  assert.equal(fallbackQuestions(call, [stage(7, { interaction: 'time_agreed', next_step: 'Demo' })], 7).status, 'no_recommendation');
});

test('does not repeat a question already asked', () => {
  const questions = fallbackQuestions(call, [stage(5, { need: 'Reduce manual follow-ups' }, [
    { id: 'q1', question_text: 'You mentioned “Reduce manual follow-ups.” What would a better result look like for you?', source: 'suggested', asked: true, response: null, position: 0 },
  ])], 5);
  assert.notEqual(questions.status, 'ok');
});

test('uses strict JSON validation for generated output and falls back on malformed output', async () => {
  const bad = await generateLiveQuestions(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5, {
    apiKey: 'test-key', model: 'openrouter/test-model', request: async () => '{"status":"ok","questions":[{"question":"Q","reason":"R","intent":"I","priority":"high","extra":true}]}',
  });
  assert.equal(bad.source, 'fallback');
  assert.equal(bad.status, 'ok');
  const malformedJson = await generateLiveQuestions(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5, {
    apiKey: 'test-key', model: 'openrouter/test-model', request: async () => '{ not valid JSON',
  });
  assert.equal(malformedJson.source, 'fallback');
  assert.equal(malformedJson.status, 'ok');

  const goodPayload = { status: 'ok', questions: [1, 2, 3].map((number) => ({ question: `Question ${number}?`, reason: 'Based on recorded context.', intent: 'Clarify the stated need.', priority: 'medium' })) };
  const good = await generateLiveQuestions(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5, {
    apiKey: 'test-key', model: 'openrouter/test-model', request: async () => JSON.stringify(goodPayload),
  });
  assert.equal(good.source, 'openrouter');
  assert.deepEqual(QuestionResponseSchema.parse({ status: good.status, questions: good.questions }), goodPayload);
});

test('question context hash changes when relevant saved evidence changes', () => {
  const original = getQuestionContextHash(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5);
  const changed = getQuestionContextHash(call, [stage(5, { need: 'Reduce reporting delays' })], 5);
  assert.notEqual(original, changed);
});

test('extracts and validates JSON text from OpenRouter chat completion content', async () => {
  const payload = { status: 'ok', questions: [1, 2, 3].map((number) => ({
    question: `OpenRouter question ${number}?`, reason: 'Grounded in saved context.', intent: 'Clarify a recorded need.', priority: 'high',
  })) };
  const result = await generateLiveQuestions(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5, {
    apiKey: 'mock-key', model: 'openrouter/test-model',
    fetch: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    },
  });
  assert.equal(result.source, 'openrouter');
  assert.deepEqual(QuestionResponseSchema.parse({ status: result.status, questions: result.questions }), payload);
});

test('question cache identity changes when the configured model changes', () => {
  const previousModel = process.env.OPENROUTER_MODEL;
  try {
    process.env.OPENROUTER_MODEL = 'openrouter/model-a';
    const modelA = getQuestionContextHash(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5);
    process.env.OPENROUTER_MODEL = 'openrouter/model-b';
    const modelB = getQuestionContextHash(call, [stage(5, { need: 'Reduce manual follow-ups' })], 5);
    assert.notEqual(modelA, modelB);
  } finally {
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
  }
});
