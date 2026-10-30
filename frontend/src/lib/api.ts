import type { ApiEnvelope, Call, CallAnalytics, CallDetail, CallListFilters, CallListPage, CallStageResult, CallOutcome, CallSummary, QuestionGenerationResult, StageQuestion, SystemHealth } from './types';

const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
if (!configuredApiBaseUrl && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_API_BASE_URL must be set when building the frontend for production.');
}

export const API_BASE_URL = configuredApiBaseUrl || 'http://localhost:4000';

async function apiRequestWithHeaders<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? 'Request failed.');
  }

  return { data: payload.data as T, headers: response.headers };
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await apiRequestWithHeaders<T>(path, options)).data;
}

export async function createCall(input: Record<string, string>) {
  return apiRequest<Call>('/calls', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loadCall(id: string) {
  return apiRequest<CallDetail>(`/calls/${id}`);
}

export async function loadSystemHealth(signal?: AbortSignal) {
  return apiRequest<SystemHealth>('/health', { signal });
}

export async function listCallsPage(filters: CallListFilters, cursor?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '10', sort: filters.sort });
  if (filters.query.trim()) params.set('q', filters.query.trim());
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.outcome !== 'all') params.set('outcome', filters.outcome);
  if (filters.dateFrom) params.set('started_after', new Date(`${filters.dateFrom}T00:00:00`).toISOString());
  if (filters.dateTo) { const end = new Date(`${filters.dateTo}T00:00:00`); end.setDate(end.getDate() + 1); params.set('started_before', end.toISOString()); }
  if (cursor) params.set('cursor', cursor);
  const response = await apiRequestWithHeaders<Call[]>(`/calls?${params.toString()}`, { signal });
  return {
    calls: response.data,
    nextCursor: response.headers.get('x-next-cursor'),
    totalCount: Number(response.headers.get('x-total-count') ?? response.data.length),
    pageCount: Number(response.headers.get('x-page-count') ?? response.data.length),
    hasMore: response.headers.get('x-has-more') === 'true',
  } satisfies CallListPage;
}

export async function generateQuestions(callId: string, stageNumber: number, forceRefresh = false, signal?: AbortSignal) {
  return apiRequest<QuestionGenerationResult>(`/calls/${callId}/questions`, {
    method: 'POST',
    body: JSON.stringify({ stage_number: stageNumber, force_refresh: forceRefresh }),
    signal,
  });
}

export async function listUpcomingCallbacks(signal?: AbortSignal) {
  return apiRequest<Call[]>('/calls/callbacks', { signal });
}

export async function loadCallAnalytics(period: 'daily' | 'weekly', timeZone: string, dateFrom?: string, dateTo?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ period, timezone: timeZone });
  if (dateFrom) params.set('from', dateFrom);
  if (dateTo) params.set('to', dateTo);
  return apiRequest<CallAnalytics>(`/calls/analytics?${params.toString()}`, { signal });
}

export async function saveStage(callId: string, stageNumber: number, notes: string, structuredResult: Record<string, unknown>, stageStatus: 'in_progress' | 'completed' = notes.trim() ? 'completed' : 'in_progress', questions?: StageQuestion[], callbackAt?: string | null) {
  return apiRequest<CallStageResult>(`/calls/${callId}/stages`, {
    method: 'POST',
    body: JSON.stringify({
      stage_number: stageNumber,
      stage_status: stageStatus,
      notes,
      structured_result: structuredResult,
      ...(questions === undefined ? {} : { questions }),
      ...(callbackAt === undefined ? {} : { callback_at: callbackAt }),
    }),
  });
}

export async function closeCall(callId: string, finalOutcome: CallOutcome, finalNotes?: string, doNotCallConfirmed?: boolean, callbackAt?: string | null) {
  return apiRequest<Call>(`/calls/${callId}/close`, {
    method: 'POST',
    body: JSON.stringify({ final_outcome: finalOutcome, final_notes: finalNotes ?? null, ...(doNotCallConfirmed ? { do_not_call_confirmed: true } : {}), ...(callbackAt === undefined ? {} : { callback_at: callbackAt }) }),
  });
}

export async function generateSummary(callId: string) {
  return apiRequest<CallSummary>(`/calls/${callId}/summary`, {
    method: 'POST',
  });
}
