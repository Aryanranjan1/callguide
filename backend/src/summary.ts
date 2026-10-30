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
  const ai = new GoogleGenAI({ apiKey: request.apiKey, httpOptions });
  const response = await ai.models.generateContent({
    model: request.model,
    contents: request.contents,
    config: {
      systemInstruction: request.systemInstruction,
      temperature: 0.2,
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
  options: { apiKey?: string; model?: string; request?: GeminiRequester; fetch?: typeof fetch } = {},
) {
  const apiKey = options.apiKey?.trim() ?? process.env.GEMINI_API_KEY?.trim() ?? '';
  const model = options.model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  if (apiKey) {
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
      if (summary) return { summary, modelName: model };
    } catch {
      // Provider errors and timeouts use the same deterministic local fallback.
    }
  }

  return { summary: buildLocalSummary(call, stageResults), modelName: 'local-deterministic-summary' };
}
