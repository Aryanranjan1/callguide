'use client';

import Link from 'next/link';
import { GuardedLink, useNavigationGuard } from '@/components/app-shell';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { closeCall, generateQuestions, generateSummary, loadCall, saveStage } from '@/lib/api';
import { STAGES } from '@/lib/stages';
import type { CallDetail, CallOutcome, QuestionGenerationResult, StageQuestion } from '@/lib/types';

type StructuredStageData = Record<string, unknown> & {
  asked_questions?: string[];
  question_responses?: Record<string, string>;
  custom_questions?: string[];
  interaction?: string;
  need?: string;
  objection?: string;
  next_step?: string;
  next_step_owner?: string;
  next_step_channel?: string;
  referral_details?: string;
  referral_contact_provided?: string;
  flags?: { language_handoff?: boolean; poor_line?: boolean };
};
type StageDraft = { notes: string; structured_result: StructuredStageData; questions: StageQuestion[]; callbackAt: string | null; dirty: boolean };
type DraftState = Record<number, StageDraft>;
type SaveFeedback = Record<number, { status: 'saving' | 'saved' | 'error'; version: number }>;

function newQuestion(questionText: string, position: number, source: StageQuestion['source'] = 'suggested'): StageQuestion {
  return { id: crypto.randomUUID(), question_text: questionText, source, asked: false, response: null, position };
}

const emptyDraft = (callbackAt: string | null = null): StageDraft => ({
  notes: '', structured_result: {}, questions: [], callbackAt, dirty: false,
});
const outcomes = [
  ['next_step_agreed', 'Next step agreed'], ['agreed_to_receive_report', 'Agreed to receive report'], ['interested', 'Interested'],
  ['follow_up', 'Follow-up'], ['call_again', 'Call again'], ['not_interested', 'Not interested'],
  ['do_not_call', 'Do not call'], ['wrong_person', 'Wrong person'], ['moved_company', 'Moved company'],
];
const stageChoices: Record<number, [string, string][]> = {
  1: [['right_person', 'Right person'], ['reception', 'Reception'], ['cant_talk_now', "Can't talk now"], ['wrong_number', 'Not them / wrong number']],
  2: [['understood', 'Understood'], ['asked_what_we_do', 'Asked what we do'], ['asked_why_free', 'Asked why free'], ['asked_source_of_number', 'Asked source of number']],
  3: [['clear_yes', 'Clear yes'], ['call_later', 'Call later'], ['clear_no', 'Clear no'], ['continued_without_yes', 'Continued without explicit yes']],
  4: [['described_work', 'Described work'], ['corrected_us', 'Corrected us'], ['asked_about_us', 'Asked about us'], ['not_their_area', 'Not their area']],
  5: [['stated_goal', 'Stated goal'], ['no_need', 'No need'], ['only_yes_no', 'Only yes / no'], ['asked_what_we_can_do', 'Asked what we can do']],
  6: [['not_right_person', 'Not right person'], ['has_provider', 'Has provider'], ['send_details_first', 'Send details first'], ['no_reason', 'No reason']],
  7: [['time_agreed', 'Time agreed'], ['agreed_to_receive', 'Agreed to receive information'], ['referred', 'Referred'], ['nothing_agreed', 'Nothing agreed']],
};

function toLocalDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function hasSavedStageData(result: CallDetail['stageResults'][number] | undefined) {
  if (!result) return false;
  if (result.notes?.trim()) return true;
  if (Object.values(result.structured_result).some((value) => typeof value === 'string' && value.trim())) return true;
  if (result.structured_result.flags && typeof result.structured_result.flags === 'object'
    && Object.values(result.structured_result.flags).some(Boolean)) return true;
  return Boolean(result.questions?.some((question) => question.asked || question.response?.trim()));
}

