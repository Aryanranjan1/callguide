import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { CallAlreadyCompletedError, InvalidCallCursorError, closeCall, closeStore, createCall, findSummaryBySourceHash, getCallAnalytics, getCallById, getPersistenceMode, getStoreHealth, initializeStore, listCallsPage, listUpcomingCallbacks, saveSummary, upsertStageResult, withSummaryGenerationLock, type CallListCursor } from './store.js';
import { createSummaryContext, generateCallSummary } from './summary.js';
import { fallbackQuestions, generateLiveQuestions, getQuestionContextHash, type QuestionGenerationResult } from './questions.js';
import { isOpenRouterConfigured } from './openrouter.js';
import type { ApiEnvelope, Call, CallOutcome, CallStageResult, CallSummary, StageQuestion, StageStatus } from './types.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const isProduction = process.env.NODE_ENV === 'production';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim() || (isProduction ? '' : 'http://localhost:3000');
if (!frontendOrigin) throw new Error('FRONTEND_ORIGIN is required in production.');
const allowedOrigins = isProduction ? [frontendOrigin] : [frontendOrigin, 'http://localhost:3000', 'http://127.0.0.1:3000'];

app.set('trust proxy', isProduction ? 1 : false);
app.use(cors({ origin: allowedOrigins, exposedHeaders: ['X-Next-Cursor', 'X-Total-Count', 'X-Page-Count', 'X-Has-More'] }));
app.use(express.json({ limit: '1mb' }));

const withEnvelope = <T>(data: T | null, error: { code: string; message: string } | null = null): ApiEnvelope<T> => ({
  data,
  error,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'ApiError', 'DOMException', 'OpenRouterError', 'CallAlreadyCompletedError']);
const summaryInFlight = new Map<string, Promise<CallSummary | null>>();
const summaryRateWindows = new Map<string, { startedAt: number; count: number }>();
const questionInFlight = new Map<string, Promise<QuestionGenerationResult>>();
const questionResponseCache = new Map<string, { result: QuestionGenerationResult; expiresAt: number }>();
const questionRateWindows = new Map<string, { startedAt: number; count: number }>();
const SUMMARY_RATE_LIMIT = 5;
const SUMMARY_RATE_WINDOW_MS = 60_000;
const QUESTION_RATE_LIMIT = 8;
const QUESTION_CACHE_TTL_MS = 5 * 60_000;
const MAX_SUMMARY_SNAPSHOT_RETRIES = 3;
let summaryGenerator = generateCallSummary;
let questionGenerator = generateLiveQuestions;

export function configureSummaryGeneratorForTests(generator: typeof generateCallSummary | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Summary generator overrides are only available in tests.');
  summaryGenerator = generator ?? generateCallSummary;
}

export function configureQuestionGeneratorForTests(generator: typeof generateLiveQuestions | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Question generator overrides are only available in tests.');
  questionGenerator = generator ?? generateLiveQuestions;
}

export function resetSummaryControlsForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Summary controls can only be reset in tests.');
  summaryInFlight.clear();
  summaryRateWindows.clear();
  questionInFlight.clear();
  questionResponseCache.clear();
  questionRateWindows.clear();
  summaryGenerator = generateCallSummary;
  questionGenerator = generateLiveQuestions;
}

class SummaryRateLimitError extends Error {
  constructor() { super('Summary generation rate limit reached.'); this.name = 'SummaryRateLimitError'; }
}
class SummarySourceChangedError extends Error {
  constructor() { super('Call data changed during summary generation.'); this.name = 'SummarySourceChangedError'; }
}

function encodeCursor(cursor: CallListCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: unknown): CallListCursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new InvalidCallCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CallListCursor>;
    const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    if (!parsed || !validDate(parsed.createdAt) || !validDate(parsed.snapshotCreatedAt)
      || typeof parsed.id !== 'string' || !isUuid(parsed.id)
      || typeof parsed.snapshotId !== 'string' || !isUuid(parsed.snapshotId)
      || typeof parsed.filterKey !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.filterKey)
      || !['newest', 'oldest'].includes(parsed.sort as string)) throw new InvalidCallCursorError();
    return parsed as CallListCursor;
  } catch (error) {
    if (error instanceof InvalidCallCursorError) throw error;
    throw new InvalidCallCursorError();
  }
}

