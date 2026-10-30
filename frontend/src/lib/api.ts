import type { ApiEnvelope, Call, CallDetail } from './types';

const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
if (!configuredApiBaseUrl && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_API_BASE_URL must be set when building the frontend for production.');
}

export const API_BASE_URL = configuredApiBaseUrl || 'http://localhost:4000';

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
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

  return payload.data as T;
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

export async function listCalls() {
  return apiRequest<Call[]>('/calls');
}

export async function saveStage(callId: string, stageNumber: number, notes: string, structuredResult: Record<string, any>) {
  return apiRequest<{ id: string; call_id: string }>(`/calls/${callId}/stages`, {
    method: 'POST',
    body: JSON.stringify({
      stage_number: stageNumber,
      stage_status: notes.trim() ? 'completed' : 'in_progress',
      notes,
      structured_result: structuredResult,
    }),
  });
}

export async function closeCall(callId: string, finalOutcome: string, finalNotes?: string) {
  return apiRequest<Call>(`/calls/${callId}/close`, {
    method: 'POST',
    body: JSON.stringify({ final_outcome: finalOutcome, final_notes: finalNotes ?? null }),
  });
}

export async function generateSummary(callId: string) {
  return apiRequest<{ id: string; call_id: string; summary_text: string }>(`/calls/${callId}/summary`, {
    method: 'POST',
  });
}
