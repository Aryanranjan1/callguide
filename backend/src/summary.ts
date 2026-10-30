import { GoogleGenAI } from '@google/genai';
import type { Call, CallStageResult } from './types.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_REQUEST_TIMEOUT_MS = 15_000;

const systemInstruction = 'You are a careful call-note summarizer. Never invent facts. Preserve uncertainty and distinguish caller notes from AI-generated text.';

type GeminiRequest = {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: string;
  timeoutMs: number;
};

export type GeminiRequester = (request: GeminiRequest) => Promise<string | null | undefined>;

type GeminiFailureCategory =
  | 'sdk_initialization_failure'
  | 'authentication_failure'
  | 'model_not_found'
  | 'quota_or_rate_limit'
  | 'invalid_request'
  | 'timeout'
  | 'network_error'
  | 'provider_error';

type SummaryLogEvent = {
  event: 'gemini_summary_generated' | 'gemini_summary_fallback';
  reason?: 'missing_api_key' | 'empty_response' | GeminiFailureCategory;
  model: string;
  duration_ms: number;
  provider_status?: number;
};

type SummaryLogger = (event: SummaryLogEvent) => void;

class GeminiSdkInitializationError extends Error {
  constructor() {
    super('Gemini SDK initialization failed.');
    this.name = 'GeminiSdkInitializationError';
  }
}

function logSummaryEvent(event: SummaryLogEvent, logger?: SummaryLogger) {
  const write = logger ?? ((entry) => {
    const serialized = JSON.stringify(entry);
    if (entry.event === 'gemini_summary_generated') console.info(serialized);
    else console.warn(serialized);
  });
  try {
    write(event);
  } catch {
    // Diagnostics must never change summary generation behavior.
  }
}

function getProviderStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function getSafeErrorText(error: unknown) {
  if (!(error instanceof Error)) return '';
  const cause = error.cause && typeof error.cause === 'object'
    ? (error.cause as { code?: unknown; name?: unknown })
    : undefined;
  // These strings are used only to classify the failure; they are never logged.
  return [error.name, error.message, cause?.code, cause?.name]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .join(' ')
    .toLowerCase();
}

function classifyProviderFailure(error: unknown): GeminiFailureCategory {
  if (error instanceof GeminiSdkInitializationError) return 'sdk_initialization_failure';

  const status = getProviderStatus(error);
  const details = getSafeErrorText(error);
  if (status === 429 || /resource_exhausted|rate.?limit|quota/.test(details)) return 'quota_or_rate_limit';
  if (/api[_ -]?key[_ -]?(invalid|not found)|api key not valid|invalid api key|unauthenticated|permission denied/.test(details)) return 'authentication_failure';
  if (status === 401 || status === 403) return 'authentication_failure';
  if (status === 404 || /model[_ -]?not[_ -]?found|not found.*model/.test(details)) return 'model_not_found';
  if (status === 400 || /invalid_argument|bad request/.test(details)) return 'invalid_request';
  if (/time.?out|deadline_exceeded|aborterror|aborted|etimedout|und_err_abort/.test(details)) return 'timeout';
  if (/fetch failed|econnreset|econnrefused|enotfound|eai_again|networkerror/.test(details)) return 'network_error';
  return 'provider_error';
}

function buildLocalSummary(call: Call, stageResults: CallStageResult[]) {
  const stages = [...stageResults]
    .sort((a, b) => a.stage_number - b.stage_number)
    .map((stage) => ({ number: stage.stage_number, notes: stage.notes ?? 'No notes recorded.', structured: stage.structured_result }));

  const recordedNeeds = stages
    .map((stage) => stage.structured?.need ?? stage.structured?.goal ?? stage.structured?.challenge)
    .filter(Boolean)
    .join('; ');
  const objections = stages.map((stage) => stage.structured?.objection).filter(Boolean).join('; ');
  const nextStep = stages.map((stage) => stage.structured?.next_step).filter(Boolean).join('; ');

  return [
    'Call overview:',
    `Prospect: ${call.contact_name ?? 'Not recorded'} | Company: ${call.company_name ?? 'Not recorded'} | Purpose: ${call.call_purpose ?? 'Not recorded'}`,
    'Business context:',
    stages.map((stage) => `Stage ${stage.number}: ${stage.notes}`).join('\n') || 'No stage notes recorded.',
    'Stated needs:',
    recordedNeeds || 'Not recorded.',
    'Objections or concerns:',
    objections || 'Not recorded.',
    'Agreed next step:',
    nextStep || 'Not recorded.',
    'Missing information:',
    'Any unrecorded contact or outcome details remain unknown. The original notes are the source of truth.',
  ].join('\n\n');
}

async function requestGeminiSummary(request: GeminiRequest, fetcher?: typeof fetch) {
  const httpOptions = { timeout: request.timeoutMs, ...(fetcher ? { fetch: fetcher } : {}) };
  let ai: GoogleGenAI;
  try {
    ai = new GoogleGenAI({ apiKey: request.apiKey, httpOptions });
  } catch {
    throw new GeminiSdkInitializationError();
  }
  const response = await ai.models.generateContent({
    model: request.model,
    contents: request.contents,
    config: {
      systemInstruction: request.systemInstruction,
      automaticContinuation: false,
      abortSignal: AbortSignal.timeout(request.timeoutMs),
      httpOptions,
    },
  });
  return response.text;
}

export async function generateCallSummary(
  call: Call,
  stageResults: CallStageResult[],
  options: { apiKey?: string; model?: string; request?: GeminiRequester; fetch?: typeof fetch; logger?: SummaryLogger } = {},
) {
  const apiKey = options.apiKey?.trim() ?? process.env.GEMINI_API_KEY?.trim() ?? '';
  const model = options.model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const startedAt = Date.now();

  if (!apiKey) {
    logSummaryEvent({ event: 'gemini_summary_fallback', reason: 'missing_api_key', model, duration_ms: Date.now() - startedAt }, options.logger);
  } else {
    try {
      const contents = JSON.stringify({
        call,
        stageResults,
        instructions: [
          'Summarize the recorded call facts.',
          'Do not fabricate names, dates, or commitments.',
          'Call out missing information when it is unknown.',
          'Preserve direct quotes and uncertainty.',
        ],
      });
      const request = {
        apiKey,
        model,
        systemInstruction,
        contents,
        timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
      };
      const responseText = options.request
        ? await options.request(request)
        : await requestGeminiSummary(request, options.fetch);
      const summary = typeof responseText === 'string' ? responseText.trim() : '';
      if (summary) {
        logSummaryEvent({ event: 'gemini_summary_generated', model, duration_ms: Date.now() - startedAt }, options.logger);
        return { summary, modelName: model };
      }
      logSummaryEvent({ event: 'gemini_summary_fallback', reason: 'empty_response', model, duration_ms: Date.now() - startedAt }, options.logger);
    } catch (error) {
      const providerStatus = getProviderStatus(error);
      logSummaryEvent({
        event: 'gemini_summary_fallback',
        reason: classifyProviderFailure(error),
        model,
        duration_ms: Date.now() - startedAt,
        ...(providerStatus === undefined ? {} : { provider_status: providerStatus }),
      }, options.logger);
    }
  }

  return { summary: buildLocalSummary(call, stageResults), modelName: 'local-deterministic-summary' };
}
