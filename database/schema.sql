CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY,
  contact_name TEXT,
  company_name TEXT,
  contact_role TEXT,
  call_purpose TEXT,
  initial_context TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  final_outcome TEXT CHECK (final_outcome IN (
    'next_step_agreed',
    'agreed_to_receive_report',
    'interested',
    'follow_up',
    'call_again',
    'not_interested',
    'do_not_call',
    'wrong_person',
    'moved_company'
  )),
  do_not_call_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  final_notes TEXT,
  callback_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (final_outcome <> 'do_not_call' OR do_not_call_confirmed = TRUE)
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
  source_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_stage_questions (
  id UUID PRIMARY KEY,
  stage_result_id UUID NOT NULL REFERENCES call_stage_results(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL CHECK (char_length(question_text) BETWEEN 1 AND 240),
  source TEXT NOT NULL CHECK (source IN ('suggested', 'custom')),
  asked BOOLEAN NOT NULL DEFAULT FALSE,
  response TEXT CHECK (response IS NULL OR char_length(response) <= 1000),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stage_result_id, position)
);

CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_created_id ON calls(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stage_results_call_stage ON call_stage_results(call_id, stage_number);
CREATE INDEX IF NOT EXISTS idx_summaries_call_id ON call_summaries(call_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_call_source_hash ON call_summaries(call_id, source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_callback_at ON calls(callback_at) WHERE callback_at IS NOT NULL AND status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_calls_callback_all ON calls(callback_at ASC, id ASC) WHERE callback_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stage_questions_stage_order ON call_stage_questions(stage_result_id, position);
