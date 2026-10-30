CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY,
  contact_name TEXT,
  company_name TEXT,
  contact_role TEXT,
  call_purpose TEXT,
  initial_context TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  final_outcome TEXT CHECK (final_outcome IN (
    'follow_up_agreed',
    'meeting_agreed',
    'information_requested',
    'not_interested',
    'wrong_person',
    'no_contact_made',
    'no_clear_outcome',
    'other'
  )),
  final_notes TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_stage_results (
  id UUID PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  stage_number INTEGER NOT NULL CHECK (stage_number BETWEEN 1 AND 8),
  stage_status TEXT NOT NULL CHECK (stage_status IN ('not_started', 'in_progress', 'completed')) DEFAULT 'not_started',
  structured_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (call_id, stage_number)
);

CREATE TABLE IF NOT EXISTS call_summaries (
  id UUID PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  model_name TEXT,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_results_call_stage ON call_stage_results(call_id, stage_number);
CREATE INDEX IF NOT EXISTS idx_summaries_call_id ON call_summaries(call_id);
