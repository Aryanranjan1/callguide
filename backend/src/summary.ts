import { createHash } from 'node:crypto';
import type { Call, CallStageResult } from './types.js';
import { SUMMARY_OUTPUT_CONTRACT_VERSION, SUMMARY_PROMPT_VERSION, SUMMARY_SYSTEM_PROMPT, buildSummaryUserMessage } from './prompts.js';
import { getOpenRouterConfiguration, OpenRouterError, requestOpenRouterText, type OpenRouterTextRequest, type OpenRouterUsage } from './openrouter.js';

export const MAX_SUMMARY_LENGTH = 6000;
const SUMMARY_HEADINGS = [
  'Call overview', 'Business context', 'Stated needs', 'Objections and concerns',
  'Permission and engagement', 'Agreed next step', 'Missing information and inconsistencies',
];
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value === undefined ? null : value;
}

export function createSummaryContext(
  call: Call,
  stageResults: CallStageResult[],
  versions: { promptVersion?: string; outputContractVersion?: string } = {},
) {
  const promptVersion = versions.promptVersion ?? SUMMARY_PROMPT_VERSION;
  const outputContractVersion = versions.outputContractVersion ?? SUMMARY_OUTPUT_CONTRACT_VERSION;
  const projection = {
    call: {
      contact_name: call.contact_name ?? null,
      company_name: call.company_name ?? null,
      contact_role: call.contact_role ?? null,
      call_purpose: call.call_purpose ?? null,
      initial_context: call.initial_context ?? null,
      status: call.status ?? null,
      final_outcome: call.final_outcome ?? null,
      do_not_call_confirmed: call.do_not_call_confirmed ?? false,
      final_notes: call.final_notes ?? null,
      callback_at: call.callback_at ?? null,
      started_at: call.started_at ?? null,
      completed_at: call.completed_at ?? null,
    },
    stageResults: [...stageResults].sort((left, right) => left.stage_number - right.stage_number).map((stage) => ({
      stage_number: stage.stage_number,
      stage_status: stage.stage_status,
      structured_result: stage.structured_result ?? {},
      notes: stage.notes ?? null,
      questions: [...(stage.questions ?? [])].sort((left, right) => left.position - right.position).map((question) => ({
        question_text: question.question_text,
        source: question.source,
        asked: question.asked,
        response: question.response ?? null,
        position: question.position,
      })),
    })),
  };
  const canonicalProjection = canonicalize(projection);
  const contents = buildSummaryUserMessage(call, stageResults);
  const sourceHash = createHash('sha256').update(JSON.stringify(canonicalize({
    prompt_version: promptVersion,
    output_contract_version: outputContractVersion,
    input: canonicalProjection,
  }))).digest('hex');
  return { contents, sourceHash, promptVersion, outputContractVersion };
}

export type OpenRouterRequester = (request: OpenRouterTextRequest) => Promise<string | null | undefined>;

type ProviderFailureCategory =
  | 'missing_api_key'
  | 'missing_model'
  | 'unsupported_provider'
  | 'invalid_json_response'
  | 'invalid_response'
  | 'missing_choices'
  | 'missing_content'
  | 'empty_content'
  | 'payment_required'
  | 'forbidden'
  | 'authentication_failure'
  | 'model_not_found'
  | 'rate_limited'
  | 'invalid_request'
  | 'timeout'
  | 'network_error'
  | 'provider_server_error'
  | 'provider_error';

