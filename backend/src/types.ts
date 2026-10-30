export type CallStatus = 'in_progress' | 'completed';

export type StageStatus = 'not_started' | 'in_progress' | 'completed';

export type CallOutcome =
  | 'next_step_agreed'
  | 'agreed_to_receive_report'
  | 'interested'
  | 'follow_up'
  | 'call_again'
  | 'not_interested'
  | 'do_not_call'
  | 'wrong_person'
  | 'moved_company';

export type LegacyCallOutcome = 'follow_up_agreed' | 'meeting_agreed' | 'information_requested' | 'no_contact_made' | 'no_clear_outcome' | 'other';

export interface StageQuestion {
  id: string;
  question_text: string;
  source: 'suggested' | 'custom';
  asked: boolean;
  response: string | null;
  position: number;
}

export interface Call {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_role: string | null;
  call_purpose: string | null;
  initial_context: string | null;
  status: CallStatus;
  final_outcome: CallOutcome | LegacyCallOutcome | null;
  do_not_call_confirmed: boolean;
  final_notes: string | null;
  callback_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  summary_preview?: string;
  stage_count?: number;
}

export interface CallStageResult {
  id: string;
  call_id: string;
  stage_number: number;
  stage_status: StageStatus;
  structured_result: Record<string, unknown>;
  notes: string | null;
  updated_at: string;
  created_at: string;
  questions?: StageQuestion[];
}

export interface CallSummary {
  id: string;
  call_id: string;
  summary_text: string;
  model_name: string | null;
  source_snapshot: Record<string, unknown>;
  source_hash?: string | null;
  created_at: string;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiEnvelope<T> {
  data: T | null;
  error: ApiError | null;
}