function consumeSummaryRateLimit(key: string) {
  const now = Date.now();
  const window = summaryRateWindows.get(key);
  if (!window || now - window.startedAt >= SUMMARY_RATE_WINDOW_MS) summaryRateWindows.set(key, { startedAt: now, count: 1 });
  else if (window.count >= SUMMARY_RATE_LIMIT) throw new SummaryRateLimitError();
  else window.count += 1;
  if (summaryRateWindows.size > 5000) for (const [ip, entry] of summaryRateWindows) if (now - entry.startedAt >= SUMMARY_RATE_WINDOW_MS) summaryRateWindows.delete(ip);
}

function consumeQuestionRateLimit(key: string) {
  const now = Date.now();
  const window = questionRateWindows.get(key);
  if (!window || now - window.startedAt >= SUMMARY_RATE_WINDOW_MS) questionRateWindows.set(key, { startedAt: now, count: 1 });
  else if (window.count >= QUESTION_RATE_LIMIT) throw new SummaryRateLimitError();
  else window.count += 1;
  if (questionRateWindows.size > 5000) for (const [ip, entry] of questionRateWindows) if (now - entry.startedAt >= SUMMARY_RATE_WINDOW_MS) questionRateWindows.delete(ip);
}

export function consumeSummaryRateLimitForTests(key: string) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Summary rate-limit controls are only available in tests.');
  consumeSummaryRateLimit(key);
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function hasOnlyKeys(value: unknown, keys: string[]) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key)));
}

function logSafeError(operation: string, error: unknown) {
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown }
    : undefined;
  const name = typeof candidate?.name === 'string' && SAFE_ERROR_NAMES.has(candidate.name) ? candidate.name : 'Error';
  const rawCode = typeof candidate?.code === 'string' ? candidate.code : '';
  const code = /^[A-Z0-9]{5}$/.test(rawCode) || ['entity.parse.failed', 'request.aborted', 'entity.too.large'].includes(rawCode)
    ? rawCode
    : undefined;
  const status = typeof candidate?.status === 'number' ? candidate.status
    : typeof candidate?.statusCode === 'number' ? candidate.statusCode
    : undefined;
  console.error(JSON.stringify({
    event: 'request_failed',
    operation,
    error_type: name,
    ...(code ? { error_code: code } : {}),
    ...(Number.isInteger(status) ? { provider_status: status } : {}),
  }));
}

function respondWithInternalError(res: express.Response, operation: string, error: unknown) {
  logSafeError(operation, error);
  return res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: 'Internal server error.' }));
}

function respondWithExpressError(res: express.Response, error: Error & { status?: number; statusCode?: number }) {
  const status = error.status ?? error.statusCode;
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status < 500) {
    logSafeError('http_request', error);
    return res.status(status).json(withEnvelope(null, {
      code: 'REQUEST_ERROR',
      message: 'Request could not be processed.',
    }));
  }
  return respondWithInternalError(res, 'http_request', error);
}

function respondWithInvalidId(res: express.Response) {
  return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Call ID must be a valid UUID.' }));
}

function validateText(value: unknown, maxLength = 2000): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  if (value.length > maxLength) return null;
  return value.trim() || null;
}

const stageInteractions: Record<number, string[]> = {
  1: ['right_person', 'reception', 'cant_talk_now', 'wrong_number'],
  2: ['understood', 'asked_what_we_do', 'asked_why_free', 'asked_source_of_number'],
  3: ['clear_yes', 'call_later', 'clear_no', 'continued_without_yes'],
  4: ['described_work', 'corrected_us', 'asked_about_us', 'not_their_area'],
  5: ['stated_goal', 'no_need', 'only_yes_no', 'asked_what_we_can_do'],
  6: ['not_right_person', 'has_provider', 'send_details_first', 'no_reason'],
  7: ['time_agreed', 'agreed_to_receive', 'referred', 'nothing_agreed'],
};

