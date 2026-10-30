export type CallStatus = 'in_progress' | 'completed';

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

export interface Call {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  contact_role: string | null;
  call_purpose: string | null;
  initial_context: string | null;
  status: CallStatus;
  final_outcome: CallOutcome | LegacyCallOutcome | null;
  final_notes: string | null;
  callback_at?: string | null;
  do_not_call_confirmed?: boolean;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  stage_count?: number;
  reached_stages?: number[];
  summary_preview?: string;
}

export interface CallStageResult {
  id: string;
  call_id: string;
  stage_number: number;
  stage_status: 'not_started' | 'in_progress' | 'completed';
  structured_result: Record<string, unknown>;
  notes: string | null;
  updated_at: string;
  created_at: string;
  questions?: StageQuestion[];
}

export interface StageQuestion {
  id: string;
  question_text: string;
  source: 'suggested' | 'custom';
  asked: boolean;
  response: string | null;
  position: number;
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

export interface CallDetail extends Call {
  stageResults: CallStageResult[];
  summary: CallSummary | null;
}

export interface CallListFilters {
  query: string;
  status: 'all' | 'in_progress' | 'completed';
  outcome: string;
  dateFrom: string;
  dateTo: string;
  sort: 'newest' | 'oldest';
}

export interface CallListPage {
  calls: Call[];
  nextCursor: string | null;
  totalCount: number;
  pageCount: number;
  hasMore: boolean;
}

export interface QuestionRecommendation {
  question: string;
  reason: string;
  intent: string;
  priority: 'high' | 'medium' | 'low';
}

export interface QuestionGenerationResult {
  status: 'ok' | 'insufficient_context' | 'no_recommendation';
  source: 'openrouter' | 'fallback';
  questions: QuestionRecommendation[];
}

export interface SystemHealth {
  status: 'ok';
  persistence: 'postgres' | 'local-json';
  database: 'connected' | 'unavailable' | 'local';
  openrouter: 'configured' | 'not_configured';
}

export interface CallAnalytics {
  total: number;
  completed: number;
  in_progress: number;
  follow_ups: number;
  buckets: Array<{ label: string; start: string; count: number }>;
  outcomes: Array<{ outcome: string; count: number }>;
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
