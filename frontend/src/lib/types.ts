export type CallStatus = 'in_progress' | 'completed';

export type CallOutcome =
  | 'follow_up_agreed'
  | 'meeting_agreed'
  | 'information_requested'
  | 'not_interested'
  | 'wrong_person'
  | 'no_contact_made'
  | 'no_clear_outcome'
  | 'other';

export interface Call {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_role: string | null;
  call_purpose: string | null;
  initial_context: string | null;
  status: CallStatus;
  final_outcome: CallOutcome | null;
  final_notes: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallStageResult {
  id: string;
  call_id: string;
  stage_number: number;
  stage_status: 'not_started' | 'in_progress' | 'completed';
  structured_result: Record<string, any>;
  notes: string | null;
  updated_at: string;
  created_at: string;
}

export interface CallSummary {
  id: string;
  call_id: string;
  summary_text: string;
  model_name: string | null;
  source_snapshot: Record<string, any>;
  created_at: string;
}

export interface CallDetail extends Call {
  stageResults: CallStageResult[];
  summary: CallSummary | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiEnvelope<T> {
  data: T | null;
  error: ApiError | null;
}

export interface StageDefinition {
  number: number;
  title: string;
  objective: string;
  guidance: string;
  questions: string[];
}