function validateStructuredResult(stage: number, value: unknown): string | null {
  if (!hasOnlyKeys(value, stage === 1 ? ['interaction', 'flags']
    : stage === 5 ? ['interaction', 'need']
      : stage === 6 ? ['interaction', 'objection']
        : stage === 7 ? ['interaction', 'next_step', 'next_step_owner', 'next_step_channel', 'referral_details', 'referral_contact_provided']
          : stageInteractions[stage] ? ['interaction'] : [])) return 'Structured stage data contains unsupported fields.';
  const data = value as Record<string, unknown>;
  if (stageInteractions[stage]) {
    const interaction = data.interaction;
    if (interaction !== undefined && interaction !== '' && (typeof interaction !== 'string' || !stageInteractions[stage]!.includes(interaction))) return 'Stage result is not valid for this stage.';
  } else if ('interaction' in data) return 'This stage does not accept an interaction value.';
  if (stage === 1 && data.flags !== undefined) {
    if (!hasOnlyKeys(data.flags, ['language_handoff', 'poor_line']) || Object.values(data.flags as Record<string, unknown>).some((flag) => typeof flag !== 'boolean')) return 'Stage flags must contain boolean values only.';
  }
  for (const field of ['need', 'objection', 'next_step', 'referral_details'] as const) {
    if (data[field] !== undefined && (typeof data[field] !== 'string' || data[field].length > 1000)) return `${field} must be text no longer than 1,000 characters.`;
  }
  if (stage === 7) {
    const interaction = data.interaction;
    const dependencies: Record<string, string[]> = {
      next_step_owner: ['time_agreed'], next_step_channel: ['agreed_to_receive'],
      referral_details: ['referred'], referral_contact_provided: ['referred'], next_step: ['time_agreed', 'agreed_to_receive', 'referred'],
    };
    for (const [field, allowed] of Object.entries(dependencies)) if (data[field] !== undefined && !allowed.includes(String(interaction))) return `${field} is not valid for this stage result.`;
    if (data.next_step_owner !== undefined && !['prospect', 'caller'].includes(String(data.next_step_owner))) return 'Next-step owner is invalid.';
    if (data.next_step_channel !== undefined && !['email', 'whatsapp'].includes(String(data.next_step_channel))) return 'Next-step channel is invalid.';
    if (data.referral_contact_provided !== undefined && !['provided', 'vague'].includes(String(data.referral_contact_provided))) return 'Referral contact status is invalid.';
  }
  return null;
}

async function saveDeterministicFallback(callId: string) {
  try {
    const result = await getCallById(callId);
    if (!result) return;
    const context = createSummaryContext(result.call, result.stageResults);
    const sourceHash = context.sourceHash;
    if (await findSummaryBySourceHash(callId, sourceHash)) return;
    const generated = await generateCallSummary(result.call, result.stageResults, { apiKey: '' });
    await saveSummary(callId, generated.summary, generated.modelName, {
      call_id: callId,
      stage_count: result.stageResults.length,
      final_outcome: result.call.final_outcome,
      prompt_version: context.promptVersion,
      output_contract_version: context.outputContractVersion,
      source_hash: sourceHash,
    }, sourceHash);
  } catch (error) {
    // The call has already been closed. A summary storage failure must not
    // turn a successful closure into a client-visible failure.
    logSafeError('save_fallback_summary', error);
  }
}

app.get('/health', async (_req, res) => {
  res.json(withEnvelope({
    status: 'ok',
    persistence: getPersistenceMode(),
    database: await getStoreHealth(),
    openrouter: isOpenRouterConfigured() ? 'configured' : 'not_configured',
  }, null));
});

