'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { generateSummary, loadCall } from '@/lib/api';
import { STAGES } from '@/lib/stages';
import type { CallDetail, StageQuestion } from '@/lib/types';

const outcomeLabels: Record<string, string> = {
  next_step_agreed: 'Next step agreed', agreed_to_receive_report: 'Agreed to receive report', interested: 'Interested', follow_up: 'Follow-up', call_again: 'Call again',
  not_interested: 'Not interested', do_not_call: 'Do not call', wrong_person: 'Wrong person', moved_company: 'Moved company',
  follow_up_agreed: 'Follow-up agreed (legacy)', meeting_agreed: 'Meeting agreed (legacy)', information_requested: 'Information requested (legacy)', no_contact_made: 'No contact made (legacy)', no_clear_outcome: 'No clear outcome (legacy)', other: 'Other (legacy)',
};
const interactionLabels: Record<string, string> = {
  right_person: 'Right person', reception: 'Reception', cant_talk_now: "Can't talk now", wrong_number: 'Not them / wrong number',
  understood: 'Understood', asked_what_we_do: 'Asked what we do', asked_why_free: 'Asked why free', asked_source_of_number: 'Asked source of number',
  clear_yes: 'Clear yes', call_later: 'Call later', clear_no: 'Clear no', continued_without_yes: 'Continued without explicit yes',
  described_work: 'Described work', corrected_us: 'Corrected us', asked_about_us: 'Asked about us', not_their_area: 'Not their area',
  stated_goal: 'Stated goal', no_need: 'No need', only_yes_no: 'Only yes / no', asked_what_we_can_do: 'Asked what we can do',
  not_right_person: 'Not right person', has_provider: 'Has provider', send_details_first: 'Send details first', no_reason: 'No reason',
  time_agreed: 'Time agreed', agreed_to_receive: 'Agreed to receive information', referred: 'Referred', nothing_agreed: 'Nothing agreed',
};

function hasRecordedStage(result: CallDetail['stageResults'][number] | undefined) {
  if (!result) return false;
  if (result.notes?.trim()) return true;
  const data = result.structured_result;
  if (Object.values(data).some((value) => typeof value === 'string' && value.trim())) return true;
  if (result.questions?.length) return true;
  if (result.questions?.some((question) => question.asked || question.response?.trim())) return true;
  if (Array.isArray(data.asked_questions) && data.asked_questions.length > 0) return true;
  const responses = data.question_responses;
  return Boolean(responses && typeof responses === 'object' && Object.values(responses).some((value) => typeof value === 'string' && value.trim()));
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const [index, match] of [...text.matchAll(tokenPattern)].entries()) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    if (token.startsWith('**')) nodes.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={`code-${index}`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) nodes.push(token.slice(1, token.indexOf(']')));
    else nodes.push(<em key={`em-${index}`}>{token.slice(1, -1)}</em>);
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function SafeMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`ul-${blocks.length}`}>{list.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); blocks.push(<h3 key={`h-${blocks.length}`}>{renderInlineMarkdown(heading[2])}</h3>); }
    else if (listItem) { flushParagraph(); list.push(listItem[1]); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return <div className="cg-safe-markdown">{blocks}</div>;
}

export default function ReviewPage() {
  return <Suspense fallback={<main className="p-8 text-slate-700">Loading review…</main>}><ReviewPageContent /></Suspense>;
}