function CallDuration({ startedAt, completedAt }: { startedAt: string; completedAt: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const start = Date.parse(startedAt);
    const end = completedAt ? Date.parse(completedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const initialTimer = window.setTimeout(() => setNow(end), 0);
    if (completedAt) return () => window.clearTimeout(initialTimer);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, [completedAt, startedAt]);
  if (now === null) return <span className="cg-call-duration">Duration unavailable</span>;
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return <span className="cg-call-duration" aria-label="Call duration">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')} elapsed</span>;
}

function toDraft(result: CallDetail): DraftState {
  return Object.fromEntries(STAGES.map((stage) => {
    const saved = result.stageResults.find((item) => item.stage_number === stage.number);
    const structured = { ...(saved?.structured_result ?? {}) } as StructuredStageData;
    const responseMap: Record<string, string> = structured.question_responses ?? {};
    const askedQuestions: string[] = structured.asked_questions ?? [];
    const customQuestions: string[] = structured.custom_questions ?? [];
    delete structured.asked_questions;
    delete structured.question_responses;
    delete structured.custom_questions;
    const savedQuestions = saved?.questions ?? [];
    const defaultTexts = stage.questions;
    const extraTexts = [...savedQuestions.map((question) => question.question_text), ...customQuestions]
      .filter((text) => !defaultTexts.some((defaultText) => defaultText.trim().toLocaleLowerCase() === text.trim().toLocaleLowerCase()));
    const texts = [...defaultTexts, ...extraTexts];
    const questions = [...new Set(texts)].map((questionText, position) => {
      const previous = savedQuestions.find((question) => question.question_text.trim().toLocaleLowerCase() === questionText.trim().toLocaleLowerCase());
      if (previous) return { ...previous, question_text: questionText, position };
      return {
        ...newQuestion(questionText, position, customQuestions.some((text) => text.trim().toLocaleLowerCase() === questionText.trim().toLocaleLowerCase()) ? 'custom' : 'suggested'),
        asked: askedQuestions.includes(questionText),
        response: responseMap[questionText] ?? null,
      };
    });
    return [stage.number, { notes: saved?.notes ?? '', structured_result: structured, questions, callbackAt: toLocalDateTime(result.callback_at), dirty: false }];
  }));
}

export default function CallWorkspacePage() {
  return <Suspense fallback={<main className="p-8 text-slate-700">Loading call workspace…</main>}><CallWorkspaceContent /></Suspense>;
}

function CallWorkspaceContent() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const callId = params?.id;
  const [call, setCall] = useState<CallDetail | null>(null);
  const [selectedStage, setSelectedStage] = useState(1);
  const [drafts, setDrafts] = useState<DraftState>({});
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>({});
  const [stageVersions, setStageVersions] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [closeOutcome, setCloseOutcome] = useState<CallOutcome | ''>('');
  const [closeNotes, setCloseNotes] = useState('');
  const [closeCallbackAt, setCloseCallbackAt] = useState('');
  const closeCallbackTouched = useRef(false);
  const [closing, setClosing] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [customQuestion, setCustomQuestion] = useState('');
  const [questionResult, setQuestionResult] = useState<QuestionGenerationResult | null>(null);
  const [questionResultStage, setQuestionResultStage] = useState<number | null>(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [questionRequestStage, setQuestionRequestStage] = useState<number | null>(null);
  const [questionErrorStage, setQuestionErrorStage] = useState<number | null>(null);
  const questionRequest = useRef<AbortController | null>(null);
  const [doNotCallConfirmed, setDoNotCallConfirmed] = useState(false);
  const draftVersions = useRef<Record<number, number>>({});
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const savePromises = useRef(new Map<string, Promise<boolean>>());

  useEffect(() => {
    let active = true;
    if (!callId) return () => { active = false; };
    loadCall(callId).then((result) => {
      if (!active) return;
      setCall(result);
      setDrafts(toDraft(result));
      const lastSavedStage = result.stageResults.filter((item) => hasSavedStageData(item))
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];
      setSelectedStage(lastSavedStage?.stage_number ?? 1);
      setCloseCallbackAt(toLocalDateTime(result.callback_at));
      closeCallbackTouched.current = false;
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load call.');
    });
    return () => { active = false; };
  }, [callId]);

  const currentStage = STAGES[selectedStage - 1]!;
  const currentDraft = drafts[selectedStage] ?? emptyDraft(call?.callback_at ?? null);
  const defaultQuestions = currentStage.questions.map((text) => currentDraft.questions.find((question) => question.question_text.trim().toLocaleLowerCase() === text.trim().toLocaleLowerCase())).filter((question): question is StageQuestion => Boolean(question));
  const defaultQuestionTexts = new Set(currentStage.questions.map((text) => text.trim().toLocaleLowerCase()));
  const additionalQuestions = currentDraft.questions.filter((question) => !defaultQuestionTexts.has(question.question_text.trim().toLocaleLowerCase()));
  const visibleQuestionResult = questionResultStage === selectedStage ? questionResult : null;
  const data = currentDraft.structured_result;
  const stageTitle = useMemo(() => `${String(selectedStage).padStart(2, '0')} / ${String(STAGES.length).padStart(2, '0')}`, [selectedStage]);
  const currentVersion = stageVersions[selectedStage] ?? 0;
  const currentFeedback = saveFeedback[selectedStage];
  const saveStatus = currentDraft.dirty
    ? currentFeedback?.version === currentVersion && currentFeedback.status === 'saving' ? 'saving'
      : currentFeedback?.version === currentVersion && currentFeedback.status === 'error' ? 'error' : 'unsaved'
    : call?.stageResults.some((item) => item.stage_number === selectedStage && hasSavedStageData(item)) ? 'saved' : 'empty';

  function patchDraft(patch: Partial<StageDraft>) {
    const nextVersion = (draftVersions.current[selectedStage] ?? 0) + 1;
    draftVersions.current[selectedStage] = nextVersion;
    setStageVersions((previous) => ({ ...previous, [selectedStage]: nextVersion }));
    setDrafts((previous) => ({ ...previous, [selectedStage]: { ...(previous[selectedStage] ?? emptyDraft()), ...patch, dirty: true } }));
  }

  function patchStructured(patch: Partial<StructuredStageData>) {
    patchDraft({ structured_result: { ...data, ...patch } });
  }

  function changeInteraction(interaction: string) {
    const next = { ...data, interaction };
    if (selectedStage === 3 && interaction !== 'call_later') { patchDraft({ callbackAt: null, structured_result: next }); return; }
    if (selectedStage === 7) {
      if (interaction !== 'time_agreed') { delete next.next_step_owner; }
      if (interaction !== 'agreed_to_receive') { delete next.next_step_channel; }
      if (interaction !== 'referred') { delete next.referral_details; delete next.referral_contact_provided; }
      if (interaction === 'nothing_agreed') delete next.next_step;
      patchDraft({ structured_result: next, ...(interaction === 'time_agreed' ? {} : { callbackAt: null }) });
      return;
    }
    patchStructured({ interaction });
  }

  function patchQuestion(questionId: string, patch: Partial<StageQuestion>) {
    patchDraft({ questions: currentDraft.questions.map((question) => question.id === questionId ? { ...question, ...patch } : question) });
  }

  function addCustomQuestion(text: string) {
    const questionText = text.trim();
    if (!questionText || currentDraft.questions.some((question) => question.question_text.toLowerCase() === questionText.toLowerCase())) return;
    patchDraft({ questions: [...currentDraft.questions, newQuestion(questionText, currentDraft.questions.length, 'custom')] });
  }

  function removeQuestion(questionId: string) {
    patchDraft({ questions: currentDraft.questions.filter((question) => question.id !== questionId).map((question, position) => ({ ...question, position })) });
  }

  const saveStageDraft = useCallback((stageNumber = selectedStage, snapshot?: StageDraft): Promise<boolean> => {
    if (!callId || !call || call.status === 'completed') return Promise.resolve(false);
    const draft = snapshot ?? drafts[stageNumber] ?? emptyDraft();
    const version = draftVersions.current[stageNumber] ?? 0;
    const saveKey = `${stageNumber}:${version}`;
    const pending = savePromises.current.get(saveKey);
    if (pending) return pending;
    if (draft.questions.some((question) => !question.question_text.trim())) {
      setSaveFeedback((previous) => ({ ...previous, [stageNumber]: { status: 'error', version } }));
      setError('Custom questions cannot be empty. Edit the question or remove it before saving.');
      return Promise.resolve(false);
    }
    const operation = saveQueue.current.then(async () => {
      setSaveFeedback((previous) => ({ ...previous, [stageNumber]: { status: 'saving', version } }));
      setError(null);
      const hasRecordedData = Boolean(
        draft.notes.trim()
        || Object.values(draft.structured_result).some((value) => typeof value === 'string' && value.trim())
        || draft.questions.some((question) => question.asked || Boolean(question.response?.trim())),
      );
      try {
        const ownsCallback = stageNumber === 3 || stageNumber === 7;
        const callbackAt = ownsCallback ? (draft.callbackAt ? new Date(draft.callbackAt).toISOString() : null) : undefined;
        const saved = await saveStage(callId, stageNumber, draft.notes, draft.structured_result, hasRecordedData ? 'completed' : 'in_progress', draft.questions, callbackAt);
        setCall((previous) => previous ? { ...previous, summary: null, ...(callbackAt === undefined ? {} : { callback_at: callbackAt }), stageResults: [...previous.stageResults.filter((item) => item.stage_number !== stageNumber), saved].sort((a, b) => a.stage_number - b.stage_number) } : previous);
        if (callbackAt !== undefined && !closeCallbackTouched.current) {
          setCloseCallbackAt(toLocalDateTime(callbackAt));
          setDrafts((previous) => Object.fromEntries(Object.entries(previous).map(([number, item]) => [number, Number(number) === stageNumber ? item : { ...item, callbackAt: toLocalDateTime(callbackAt) }])));
        }
        const unchanged = (draftVersions.current[stageNumber] ?? 0) === version;
        setDrafts((previous) => ({ ...previous, [stageNumber]: { ...(previous[stageNumber] ?? draft), dirty: unchanged ? false : previous[stageNumber]?.dirty ?? true } }));
        if (unchanged) setSaveFeedback((previous) => ({ ...previous, [stageNumber]: { status: 'saved', version } }));
        return true;
      } catch (saveError) {
        if ((draftVersions.current[stageNumber] ?? 0) === version) {
          setSaveFeedback((previous) => ({ ...previous, [stageNumber]: { status: 'error', version } }));
          setError(saveError instanceof Error ? saveError.message : 'Unable to save stage. Your draft is still here; retry when ready.');
        }
        return false;
      }
    });
    saveQueue.current = operation.then(() => undefined, () => undefined);
    savePromises.current.set(saveKey, operation);
    void operation.then(() => {
      if (savePromises.current.get(saveKey) === operation) savePromises.current.delete(saveKey);
    });
    return operation;
  }, [call, callId, drafts, selectedStage]);

  const guardNavigation = useCallback(async () => {
    const dirtyStages = Object.entries(drafts).filter(([, draft]) => draft.dirty);
    if (!dirtyStages.length) return true;
    for (const [stageNumber, draft] of dirtyStages) {
      const saved = await saveStageDraft(Number(stageNumber), draft);
      if (!saved) return false;
    }
    return true;
  }, [drafts, saveStageDraft]);
  useNavigationGuard(guardNavigation);

  useEffect(() => {
    if (call?.status !== 'in_progress' || !currentDraft.dirty) return;
    const stageNumber = selectedStage;
    const snapshot = currentDraft;
    const timer = window.setTimeout(() => { void saveStageDraft(stageNumber, snapshot); }, 900);
    return () => window.clearTimeout(timer);
  }, [call?.status, currentDraft, saveStageDraft, selectedStage]);

  useEffect(() => () => questionRequest.current?.abort(), []);

  useEffect(() => {
    if (!Object.values(drafts).some((draft) => draft.dirty)) return;
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [drafts]);

  async function goToStage(stageNumber: number) {
    if (stageNumber === selectedStage) return;
    if (currentDraft.dirty && !(await saveStageDraft())) return;
    setSelectedStage(stageNumber);
    setError(null);
  }

  async function closeCurrentCall() {
    if (!callId || !closeOutcome) { setError('Select a final outcome before closing the call.'); return; }
    if (closeOutcome === 'do_not_call' && !doNotCallConfirmed) { setError('Confirm that the prospect explicitly requested no further calls.'); return; }
    if (currentDraft.dirty && !(await saveStageDraft())) return;
    setClosing(true);
    setError(null);
    try {
      const callbackAt = closeCallbackTouched.current ? (closeCallbackAt ? new Date(closeCallbackAt).toISOString() : null) : undefined;
      await closeCall(callId, closeOutcome, closeNotes, doNotCallConfirmed, callbackAt);
      router.push(`/calls/${callId}/review`);
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : 'Unable to close call.');
    } finally { setClosing(false); }
  }

  async function generateCallSummary() {
    if (!callId || call?.status !== 'completed') return;
    setSummaryLoading(true);
    setError(null);
    try {
      const summary = await generateSummary(callId);
      setCall((previous) => previous ? { ...previous, summary: { ...summary, created_at: summary.created_at ?? new Date().toISOString() } } : previous);
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : 'Unable to generate summary.');
    } finally { setSummaryLoading(false); }
  }

  async function refreshQuestionSuggestions() {
    if (!callId || call?.status !== 'in_progress') return;
    if (currentDraft.dirty && !(await saveStageDraft())) return;
    questionRequest.current?.abort();
    const controller = new AbortController();
    questionRequest.current = controller;
    setQuestionRequestStage(selectedStage);
    setQuestionLoading(true); setQuestionError(null);
    try {
      const result = await generateQuestions(callId, selectedStage, true, controller.signal);
      setQuestionResult(result);
      setQuestionResultStage(selectedStage);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setQuestionError(loadError instanceof Error ? loadError.message : 'Unable to refresh question suggestions.');
        setQuestionErrorStage(selectedStage);
      }
    } finally {
      if (!controller.signal.aborted) { setQuestionLoading(false); setQuestionRequestStage(null); }
    }
  }

  function addRecommendedQuestion(text: string) {
    if (currentDraft.questions.some((question) => question.question_text.trim().toLowerCase() === text.trim().toLowerCase())) return;
    patchDraft({ questions: [...currentDraft.questions, newQuestion(text, currentDraft.questions.length, 'custom')] });
  }

  if (!call) return <main role={error ? 'alert' : 'status'} className="p-8 text-slate-700">{error ?? 'Loading call…'}</main>;

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-7">
      <header className="cg-page-heading">
        <div><p className="cg-eyebrow"><span className="cg-status-dot" /> {call.status === 'completed' ? 'COMPLETED SESSION' : 'LIVE CALL SESSION'}</p><h1>{call.contact_name || call.company_name || 'Active call'}</h1><p className="cg-subtitle">{[call.contact_role, call.company_name].filter(Boolean).join(' · ') || call.call_purpose || 'Structured conversation workspace'}</p><CallDuration startedAt={call.started_at} completedAt={call.completed_at} /></div>
        <div className="flex flex-wrap gap-2"><GuardedLink href="/" className="cg-quiet-button">← History</GuardedLink>{call.status === 'completed' ? <GuardedLink href={`/calls/${callId}/review`} className="cg-primary-button">Open review →</GuardedLink> : null}</div>
      </header>

      <nav className="cg-stage-tracker" aria-label="Call stages">
        {STAGES.map((stage) => {
          const saved = call.stageResults.find((result) => result.stage_number === stage.number);
          const selected = selectedStage === stage.number;
          const complete = Boolean(saved && hasSavedStageData(saved));
          return <button key={stage.number} type="button" aria-current={selected ? 'step' : undefined} disabled={saveStatus === 'saving'} onClick={() => void goToStage(stage.number)} className={`cg-stage-step${selected ? ' active' : ''}${complete ? ' complete' : ''}`}>
            <span className="cg-stage-step-number">{complete && !selected ? '✓' : String(stage.number).padStart(2, '0')}</span><span>{String(stage.number).padStart(2, '0')} {stage.title}</span>
          </button>;
        })}
      </nav>

      <div className="cg-workspace-grid">
        <section className="cg-panel cg-stage-content">
          <div className="cg-panel-header cg-stage-title"><div><p className="cg-eyebrow">STAGE {stageTitle}</p><h2>{currentStage.title}</h2><p>{currentStage.objective}</p></div><span className={`cg-save-state ${saveStatus}`} role="status" aria-live="polite">{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Not saved — retry' : saveStatus === 'empty' ? 'No changes yet' : 'Not saved'}</span></div>
          <div className="cg-stage-body">
            <section className="cg-guidance"><h3>What to establish</h3><p>{currentStage.guidance}</p><small>Stage objective · {currentStage.objective}</small></section>
            <section className="cg-question-section">
              <div className="cg-section-title"><h3>Questions to explore</h3><button type="button" className="cg-quiet-button" onClick={() => { document.getElementById('custom-question')?.focus(); }} disabled={call.status === 'completed'}>＋ Add custom question</button></div>
              <section className="cg-default-questions"><h4>Default questions</h4><p>CallGuide guidance for this stage.</p>
                {defaultQuestions.map((question) => <div className="cg-question-row" key={question.id}>
                  <div className="cg-question-prompt"><label><input type="checkbox" checked={question.asked} disabled={call.status === 'completed'} onChange={(event) => patchQuestion(question.id, { asked: event.target.checked })} /><span>Asked</span></label><span className="cg-question-text">{question.question_text}</span><small className="cg-tag">DEFAULT</small></div>
                  <textarea aria-label={`Response to: ${question.question_text}`} maxLength={1000} rows={2} disabled={call.status === 'completed'} value={question.response ?? ''} onChange={(event) => patchQuestion(question.id, { response: event.target.value })} placeholder="Capture their response…" />
                </div>)}
              </section>
              {call.status === 'in_progress' ? <section className="cg-ai-suggestions" aria-label="AI suggestions">
                <div className="cg-section-title"><div><h4>AI suggestions</h4><p>Optional additions based on saved call context. Default questions remain available.</p></div><button type="button" className="cg-outline-button" onClick={() => void refreshQuestionSuggestions()} disabled={questionLoading}>{questionLoading ? 'Generating…' : questionError && questionErrorStage === selectedStage ? 'Retry AI suggestions' : visibleQuestionResult ? 'Refresh suggestions' : 'Get AI suggestions'}</button></div>
                {questionLoading && questionRequestStage === selectedStage ? <p className="cg-muted" role="status">Generating suggestions from saved call context…</p> : null}
                {questionError && questionErrorStage === selectedStage ? <p className="cg-inline-error" role="alert">AI suggestions could not be generated. Default questions remain available. Try again when ready.</p> : null}
                {visibleQuestionResult?.status === 'ok' ? <ul>{visibleQuestionResult.questions.map((item) => <li key={item.question}><div><strong>{item.question}</strong><small>{item.reason} {item.intent} · {item.priority} priority</small></div><button type="button" className="cg-quiet-button" disabled={currentDraft.questions.some((question) => question.question_text.trim().toLowerCase() === item.question.trim().toLowerCase())} onClick={() => addRecommendedQuestion(item.question)}>Add to questions</button></li>)}</ul> : null}
                {visibleQuestionResult?.status === 'insufficient_context' ? <p className="cg-muted">More saved call context is needed before AI can suggest an additional question.</p> : null}
                {visibleQuestionResult?.status === 'no_recommendation' ? <p className="cg-muted">There is no appropriate additional question to suggest for this call state.</p> : null}
                {visibleQuestionResult?.status === 'ok' ? <small className="cg-muted">{visibleQuestionResult.source === 'fallback' ? 'Contextual fallback · AI unavailable. Verify against the conversation.' : 'AI generated · verify against the conversation.'} Suggestions are not marked as asked.</small> : null}
              </section> : null}
              {additionalQuestions.length ? <section className="cg-additional-questions"><h4>Added questions</h4>{additionalQuestions.map((question) => <div className="cg-question-row" key={question.id}>
                <div className="cg-question-prompt"><label><input type="checkbox" checked={question.asked} disabled={call.status === 'completed'} onChange={(event) => patchQuestion(question.id, { asked: event.target.checked })} /><span>Asked</span></label><textarea className="cg-question-text-input" aria-label="Edit added question" maxLength={240} rows={1} disabled={call.status === 'completed'} value={question.question_text} ref={(element) => { if (element) { element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; } }} onChange={(event) => patchQuestion(question.id, { question_text: event.target.value })} /><small className="cg-tag">ADDED</small>{call.status !== 'completed' ? <button type="button" className="cg-remove-question" aria-label={`Remove ${question.question_text}`} onClick={() => removeQuestion(question.id)}>Remove</button> : null}</div>
                <textarea aria-label={`Response to: ${question.question_text}`} maxLength={1000} rows={2} disabled={call.status === 'completed'} value={question.response ?? ''} onChange={(event) => patchQuestion(question.id, { response: event.target.value })} placeholder="Capture their response…" />
              </div>)}</section> : null}
              {call.status !== 'completed' ? <form className="cg-add-question" onSubmit={(event) => { event.preventDefault(); addCustomQuestion(customQuestion); setCustomQuestion(''); }}><label className="sr-only" htmlFor="custom-question">Add a custom question</label><input id="custom-question" maxLength={240} value={customQuestion} onChange={(event) => setCustomQuestion(event.target.value)} placeholder="Write a custom question…" /><button type="submit" className="cg-quiet-button" disabled={!customQuestion.trim()}>Add</button></form> : null}
            </section>
            <div className="cg-capture-grid">
              <section className="cg-capture-card"><h3>What happened</h3>{stageChoices[selectedStage] ? <><label className="cg-field-label" htmlFor="interaction">Stage result</label><select id="interaction" className="cg-select cg-full-width" disabled={call.status === 'completed'} value={typeof data.interaction === 'string' ? data.interaction : ''} onChange={(event) => changeInteraction(event.target.value)}><option value="">Select what happened</option>{stageChoices[selectedStage]!.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></> : <p className="cg-muted">Record the actual conversation and choose its final outcome before closing.</p>}
                {selectedStage === 1 ? <div className="cg-flag-list"><label><input type="checkbox" checked={data.flags?.language_handoff === true} disabled={call.status === 'completed'} onChange={(event) => patchStructured({ flags: { ...data.flags, language_handoff: event.target.checked } })} /> Language handoff</label><label><input type="checkbox" checked={data.flags?.poor_line === true} disabled={call.status === 'completed'} onChange={(event) => patchStructured({ flags: { ...data.flags, poor_line: event.target.checked } })} /> Poor line</label></div> : null}
                {selectedStage === 3 && data.interaction === 'call_later' ? <label className="cg-structured-field">Schedule a call back<input type="datetime-local" disabled={call.status === 'completed'} value={currentDraft.callbackAt ?? ''} onChange={(event) => patchDraft({ callbackAt: event.target.value || null })} /></label> : null}
                {selectedStage === 5 ? <label className="cg-structured-field">Need or goal<textarea maxLength={1000} rows={2} disabled={call.status === 'completed'} value={typeof data.need === 'string' ? data.need : ''} onChange={(event) => patchStructured({ need: event.target.value })} placeholder="Use the prospect’s words where possible" /></label> : null}
                {selectedStage === 6 ? <label className="cg-structured-field">Objection or concern<textarea maxLength={1000} rows={2} disabled={call.status === 'completed'} value={typeof data.objection === 'string' ? data.objection : ''} onChange={(event) => patchStructured({ objection: event.target.value })} placeholder="Record the concern as stated" /></label> : null}
                {selectedStage === 7 && data.interaction === 'time_agreed' ? <><label className="cg-structured-field">Agreed date and time<input type="datetime-local" disabled={call.status === 'completed'} value={currentDraft.callbackAt ?? ''} onChange={(event) => patchDraft({ callbackAt: event.target.value || null })} /></label><label className="cg-structured-field">Responsible party<select className="cg-select cg-full-width" disabled={call.status === 'completed'} value={typeof data.next_step_owner === 'string' ? data.next_step_owner : ''} onChange={(event) => patchStructured({ next_step_owner: event.target.value })}><option value="">Select owner</option><option value="prospect">Prospect</option><option value="caller">Caller</option></select></label></> : null}
                {selectedStage === 7 && data.interaction === 'agreed_to_receive' ? <label className="cg-structured-field">Delivery channel<select className="cg-select cg-full-width" disabled={call.status === 'completed'} value={typeof data.next_step_channel === 'string' ? data.next_step_channel : ''} onChange={(event) => patchStructured({ next_step_channel: event.target.value })}><option value="">Select channel</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></label> : null}
                {selectedStage === 7 && data.interaction === 'referred' ? <><label className="cg-structured-field">Referral details<textarea maxLength={1000} rows={2} disabled={call.status === 'completed'} value={typeof data.referral_details === 'string' ? data.referral_details : ''} onChange={(event) => patchStructured({ referral_details: event.target.value })} /></label><label className="cg-structured-field">Contact details provided?<select className="cg-select cg-full-width" disabled={call.status === 'completed'} value={typeof data.referral_contact_provided === 'string' ? data.referral_contact_provided : ''} onChange={(event) => patchStructured({ referral_contact_provided: event.target.value })}><option value="">Select one</option><option value="provided">Provided</option><option value="vague">Vague referral only</option></select></label></> : null}
                {selectedStage === 7 && typeof data.interaction === 'string' && data.interaction !== 'nothing_agreed' ? <label className="cg-structured-field">Agreed next step<textarea maxLength={1000} rows={2} disabled={call.status === 'completed'} value={typeof data.next_step === 'string' ? data.next_step : ''} onChange={(event) => patchStructured({ next_step: event.target.value })} placeholder="Describe the agreed action" /></label> : null}
              </section>
              <label className="cg-capture-card cg-notes-field"><h3>Stage notes</h3><textarea maxLength={4000} rows={7} disabled={call.status === 'completed'} value={currentDraft.notes} onChange={(event) => patchDraft({ notes: event.target.value })} placeholder="Capture context, useful details, and exact wording…" /><span>{currentDraft.notes.length} / 4000</span></label>
            </div>
            {error ? <div className="cg-alert" role="alert">{error}{saveStatus === 'error' ? <button type="button" className="cg-quiet-button" onClick={() => void saveStageDraft()}>Retry save</button> : null}</div> : null}
            <footer className="cg-stage-actions"><button type="button" className="cg-quiet-button" disabled={selectedStage === 1 || saveStatus === 'saving'} onClick={() => void goToStage(selectedStage - 1)}>← Previous stage</button><div><button type="button" className="cg-quiet-button" disabled={call.status === 'completed' || saveStatus === 'saving'} onClick={() => void saveStageDraft()}>{saveStatus === 'error' ? 'Retry save' : 'Save stage'}</button>{selectedStage < STAGES.length ? <button type="button" className="cg-primary-button" disabled={saveStatus === 'saving'} onClick={() => void goToStage(selectedStage + 1)}>Next stage →</button> : null}</div></footer>
          </div>
        </section>

        <aside className="cg-context-panel cg-panel"><header className="cg-intel-header"><div><h2>Live call intelligence</h2><p>Real-time prospect context</p></div><span className={call.status === 'in_progress' ? 'active' : 'complete'}>{call.status === 'in_progress' ? 'ACTIVE' : 'COMPLETE'}</span></header><h3 className="cg-rail-heading">Prospect</h3><dl className="cg-context-list"><div><dt>Contact</dt><dd>{call.contact_name || 'Not recorded'}</dd></div><div><dt>Role</dt><dd>{call.contact_role || 'Not recorded'}</dd></div><div><dt>Company</dt><dd>{call.company_name || 'Not recorded'}</dd></div><div><dt>Call purpose</dt><dd>{call.call_purpose || 'Not recorded'}</dd></div><div><dt>Preparation notes</dt><dd>{call.initial_context || 'No preparation notes saved.'}</dd></div>
            {call.stageResults.flatMap((stage) => [
              ['Need or goal', stage.structured_result.need], ['Objection', stage.structured_result.objection], ['Agreed next step', stage.structured_result.next_step],
            ].filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].trim().length > 0)).map(([label, value]) => <div key={`${label}-${value}`}><dt>{label}</dt><dd>{value}</dd></div>)}
            {call.callback_at ? <div><dt>Callback scheduled</dt><dd>{new Date(call.callback_at).toLocaleString()}</dd></div> : null}
          </dl>
          {call.status === 'in_progress' ? <section className="cg-close-card"><h3>{selectedStage === 8 ? 'Close call' : 'End call'}</h3><label className="cg-field-label" htmlFor="final-outcome">Final outcome</label><select id="final-outcome" className="cg-select cg-full-width" value={closeOutcome} onChange={(event) => { const outcome = event.target.value as CallOutcome | ''; setCloseOutcome(outcome); if (outcome !== 'do_not_call') setDoNotCallConfirmed(false); }}><option value="">Select an outcome</option>{outcomes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {closeOutcome === 'do_not_call' ? <label className="cg-confirm-dnc"><input type="checkbox" checked={doNotCallConfirmed} onChange={(event) => setDoNotCallConfirmed(event.target.checked)} /> The prospect explicitly requested no further calls.</label> : null}
            {closeOutcome === 'follow_up' || closeOutcome === 'call_again' ? <label className="cg-field-label" htmlFor="close-callback">Callback date and time<input id="close-callback" className="cg-date-input" type="datetime-local" value={closeCallbackAt} onChange={(event) => { closeCallbackTouched.current = true; setCloseCallbackAt(event.target.value); }} /></label> : null}
            <label className="cg-field-label" htmlFor="final-notes">Closing notes</label><textarea id="final-notes" maxLength={2000} rows={3} value={closeNotes} onChange={(event) => setCloseNotes(event.target.value)} placeholder="Any additional outcome details…" /><button type="button" className="cg-danger-button" disabled={closing || !closeOutcome || (closeOutcome === 'do_not_call' && !doNotCallConfirmed)} onClick={() => void closeCurrentCall()}>{closing ? 'Closing…' : 'End call'}</button></section> : <p className="cg-completed-note">This call is completed and read-only. <Link href={`/calls/${callId}/review`}>View review →</Link></p>}
        </aside>
      </div>

      {call.status === 'completed' ? <section className="cg-panel mt-5"><div className="cg-panel-header"><div><h2>Call summary</h2>{call.summary ? <span className="cg-tag">{call.summary.model_name === 'local-deterministic-summary' ? 'LOCAL FALLBACK · AI NOT GENERATED' : 'AI DRAFT · VERIFY AGAINST RECORD'}</span> : null}</div><button type="button" className="cg-quiet-button" onClick={() => void generateCallSummary()} disabled={summaryLoading || (Boolean(call.summary) && call.summary?.model_name !== 'local-deterministic-summary')}>{summaryLoading ? 'Generating with OpenRouter…' : call.summary?.model_name === 'local-deterministic-summary' ? 'Retry AI summary' : call.summary ? 'AI summary saved' : 'Generate AI summary'}</button></div>{call.summary ? <><p className="cg-muted px-4 pt-3">{call.summary.model_name === 'local-deterministic-summary' ? 'A local fallback is available. Retry summary generation when the provider is configured.' : 'AI-generated content is unverified. Check each claim against the recorded call.'}</p><p className="cg-summary-text">{call.summary.summary_text}</p></> : <p className="cg-muted p-4">Generate an optional summary from the saved call data.</p>}</section> : null}
    </main>
  );
}