type SummaryLogEvent = {
  event: 'ai_summary_generated' | 'ai_summary_fallback';
  provider: 'openrouter';
  task: 'summary';
  reason?: 'empty_response' | 'invalid_response' | ProviderFailureCategory;
  model: string;
  duration_ms: number;
  provider_status?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type SummaryLogger = (event: SummaryLogEvent) => void;

function logSummaryEvent(event: SummaryLogEvent, logger?: SummaryLogger) {
  const write = logger ?? ((entry) => {
    const serialized = JSON.stringify(entry);
    if (entry.event === 'ai_summary_generated') console.info(serialized);
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

function classifyProviderFailure(error: unknown): ProviderFailureCategory {
  if (error instanceof OpenRouterError) return error.category as ProviderFailureCategory;

  const status = getProviderStatus(error);
  const details = getSafeErrorText(error);
  if (status === 429 || /resource_exhausted|rate.?limit|quota/.test(details)) return 'rate_limited';
  if (/api[_ -]?key[_ -]?(invalid|not found)|api key not valid|invalid api key|unauthenticated|permission denied/.test(details)) return 'authentication_failure';
  if (status === 401 || status === 403) return 'authentication_failure';
  if (status === 404 || /model[_ -]?not[_ -]?found|not found.*model/.test(details)) return 'model_not_found';
  if (status === 400 || /invalid_argument|bad request/.test(details)) return 'invalid_request';
  if (/time.?out|deadline_exceeded|aborterror|aborted|etimedout|und_err_abort/.test(details)) return 'timeout';
  if (/fetch failed|econnreset|econnrefused|enotfound|eai_again|networkerror/.test(details)) return 'network_error';
  return 'provider_error';
}

function usageLogFields(usage?: OpenRouterUsage) {
  return {
    ...(usage?.prompt_tokens === undefined ? {} : { input_tokens: usage.prompt_tokens }),
    ...(usage?.completion_tokens === undefined ? {} : { output_tokens: usage.completion_tokens }),
    ...(usage?.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
  };
}

function buildLocalSummary(call: Call, stageResults: CallStageResult[]) {
  const stages = [...stageResults].sort((a, b) => a.stage_number - b.stage_number);
  const stageThree = stages.find((stage) => stage.stage_number === 3);
  const needs = stages.flatMap((stage) => {
    const need = stage.structured_result.need;
    return typeof need === 'string' && need.trim() ? [`Recorded need/goal: ${need.trim()}`] : [];
  });
  const objections = stages.flatMap((stage) => {
    const objection = stage.structured_result.objection;
    return typeof objection === 'string' && objection.trim() ? [objection.trim()] : [];
  });
  const steps = stages.flatMap((stage) => {
    const step = stage.structured_result.next_step;
    return typeof step === 'string' && step.trim() ? [step.trim()] : [];
  });
  const notes = stages.flatMap((stage) => stage.notes?.trim() ? [`Stage ${stage.stage_number}: ${stage.notes.trim()}`] : []);
  const responses = stages.flatMap((stage) => (stage.questions ?? [])
    .filter((question) => question.asked && question.response?.trim())
    .map((question) => `Stage ${stage.stage_number} — Q: ${question.question_text}\nRecorded response: ${question.response}`));
  const legacyResponses = stages.flatMap((stage) => {
    const questions = stage.structured_result.asked_questions;
    const answers = stage.structured_result.question_responses;
    if (!answers || typeof answers !== 'object') return [];
    const responseEntries = Object.entries(answers as Record<string, unknown>);
    const requestedQuestions = Array.isArray(questions) ? questions.filter((question): question is string => typeof question === 'string') : [];
    const questionTexts = requestedQuestions.length ? requestedQuestions : responseEntries.map(([question]) => question);
    return questionTexts.flatMap((question) => {
      const response = (answers as Record<string, unknown>)[question];
      return typeof response === 'string' && response.trim() ? [`Stage ${stage.stage_number} — Q: ${question}\nRecorded response: ${response.trim()}`] : [];
    });
  });
  const nextStepFields = stages.flatMap((stage) => {
    const fields = [stage.structured_result.next_step_owner, stage.structured_result.next_step_channel]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return fields;
  });
  const nextStep = [...steps, ...nextStepFields, ...(call.callback_at ? [`Callback time recorded: ${call.callback_at}`] : [])].join('\n');
  const summary = [
    'Call overview',
    `Prospect: ${call.contact_name ?? 'Not recorded'}; role: ${call.contact_role ?? 'Not recorded'}; company: ${call.company_name ?? 'Not recorded'}.`,
    `Purpose: ${call.call_purpose ?? 'Not recorded'}. Recorded outcome: ${call.final_outcome ?? 'Not recorded'}.`,
    'Business context',
    [...notes, ...responses, ...legacyResponses].join('\n\n') || 'Not established.',
    'Stated needs',
    needs.join('\n') || 'Not established.',
    'Objections and concerns',
    objections.join('\n') || 'Not established.',
    'Permission and engagement',
    stageThree?.structured_result.interaction
      ? `System-recorded permission-stage result: ${String(stageThree.structured_result.interaction)}.`
      : 'Not recorded.',
    'Agreed next step',
    nextStep || 'No next step was recorded.',
    'Missing information and inconsistencies',
    [
      call.final_outcome ? `Recorded outcome preserved as: ${call.final_outcome}.` : 'Final outcome: Not recorded.',
    call.final_notes?.trim() ? `Closing notes: ${call.final_notes.trim()}` : 'No unrecorded information is inferred; original notes remain the source of truth.',
    ].join('\n'),
  ].join('\n\n');
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : `${summary.slice(0, MAX_SUMMARY_LENGTH - 24).trimEnd()}\n\n[Summary truncated.]`;
}

function isValidSummaryOutput(value: string) {
  if (!value || value.length > MAX_SUMMARY_LENGTH || /```/.test(value)) return false;
  try {
    JSON.parse(value);
    return false;
  } catch {
    // Plain text is expected; JSON syntax is rejected above.
  }
  const headings = value.split(/\r?\n/).map((line) => line.trim().replace(/:$/, '').toLowerCase());
  return SUMMARY_HEADINGS.every((heading) => headings.includes(heading.toLowerCase()));
}

export async function generateCallSummary(
  call: Call,
  stageResults: CallStageResult[],
  options: { apiKey?: string; model?: string; request?: OpenRouterRequester; fetch?: typeof fetch; logger?: SummaryLogger } = {},
) {
  const startedAt = Date.now();
  let model = options.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'unconfigured';
  try {
    const configuration = getOpenRouterConfiguration(process.env, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    model = configuration.model;
      const { contents } = createSummaryContext(call, stageResults);
      const request = {
        ...configuration,
        systemInstruction: SUMMARY_SYSTEM_PROMPT,
        contents,
      };
      const response = options.request
        ? { text: await options.request(request), usage: undefined }
        : await requestOpenRouterText(request, options.fetch);
      const responseText = response.text;
      const summary = typeof responseText === 'string' ? responseText.trim() : '';
      if (isValidSummaryOutput(summary)) {
        logSummaryEvent({
          event: 'ai_summary_generated', provider: 'openrouter', task: 'summary', model, duration_ms: Date.now() - startedAt,
          ...usageLogFields(response.usage),
        }, options.logger);
        return { summary, modelName: model };
      }
      logSummaryEvent({ event: 'ai_summary_fallback', provider: 'openrouter', task: 'summary', reason: summary ? 'invalid_response' : 'empty_response', model, duration_ms: Date.now() - startedAt }, options.logger);
  } catch (error) {
    const providerStatus = getProviderStatus(error);
    logSummaryEvent({
      event: 'ai_summary_fallback', provider: 'openrouter', task: 'summary',
      reason: classifyProviderFailure(error), model, duration_ms: Date.now() - startedAt,
      ...(providerStatus === undefined ? {} : { provider_status: providerStatus }),
    }, options.logger);
  }

    return { summary: buildLocalSummary(call, stageResults), modelName: 'local-deterministic-summary' };
}
