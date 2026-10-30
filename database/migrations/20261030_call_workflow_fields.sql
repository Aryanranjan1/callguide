-- Additive CallGuide workflow fields. Existing call and stage rows remain intact.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS callback_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS do_not_call_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve existing outcome values for historical records while permitting the
-- assignment outcomes for new writes. The API only accepts the new set.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_final_outcome_check;
ALTER TABLE calls ADD CONSTRAINT calls_final_outcome_check CHECK (final_outcome IS NULL OR final_outcome IN (
  'next_step_agreed', 'agreed_to_receive_report', 'interested', 'follow_up', 'call_again',
  'not_interested', 'do_not_call', 'wrong_person', 'moved_company',
  'follow_up_agreed', 'meeting_agreed', 'information_requested', 'no_contact_made', 'no_clear_outcome', 'other'
));
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_do_not_call_confirmed_check;
ALTER TABLE calls ADD CONSTRAINT calls_do_not_call_confirmed_check CHECK (final_outcome <> 'do_not_call' OR do_not_call_confirmed = TRUE);

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

CREATE INDEX IF NOT EXISTS idx_calls_callback_at ON calls(callback_at) WHERE callback_at IS NOT NULL AND status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_stage_questions_stage_order ON call_stage_questions(stage_result_id, position);