app.get('/calls', async (req, res) => {
  try {
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Limit must be an integer from 1 to 200.' }));
    }
    const query = req.query.q;
    const status = req.query.status;
    const outcome = req.query.outcome;
    const startedAfter = req.query.started_after;
    const startedBefore = req.query.started_before;
    const sort = req.query.sort ?? 'newest';
    const outcomes: string[] = ['next_step_agreed', 'agreed_to_receive_report', 'interested', 'follow_up', 'call_again', 'not_interested', 'do_not_call', 'wrong_person', 'moved_company', 'follow_up_agreed', 'meeting_agreed', 'information_requested', 'no_contact_made', 'no_clear_outcome', 'other'];
    if ((query !== undefined && (typeof query !== 'string' || query.length > 255))
      || (status !== undefined && !['in_progress', 'completed'].includes(String(status)))
      || (outcome !== undefined && !outcomes.includes(String(outcome)))
      || (sort !== 'newest' && sort !== 'oldest')) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'One or more call list filters are invalid.' }));
    }
    for (const dateValue of [startedAfter, startedBefore]) {
      if (dateValue !== undefined && (typeof dateValue !== 'string' || !Number.isFinite(Date.parse(dateValue)))) {
        return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Date filters must be valid timestamps.' }));
      }
    }
    if (typeof startedAfter === 'string' && typeof startedBefore === 'string' && Date.parse(startedAfter) >= Date.parse(startedBefore)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'The start of the date range must precede its end.' }));
    }
    const cursor = decodeCursor(req.query.cursor);
    if (cursor && cursor.sort !== sort) throw new InvalidCallCursorError();
    const page = await listCallsPage(rawLimit === undefined ? 100 : Number(rawLimit), {
      ...(typeof query === 'string' ? { query } : {}),
      ...(typeof status === 'string' ? { status: status as 'in_progress' | 'completed' } : {}),
      ...(typeof outcome === 'string' ? { outcome } : {}),
      ...(typeof startedAfter === 'string' ? { startedAfter } : {}),
      ...(typeof startedBefore === 'string' ? { startedBefore } : {}),
      sort: sort as 'newest' | 'oldest',
    }, cursor);
    res.setHeader('X-Total-Count', String(page.totalCount));
    res.setHeader('X-Page-Count', String(page.calls.length));
    res.setHeader('X-Has-More', String(Boolean(page.nextCursor)));
    if (page.nextCursor) res.setHeader('X-Next-Cursor', encodeCursor(page.nextCursor));
    res.json(withEnvelope(page.calls, null));
  } catch (error) {
    if (error instanceof InvalidCallCursorError) return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Call list cursor is invalid or no longer matches these filters.' }));
    respondWithInternalError(res, 'list_calls', error);
  }
});

app.get('/calls/callbacks', async (_req, res) => {
  try {
    return res.json(withEnvelope(await listUpcomingCallbacks(), null));
  } catch (error) {
    return respondWithInternalError(res, 'list_callbacks', error);
  }
});

app.get('/calls/analytics', async (req, res) => {
  try {
    const period = req.query.period ?? 'daily';
    const timeZone = req.query.timezone ?? 'UTC';
    const dateFrom = req.query.from;
    const dateTo = req.query.to;
    const validDate = (value: unknown) => value === undefined || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
    if ((period !== 'daily' && period !== 'weekly') || typeof timeZone !== 'string' || timeZone.length > 100 || !validDate(dateFrom) || !validDate(dateTo) || (typeof dateFrom === 'string' && typeof dateTo === 'string' && dateFrom > dateTo)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Analytics period or timezone is invalid.' }));
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); }
    catch { return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Analytics timezone is invalid.' })); }
    return res.json(withEnvelope(await getCallAnalytics(period, timeZone, typeof dateFrom === 'string' ? dateFrom : undefined, typeof dateTo === 'string' ? dateTo : undefined), null));
  } catch (error) {
    return respondWithInternalError(res, 'call_analytics', error);
  }
});

app.post('/calls', async (req, res) => {
  try {
    if (!hasOnlyKeys(req.body, ['contact_name', 'company_name', 'contact_role', 'call_purpose', 'initial_context'])) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Call contains unsupported fields.' }));
    }
    const { contact_name, company_name, contact_role, call_purpose, initial_context } = req.body ?? {};
    const limits: Record<string, number> = { contact_name: 255, company_name: 255, contact_role: 255, call_purpose: 2000, initial_context: 4000 };
    for (const [field, maximum] of Object.entries(limits)) {
      const value = req.body[field];
      if (value != null && (typeof value !== 'string' || value.length > maximum)) {
        return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: `${field} must be text no longer than ${maximum} characters.` }));
      }
    }
    const requiredCallFields = ['contact_name', 'contact_role', 'company_name', 'call_purpose'] as const;
    const missingRequiredField = requiredCallFields.find((field) => typeof req.body[field] !== 'string' || !req.body[field].trim());
    if (missingRequiredField) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: `${missingRequiredField} is required.` }));
    }
    const call = await createCall({
      contact_name: validateText(contact_name, 255),
      company_name: validateText(company_name, 255),
      contact_role: validateText(contact_role, 255),
      call_purpose: validateText(call_purpose, 2000),
      initial_context: validateText(initial_context, 4000),
    });

    res.status(201).json(withEnvelope(call, null));
  } catch (error) {
    respondWithInternalError(res, 'create_call', error);
  }
});

