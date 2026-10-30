'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { apiRequest, closeCall, saveStage } from '@/lib/api';
import { STAGES } from '@/lib/stages';
import type { CallDetail } from '@/lib/types';

type DraftState = Record<number, { notes: string; structured_result: Record<string, any> }>;

export default function CallWorkspacePage() {
  return (
    <Suspense fallback={<main className="p-8 text-slate-700">Loading call workspace...</main>}>
      <CallWorkspaceContent />
    </Suspense>
  );
}

function CallWorkspaceContent() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const callId = params?.id;

  const [call, setCall] = useState<CallDetail | null>(null);
  const [selectedStage, setSelectedStage] = useState(1);
  const [drafts, setDrafts] = useState<DraftState>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [closeOutcome, setCloseOutcome] = useState('follow_up_agreed');
  const [closeNotes, setCloseNotes] = useState('');
  const [closing, setClosing] = useState(false);

  const loadCall = async () => {
    if (!callId) return;
    try {
      const result = await apiRequest<CallDetail>(`/calls/${callId}`);
      setCall(result);

      const nextDrafts: DraftState = {};
      for (const stage of STAGES) {
        const match = result.stageResults.find((item) => item.stage_number === stage.number);
        nextDrafts[stage.number] = {
          notes: match?.notes ?? '',
          structured_result: match?.structured_result ?? {},
        };
      }
      setDrafts(nextDrafts);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load call.');
    }
  };

  useEffect(() => {
    if (callId) {
      loadCall();
    }
  }, [callId]);

  const currentStage = STAGES.find((stage) => stage.number === selectedStage) ?? STAGES[0];
  const currentDraft = drafts[selectedStage] ?? { notes: '', structured_result: {} };

  const updateDraft = (field: 'notes' | 'structured_result', value: string | Record<string, any>) => {
    setDrafts((previous) => ({
      ...previous,
      [selectedStage]: {
        notes: field === 'notes' ? String(value) : previous[selectedStage]?.notes ?? '',
        structured_result: field === 'structured_result' ? (value as Record<string, any>) : previous[selectedStage]?.structured_result ?? {},
      },
    }));
  };

  const saveCurrentStage = async () => {
    if (!callId) return;
    setSaveState('saving');
    setError(null);

    try {
      await saveStage(callId, selectedStage, currentDraft.notes, currentDraft.structured_result);
      setSaveState('saved');
    } catch (saveError) {
      setSaveState('error');
      setError(saveError instanceof Error ? saveError.message : 'Unable to save stage.');
    }
  };

  const closeCurrentCall = async () => {
    if (!callId) return;
    setClosing(true);
    setError(null);

    try {
      const closed = await closeCall(callId, closeOutcome, closeNotes);
      setCall((previous) => {
        if (!previous) {
          return { ...closed, stageResults: [], summary: null } as CallDetail;
        }
        return { ...previous, ...closed, stageResults: previous.stageResults, summary: previous.summary };
      });
      router.push(`/calls/${callId}/review`);
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : 'Unable to close call.');
    } finally {
      setClosing(false);
    }
  };

  if (!call) {
    return <main className="p-8 text-slate-700">{error ? error : 'Loading call...'}</main>;
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Active call</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">{call.company_name ?? 'Untitled call'}</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">History</Link>
          <Link href={`/calls/${callId}/review`} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Review</Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr_280px]">
        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Stages</h2>
          <div className="space-y-2">
            {STAGES.map((stage) => {
              const isActive = stage.number === selectedStage;
              const stageResult = call.stageResults.find((result) => result.stage_number === stage.number);
              return (
                <button
                  key={stage.number}
                  type="button"
                  onClick={() => setSelectedStage(stage.number)}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${isActive ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}
                >
                  <span className="font-medium">{stage.number}. {stage.title}</span>
                  <span className={`text-[10px] uppercase tracking-wide ${isActive ? 'text-slate-200' : 'text-slate-500'}`}>{stageResult ? 'Saved' : 'Open'}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Stage {currentStage.number}</p>
              <h2 className="mt-2 text-2xl font-bold text-slate-900">{currentStage.title}</h2>
            </div>
            <span className={`rounded-full px-2 py-1 text-xs font-medium ${saveState === 'saved' ? 'bg-emerald-100 text-emerald-700' : saveState === 'saving' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
              {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving...' : 'Unsaved'}
            </span>
          </div>

          <div className="space-y-5">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Objective</p>
              <p className="mt-2 text-slate-700">{currentStage.objective}</p>
            </div>

            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Guidance</p>
              <p className="mt-2 text-slate-700">{currentStage.guidance}</p>
            </div>

            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Suggested prompts</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                {currentStage.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Notes</span>
              <textarea
                value={currentDraft.notes}
                onChange={(event) => updateDraft('notes', event.target.value)}
                className="min-h-52 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none transition focus:border-slate-500"
                placeholder="Record the prospect conversation, their words, and any important details."
              />
            </label>

            {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setSelectedStage((previous) => Math.max(1, previous - 1))} className="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100">Previous</button>
              <button type="button" onClick={saveCurrentStage} className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700">Save stage</button>
              <button type="button" onClick={() => setSelectedStage((previous) => Math.min(STAGES.length, previous + 1))} className="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100">Next</button>
            </div>
          </div>
        </section>

        <aside className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Call context</h3>
            <dl className="mt-3 space-y-3 text-sm text-slate-700">
              <div><dt className="text-slate-500">Contact</dt><dd className="font-medium text-slate-900">{call.contact_name ?? 'Not recorded'}</dd></div>
              <div><dt className="text-slate-500">Company</dt><dd className="font-medium text-slate-900">{call.company_name ?? 'Not recorded'}</dd></div>
              <div><dt className="text-slate-500">Purpose</dt><dd className="font-medium text-slate-900">{call.call_purpose ?? 'Not recorded'}</dd></div>
            </dl>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="block space-y-2 text-sm font-medium text-slate-700">
              <span>Final outcome</span>
              <select value={closeOutcome} onChange={(event) => setCloseOutcome(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
                <option value="follow_up_agreed">Follow-up agreed</option>
                <option value="meeting_agreed">Meeting agreed</option>
                <option value="information_requested">Information requested</option>
                <option value="not_interested">Not interested</option>
                <option value="wrong_person">Wrong person</option>
                <option value="no_contact_made">No contact made</option>
                <option value="no_clear_outcome">No clear outcome</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="mt-3 block space-y-2 text-sm font-medium text-slate-700">
              <span>Closing notes</span>
              <textarea value={closeNotes} onChange={(event) => setCloseNotes(event.target.value)} className="min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900" placeholder="Final notes or discrepancy" />
            </label>
            <button type="button" onClick={closeCurrentCall} disabled={closing} className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300">
              {closing ? 'Closing...' : 'Close call'}
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