function ReviewPageContent() {
  const params = useParams<{ id: string }>();
  const callId = params.id;
  const [call, setCall] = useState<CallDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadCall(callId).then((result) => { if (active) setCall(result); })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load call.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [callId]);

  async function generateCallSummary() {
    if (!call || call.status !== 'completed') return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const summary = await generateSummary(call.id);
      setCall((current) => current ? { ...current, summary: { ...summary, created_at: summary.created_at ?? new Date().toISOString() } } : current);
    } catch (summaryError) {
      setSummaryError(summaryError instanceof Error ? summaryError.message : 'Unable to generate summary.');
    } finally { setSummaryLoading(false); }
  }

  if (loading) return <main role="status" className="p-8 text-slate-700">Loading call review…</main>;
  if (error && !call) return <main role="alert" className="p-8 text-red-700">{error}<div><button className="cg-quiet-button mt-4" type="button" onClick={() => { setError(null); setLoading(true); void loadCall(callId).then(setCall).catch((retryError: unknown) => setError(retryError instanceof Error ? retryError.message : 'Unable to load call.')).finally(() => setLoading(false)); }}>Try again</button></div></main>;
  if (!call) return <main className="p-8 text-slate-700">Call not found.</main>;

  const missingStages = STAGES.filter((stage) => !hasRecordedStage(call.stageResults.find((result) => result.stage_number === stage.number)));
  const completedStages = STAGES.filter((stage) => call.stageResults.find((result) => result.stage_number === stage.number)?.stage_status === 'completed').length;
  const durationSeconds = call.completed_at
    ? Math.max(0, Math.floor((Date.parse(call.completed_at) - Date.parse(call.started_at)) / 1000))
    : null;
  const stageThree = call.stageResults.find((stage) => stage.stage_number === 3)?.structured_result;
  const opening = call.stageResults.find((stage) => stage.stage_number === 1)?.structured_result;
  const needStage = call.stageResults.find((stage) => stage.stage_number === 5);
  const nextStage = call.stageResults.find((stage) => stage.stage_number === 7)?.structured_result;
  const nextStepRecorded = call.stageResults.some((stage) => typeof stage.structured_result.next_step === 'string' && stage.structured_result.next_step.trim());
  const positiveOutcomes = new Set(['next_step_agreed', 'agreed_to_receive_report', 'interested', 'follow_up', 'call_again']);
  const warnings: { title: string; evidence: string }[] = [];
  if (call.final_outcome && positiveOutcomes.has(call.final_outcome) && !nextStepRecorded && !call.callback_at) warnings.push({ title: 'Positive outcome has no recorded next step', evidence: `Outcome: ${outcomeLabels[call.final_outcome] ?? call.final_outcome}. No agreed action or callback time is saved.` });
  if (call.final_outcome && positiveOutcomes.has(call.final_outcome) && stageThree?.interaction === 'clear_no') warnings.push({ title: 'Positive outcome conflicts with an explicit refusal', evidence: 'Permission stage is recorded as “Clear no”. Check that the final outcome reflects the conversation.' });
  if (call.final_outcome === 'wrong_person' && opening?.interaction === 'right_person') warnings.push({ title: 'Wrong-person outcome conflicts with the opening', evidence: 'Opening stage is recorded as “Right person”. Review the two entries.' });
  if ((call.final_outcome === 'follow_up' || call.final_outcome === 'call_again') && !call.callback_at) warnings.push({ title: 'Follow-up has no scheduled time', evidence: 'The outcome requests another call, but no callback date or time is saved.' });
  if (nextStage?.interaction === 'time_agreed' && !call.callback_at) warnings.push({ title: 'Agreed meeting time is missing', evidence: 'The next-step stage records a time agreement but no callback date or time is saved.' });
  if (nextStage?.interaction === 'agreed_to_receive' && !nextStage.next_step_channel) warnings.push({ title: 'Delivery channel is missing', evidence: 'Information was agreed to, but no email or WhatsApp channel is recorded.' });
  if (nextStage?.interaction === 'referred' && !nextStage.referral_details) warnings.push({ title: 'Referral details are missing', evidence: 'The call is marked as referred, but no referral details are saved.' });
  if (call.final_outcome === 'interested' && needStage?.structured_result.interaction === 'only_yes_no') warnings.push({ title: 'Interest is based on yes/no responses only', evidence: 'The need stage records only yes/no answers. No broader need statement is saved.' });
  if (missingStages.length) warnings.push({ title: 'Stage information is missing', evidence: `No saved result for: ${missingStages.map((stage) => `${stage.number} — ${stage.title}`).join(', ')}.` });

  return (
    <main className="mx-auto max-w-[1380px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="cg-review-heading"><div><p className="cg-eyebrow"><span className="cg-status-dot" /> CALL HISTORY / CALL REVIEW</p><h1>Call Review</h1><p className="cg-subtitle">Conversation record / {call.status === 'completed' ? 'Completed session' : 'In progress'}</p></div><div className="cg-review-actions"><Link href="/" className="cg-quiet-button">← Back to history</Link>{call.status === 'in_progress' ? <Link href={`/calls/${call.id}`} className="cg-primary-button">Continue Call →</Link> : <p className="cg-completed-action-note">This call is already completed and remains read-only.</p>}</div></header>
      <section className="cg-review-meta" aria-label="Call details">
        <div><small>PROSPECT</small><strong>{call.contact_name || 'Not recorded'}</strong></div><div><small>ROLE</small><strong>{call.contact_role || 'Not recorded'}</strong></div><div><small>COMPANY</small><strong>{call.company_name || 'Not recorded'}</strong></div><div><small>CALL DATE</small><strong>{new Date(call.started_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</strong></div><div><small>DURATION / STAGES</small><strong>{durationSeconds === null ? 'In progress' : `${String(Math.floor(durationSeconds / 60)).padStart(2, '0')}:${String(durationSeconds % 60).padStart(2, '0')}`} · {String(completedStages).padStart(2, '0')} / 08</strong></div><div className="cg-review-outcome"><small>OUTCOME</small><strong>{outcomeLabels[call.final_outcome ?? ''] ?? 'Not recorded'}</strong></div>
      </section>

      {error ? <div className="cg-alert" role="alert">{error}</div> : null}
      <section className="cg-panel cg-summary-panel"><div className="cg-panel-header"><div><h2>Call summary</h2>{call.summary ? <span className="cg-tag">{call.summary.model_name === 'local-deterministic-summary' ? 'FALLBACK SUMMARY' : 'AI-GENERATED SUMMARY'}</span> : <span className="cg-tag">NOT GENERATED</span>}</div>{call.status === 'completed' ? <button type="button" className="cg-quiet-button" onClick={() => void generateCallSummary()} disabled={summaryLoading || Boolean(call.summary && call.summary.model_name !== 'local-deterministic-summary')}>{summaryLoading ? 'Generating summary…' : summaryError ? 'Retry summary' : call.summary?.model_name === 'local-deterministic-summary' ? 'Generate AI summary' : call.summary ? 'AI summary saved' : 'Generate AI summary'}</button> : null}</div>{summaryLoading ? <p className="cg-summary-progress" role="status"><i aria-hidden="true" />Generating summary… Waiting for the saved call record and AI response.</p> : null}{summaryError ? <div className="cg-alert" role="alert">AI summary generation failed: {summaryError} {call.summary ? 'The existing summary is still available.' : 'No summary has been saved yet.'}</div> : null}<div className="cg-summary-text">{call.summary ? <><p className="cg-muted">Generated {new Date(call.summary.created_at).toLocaleString()} · Based on saved call data. The original notes are the source of truth. {call.summary.model_name === 'local-deterministic-summary' ? 'This is a deterministic local fallback; request AI generation when ready.' : 'AI claims are unverified; check each claim against the recorded evidence.'}</p><SafeMarkdown text={call.summary.summary_text} /></> : <p className="cg-muted">{call.status === 'completed' ? 'No summary has been generated yet. Generate one from the saved call details.' : 'A summary is available after the call is completed.'}</p>}</div></section>

      <section className="cg-panel cg-timeline-panel"><div className="cg-panel-header"><div><h2>Conversation timeline</h2><span className="cg-muted">8 stages / chronological record</span></div></div><div className="cg-review-timeline">
        {STAGES.map((stage) => {
          const result = call.stageResults.find((item) => item.stage_number === stage.number);
          const data = result?.structured_result ?? {};
          const legacyResponses = data.question_responses && typeof data.question_responses === 'object' ? data.question_responses as Record<string, unknown> : {};
          const legacyAsked = Array.isArray(data.asked_questions) ? data.asked_questions.filter((question): question is string => typeof question === 'string') : [];
          const legacyCustom = Array.isArray(data.custom_questions) ? data.custom_questions.filter((question): question is string => typeof question === 'string') : [];
          const savedQuestions = result?.questions ?? [];
          const questionTextList = [...new Set([...stage.questions, ...savedQuestions.map((question) => question.question_text), ...legacyCustom])];
          const questionRows: StageQuestion[] = questionTextList.map((questionText, index) => {
            const savedQuestion = savedQuestions.find((question) => question.question_text === questionText);
            const response = legacyResponses[questionText];
            return savedQuestion ?? {
              id: `legacy-${stage.number}-${index}`, question_text: questionText,
              source: legacyCustom.includes(questionText) ? 'custom' : 'suggested', asked: legacyAsked.includes(questionText),
              response: typeof response === 'string' ? response : null, position: index,
            };
          });
          const interaction = typeof data.interaction === 'string' ? interactionLabels[data.interaction] ?? data.interaction : '';
          const hasData = hasRecordedStage(result);
          const structuredDetails = [
            ['Need or goal', data.need], ['Objection or concern', data.objection], ['Agreed next step', data.next_step],
            ['Next-step owner', data.next_step_owner], ['Delivery channel', data.next_step_channel], ['Referral details', data.referral_details],
            ['Referral contact details', data.referral_contact_provided],
          ].filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].trim().length > 0);
          return <details className={`cg-review-stage${hasData ? '' : ' missing'}`} key={stage.number}>
            <summary><span className="cg-review-stage-number">{String(stage.number).padStart(2, '0')}</span><strong>{stage.title}</strong><span className={`cg-recorded-badge${hasData ? '' : ' missing'}`}>{hasData ? result?.stage_status === 'completed' ? 'RECORDED' : 'IN PROGRESS' : 'NOT RECORDED'}</span><span className="cg-review-stage-note">{interaction || (result?.notes ? result.notes.slice(0, 90) : 'Not reached or no stage data recorded')}</span></summary>
            <div className="cg-review-stage-detail">
              <section><h3>Interaction</h3><p>{interaction || 'No structured interaction recorded.'}</p><h3>Questions asked</h3>{questionRows.some((question) => question.asked) ? <ul>{questionRows.filter((question) => question.asked).map((question) => <li key={question.id}>{question.question_text}</li>)}</ul> : <p>No questions marked as asked.</p>}<h3>Unasked questions</h3>{questionRows.some((question) => !question.asked) ? <ul>{questionRows.filter((question) => !question.asked).map((question) => <li key={question.id}>{question.question_text}</li>)}</ul> : <p>None.</p>}</section>
              <section><h3>Stage notes</h3><p className="cg-preserve-lines">{result?.notes || 'No notes recorded for this stage.'}</p>{structuredDetails.map(([label, value]) => <div className="cg-detail-value" key={label}><h3>{label}</h3><p className="cg-preserve-lines">{value}</p></div>)}</section>
              <section><h3>Questions and responses</h3>{questionRows.some((question) => question.response?.trim()) ? questionRows.filter((question) => question.response?.trim()).map((question) => <div className="cg-response-pair" key={question.id}><strong>Q</strong><p>{question.question_text}</p><strong>A</strong><p className="cg-preserve-lines">{question.response}</p></div>) : <p>No individual responses recorded.</p>}{questionRows.some((question) => question.asked && !question.response?.trim()) ? <p>Some asked questions have no saved response.</p> : null}</section>
            </div>
          </details>;
        })}
      </div></section>

      <section className="cg-review-bottom-grid cg-facts-grid"><article className="cg-panel"><div className="cg-panel-header"><h2>Recorded needs</h2></div><ul className="cg-fact-list">{call.stageResults.filter((stage) => typeof stage.structured_result.need === 'string' && stage.structured_result.need.trim()).map((stage) => <li key={stage.id}>{String(stage.structured_result.need)}</li>)}{!call.stageResults.some((stage) => typeof stage.structured_result.need === 'string' && stage.structured_result.need.trim()) ? <li>No needs recorded.</li> : null}</ul></article><article className="cg-panel"><div className="cg-panel-header"><h2>Objections and concerns</h2></div><ul className="cg-fact-list">{call.stageResults.filter((stage) => typeof stage.structured_result.objection === 'string' && stage.structured_result.objection.trim()).map((stage) => <li key={stage.id}>{String(stage.structured_result.objection)}</li>)}{!call.stageResults.some((stage) => typeof stage.structured_result.objection === 'string' && stage.structured_result.objection.trim()) ? <li>No objections recorded.</li> : null}</ul></article><article className="cg-panel"><div className="cg-panel-header"><h2>Agreed next step</h2></div><dl className="cg-review-context"><div><dt>Action</dt><dd>{(call.stageResults.map((stage) => stage.structured_result.next_step).find((value) => typeof value === 'string' && value.trim()) as string | undefined) ?? 'No next step recorded'}</dd></div><div><dt>Owner</dt><dd>{(call.stageResults.map((stage) => stage.structured_result.next_step_owner).find((value) => typeof value === 'string' && value.trim()) as string | undefined) ?? 'Not recorded'}</dd></div><div><dt>Channel</dt><dd>{(call.stageResults.map((stage) => stage.structured_result.next_step_channel).find((value) => typeof value === 'string' && value.trim()) as string | undefined) ?? 'Not recorded'}</dd></div><div><dt>Callback</dt><dd>{call.callback_at ? new Date(call.callback_at).toLocaleString() : 'No callback scheduled'}</dd></div><div><dt>Outcome</dt><dd>{outcomeLabels[call.final_outcome ?? ''] ?? 'Not recorded'}</dd></div></dl></article></section>

      <div className="cg-review-bottom-grid"><section className="cg-panel"><div className="cg-panel-header"><h2>Call context</h2></div><dl className="cg-review-context"><div><dt>Call purpose</dt><dd>{call.call_purpose || 'Not recorded'}</dd></div><div><dt>Preparation notes</dt><dd>{call.initial_context || 'Not recorded'}</dd></div><div><dt>Closing notes</dt><dd>{call.final_notes || 'Not recorded'}</dd></div><div><dt>Started</dt><dd>{new Date(call.started_at).toLocaleString()}</dd></div><div><dt>Completed</dt><dd>{call.completed_at ? new Date(call.completed_at).toLocaleString() : 'Call still in progress'}</dd></div></dl></section>
        <section className={`cg-panel cg-consistency${warnings.length ? ' warning' : ''}`}><div className="cg-panel-header"><h2>Record consistency</h2><span className="cg-muted">Advisory only / call data is unchanged</span></div>{warnings.length ? <ul className="cg-warning-list">{warnings.map((warning) => <li key={warning.title}><strong>{warning.title}</strong><p>{warning.evidence}</p></li>)}</ul> : <div><strong>No consistency issues found.</strong><p>Warnings are advisory; review the saved stage records as the source of truth.</p></div>}</section></div>
    </main>
  );
}