app.get('/calls/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return respondWithInvalidId(res);
  try {
    const result = await getCallById(req.params.id);
    if (!result) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }
    const context = createSummaryContext(result.call, result.stageResults);
    const summary = result.summary && (!result.summary.source_hash || result.summary.source_hash === context.sourceHash) ? result.summary : null;
    return res.json(withEnvelope({ ...result.call, stageResults: result.stageResults, summary }, null));
  } catch (error) {
    return respondWithInternalError(res, 'get_call', error);
  }
});

app.post('/calls/:id/questions', async (req, res) => {
  if (!isUuid(req.params.id)) return respondWithInvalidId(res);
  try {
    if (!hasOnlyKeys(req.body, ['stage_number', 'force_refresh'])) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Question request contains unsupported fields.' }));
    }
    const stageNumber = Number(req.body?.stage_number);
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 8
      || (req.body?.force_refresh !== undefined && typeof req.body.force_refresh !== 'boolean')) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Question request is invalid.' }));
    }
    const callRecord = await getCallById(req.params.id);
    if (!callRecord) return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));

    const { call, stageResults } = callRecord;
    const cacheKey = getQuestionContextHash(call, stageResults, stageNumber);
    const forceRefresh = req.body.force_refresh === true;
    if (!forceRefresh) {
      const cached = questionResponseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return res.json(withEnvelope(cached.result, null));
      if (cached) questionResponseCache.delete(cacheKey);
    }

    let generation = questionInFlight.get(cacheKey);
    if (!generation) {
      try {
        consumeQuestionRateLimit(req.ip || req.socket.remoteAddress || 'unknown');
      } catch {
        return res.json(withEnvelope({ ...fallbackQuestions(call, stageResults, stageNumber), source: 'fallback' }, null));
      }
      generation = questionGenerator(call, stageResults, stageNumber);
      questionInFlight.set(cacheKey, generation);
      void generation.then((result) => {
        if (result.source === 'openrouter' && result.status === 'ok') {
          questionResponseCache.set(cacheKey, { result, expiresAt: Date.now() + QUESTION_CACHE_TTL_MS });
          if (questionResponseCache.size > 500) questionResponseCache.delete(questionResponseCache.keys().next().value!);
        }
      }, () => undefined).then(() => {
        if (questionInFlight.get(cacheKey) === generation) questionInFlight.delete(cacheKey);
      });
    }
    return res.json(withEnvelope(await generation, null));
  } catch (error) {
    return respondWithInternalError(res, 'generate_questions', error);
  }
});

app.post('/calls/:id/stages', async (req, res) => {
  if (!isUuid(req.params.id)) return respondWithInvalidId(res);
  try {
    if (!hasOnlyKeys(req.body, ['stage_number', 'stage_status', 'notes', 'structured_result', 'questions', 'callback_at'])) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage contains unsupported fields.' }));
    }
    const { stage_number, stage_status, notes, structured_result, questions, callback_at } = req.body ?? {};
    const stageNumber = Number(stage_number);
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 8) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage number must be between 1 and 8.' }));
    }
    const validStageStatuses: StageStatus[] = ['not_started', 'in_progress', 'completed'];
    if (stage_status != null && !validStageStatuses.includes(stage_status)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage status is invalid.' }));
    }
    if (notes != null && (typeof notes !== 'string' || notes.length > 4000)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage notes must be text no longer than 4,000 characters.' }));
    }
    const structuredError = validateStructuredResult(stageNumber, structured_result ?? {});
    if (structuredError) return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: structuredError }));
    if (callback_at !== undefined && callback_at !== null && (typeof callback_at !== 'string' || !Number.isFinite(Date.parse(callback_at)))) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Callback time must be a valid date and time.' }));
    }
    const interaction = (structured_result as Record<string, unknown> | undefined)?.interaction;
    if (callback_at !== undefined && (stageNumber !== 3 && stageNumber !== 7
      || (callback_at !== null && !((stageNumber === 3 && interaction === 'call_later') || (stageNumber === 7 && interaction === 'time_agreed'))))) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Callback time is only valid for a recorded call-later or agreed-time result.' }));
    }
    if (questions !== undefined && (!Array.isArray(questions) || questions.length > 40)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage questions must be a list with no more than 40 items.' }));
    }
    const validatedQuestions: StageQuestion[] | undefined = questions === undefined ? undefined : [];
    if (Array.isArray(questions)) {
      const seenIds = new Set<string>();
      for (const [index, item] of questions.entries()) {
        if (!hasOnlyKeys(item, ['id', 'question_text', 'source', 'asked', 'response', 'position'])
          || typeof item.id !== 'string' || !isUuid(item.id) || seenIds.has(item.id)
          || typeof item.question_text !== 'string' || !item.question_text.trim() || item.question_text.length > 240
          || !['suggested', 'custom'].includes(item.source)
          || typeof item.asked !== 'boolean'
          || (item.response !== null && (typeof item.response !== 'string' || item.response.length > 1000))
          || item.position !== index) {
          return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'A stage question is invalid.' }));
        }
        seenIds.add(item.id);
        validatedQuestions?.push({
          id: item.id, question_text: item.question_text.trim(), source: item.source,
          asked: item.asked, response: typeof item.response === 'string' ? item.response : null, position: index,
        });
      }
    }

    const call = await getCallById(req.params.id);
    if (!call) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }
    if (call.call.status === 'completed') {
      return res.status(409).json(withEnvelope(null, { code: 'CALL_ALREADY_COMPLETED', message: 'Completed calls cannot be updated.' }));
    }

    const saved = await upsertStageResult({
      callId: req.params.id,
      stage_number: stageNumber,
      stage_status: (stage_status as StageStatus | undefined) ?? 'in_progress',
      notes: typeof notes === 'string' ? notes : null,
      structured_result: (structured_result as Record<string, unknown> | undefined) ?? {},
      ...(validatedQuestions === undefined ? {} : { questions: validatedQuestions }),
      ...(callback_at === undefined ? {} : { callbackAt: callback_at as string | null }),
    });

    if (!saved) return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    return res.status(200).json(withEnvelope(saved, null));
  } catch (error) {
    if (error instanceof CallAlreadyCompletedError) {
      return res.status(409).json(withEnvelope(null, { code: 'CALL_ALREADY_COMPLETED', message: 'Completed calls cannot be updated.' }));
    }
    return respondWithInternalError(res, 'save_stage', error);
  }
});

app.post('/calls/:id/close', async (req, res) => {
  if (!isUuid(req.params.id)) return respondWithInvalidId(res);
  try {
    if (!hasOnlyKeys(req.body, ['final_outcome', 'final_notes', 'do_not_call_confirmed', 'callback_at'])) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Close request contains unsupported fields.' }));
    }
    const { final_outcome, final_notes, do_not_call_confirmed, callback_at } = req.body ?? {};
    const outcomes: CallOutcome[] = ['next_step_agreed', 'agreed_to_receive_report', 'interested', 'follow_up', 'call_again', 'not_interested', 'do_not_call', 'wrong_person', 'moved_company'];
    if (typeof final_outcome !== 'string' || !outcomes.includes(final_outcome as CallOutcome)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'A valid final outcome is required.' }));
    }
    if (final_notes != null && (typeof final_notes !== 'string' || final_notes.length > 2000)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Final notes must be text no longer than 2,000 characters.' }));
    }
    if (final_outcome === 'do_not_call' && do_not_call_confirmed !== true) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Confirm that the prospect requested no further calls.' }));
    }
    if (do_not_call_confirmed !== undefined && typeof do_not_call_confirmed !== 'boolean') {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Do-not-call confirmation must be boolean.' }));
    }
    if (do_not_call_confirmed === true && final_outcome !== 'do_not_call') {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Do-not-call confirmation is only valid with the do-not-call outcome.' }));
    }
    if (callback_at !== undefined && callback_at !== null && (typeof callback_at !== 'string' || !Number.isFinite(Date.parse(callback_at)))) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Callback time must be a valid date and time.' }));
    }

    const call = await closeCall(req.params.id, final_outcome, typeof final_notes === 'string' ? final_notes : null, callback_at as string | null | undefined, do_not_call_confirmed === true);
    if (!call) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }

    await saveDeterministicFallback(req.params.id);

    return res.status(200).json(withEnvelope(call, null));
  } catch (error) {
    if (error instanceof CallAlreadyCompletedError) {
      return res.status(409).json(withEnvelope(null, { code: 'CALL_ALREADY_COMPLETED', message: 'Call is already completed.' }));
    }
    return respondWithInternalError(res, 'close_call', error);
  }
});

app.post('/calls/:id/summary', async (req, res) => {
  if (!isUuid(req.params.id)) return respondWithInvalidId(res);
  try {
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    for (let attempt = 0; attempt < MAX_SUMMARY_SNAPSHOT_RETRIES; attempt += 1) {
      const snapshot = await getCallById(req.params.id);
      if (!snapshot) return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
      if (snapshot.call.status !== 'completed') return res.status(409).json(withEnvelope(null, { code: 'CALL_IN_PROGRESS', message: 'Summaries are available after the call is completed.' }));
      const initialContext = createSummaryContext(snapshot.call, snapshot.stageResults);
      const modelIdentity = isOpenRouterConfigured() ? process.env.OPENROUTER_MODEL!.trim() : 'deterministic-fallback';
      const cacheKey = `${req.params.id}:${initialContext.sourceHash}:${modelIdentity}`;
      let generation = summaryInFlight.get(cacheKey);
      if (!generation) {
        generation = withSummaryGenerationLock(cacheKey, async () => {
          const current = await getCallById(req.params.id);
          if (!current) return null;
          const context = createSummaryContext(current.call, current.stageResults);
          if (context.sourceHash !== initialContext.sourceHash) return null;

          const cached = await findSummaryBySourceHash(req.params.id, context.sourceHash);
          const hasOpenRouterConfig = isOpenRouterConfigured();
          const configuredModel = process.env.OPENROUTER_MODEL?.trim();
          if (cached && (cached.model_name !== 'local-deterministic-summary'
            && (cached.model_name === configuredModel || !hasOpenRouterConfig))) return cached;
          if (cached?.model_name === 'local-deterministic-summary' && !hasOpenRouterConfig) return cached;
          if (hasOpenRouterConfig) consumeSummaryRateLimit(clientKey);

          const generated = await summaryGenerator(current.call, current.stageResults);
          const afterGeneration = await getCallById(req.params.id);
          if (!afterGeneration) return null;
          const afterContext = createSummaryContext(afterGeneration.call, afterGeneration.stageResults);
          if (afterContext.sourceHash !== context.sourceHash) return null;
          const saved = await saveSummary(req.params.id, generated.summary, generated.modelName, {
            call_id: req.params.id,
            stage_count: current.stageResults.length,
            final_outcome: current.call.final_outcome,
            prompt_version: context.promptVersion,
            output_contract_version: context.outputContractVersion,
            source_hash: context.sourceHash,
          }, context.sourceHash);
          const afterSave = await getCallById(req.params.id);
          if (!afterSave || createSummaryContext(afterSave.call, afterSave.stageResults).sourceHash !== context.sourceHash) return null;
          return saved;
        });
        summaryInFlight.set(cacheKey, generation);
        void generation.then(() => {
          if (summaryInFlight.get(cacheKey) === generation) summaryInFlight.delete(cacheKey);
        }, () => {
          if (summaryInFlight.get(cacheKey) === generation) summaryInFlight.delete(cacheKey);
        });
      }
      const summary = await generation;
      if (summary) return res.status(200).json(withEnvelope(summary, null));
    }
    throw new SummarySourceChangedError();
  } catch (error) {
    if (error instanceof SummaryRateLimitError) return res.status(429).json(withEnvelope(null, { code: 'RATE_LIMITED', message: 'Summary generation limit reached. Try again in one minute.' }));
    if (error instanceof SummarySourceChangedError) return res.status(409).json(withEnvelope(null, { code: 'SOURCE_CHANGED', message: 'Call data changed during summary generation. Please retry.' }));
    return respondWithInternalError(res, 'generate_summary', error);
  }
});

app.use((_req, res) => {
  res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Route not found.' }));
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  respondWithExpressError(res, error);
});

async function start() {
  await initializeStore();
  const persistence = getPersistenceMode();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CallGuide API listening on port ${port} (${persistence} persistence)`);
  });

  const shutdown = () => {
    server.close(async (error) => {
      await closeStore();
      if (error) {
        console.error('Error while shutting down the HTTP server.');
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.env.NODE_ENV !== 'test') {
  start().catch(async (error: unknown) => {
    logSafeError('startup', error);
    console.error('CallGuide API failed to start. Check environment configuration and database connectivity.');
    await closeStore();
    process.exitCode = 1;
  });
}

export { app };
