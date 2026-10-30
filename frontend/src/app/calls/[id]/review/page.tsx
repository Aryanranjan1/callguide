'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { apiRequest, generateSummary } from '@/lib/api';
import { STAGES } from '@/lib/stages';
import type { CallDetail, CallSummary } from '@/lib/types';

export default function ReviewPage() {
  return (
    <Suspense fallback={<main className="p-8 text-slate-700">Loading review...</main>}>
      <ReviewPageContent />
    </Suspense>
  );
}

function ReviewPageContent() {
  const params = useParams<{ id: string }>();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCall = async () => {
    try {
      setLoading(true);
      const result = await apiRequest<CallDetail>(`/calls/${params.id}`);
      setCall(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load call.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (params.id) {
      loadCall();
    }
  }, [params.id]);

  const generateSummaryForCall = async () => {
    try {
      setSummaryLoading(true);
      const response = await generateSummary(params.id);
      if (call) {
        setCall({ ...call, summary: { ...response, created_at: new Date().toISOString() } as CallSummary });
      }
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : 'Unable to generate summary.');
    } finally {
      setSummaryLoading(false);
    }
  };

  if (loading) {
    return <main className="p-8 text-slate-700">Loading call review...</main>;
  }

  if (error || !call) {
    return <main className="p-8 text-red-700">{error ?? 'Call not found.'}</main>;
  }

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Completed call</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">{call.company_name ?? 'Call'} review</h1>
        </div>
        <div className="flex gap-3">
          <button onClick={generateSummaryForCall} disabled={summaryLoading} className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400">
            {summaryLoading ? 'Generating...' : call.summary ? 'Regenerate summary' : 'Generate summary'}
          </button>
          <Link href="/" className="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100">Back to history</Link>
        </div>
      </div>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <h2 className="mb-4 text-xl font-semibold text-slate-900">Call details</h2>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div><dt className="text-sm text-slate-500">Contact</dt><dd className="mt-1 font-medium text-slate-900">{call.contact_name ?? 'Not recorded'}</dd></div>
            <div><dt className="text-sm text-slate-500">Company</dt><dd className="mt-1 font-medium text-slate-900">{call.company_name ?? 'Not recorded'}</dd></div>
            <div><dt className="text-sm text-slate-500">Status</dt><dd className="mt-1 font-medium text-slate-900">{call.status}</dd></div>
            <div><dt className="text-sm text-slate-500">Final outcome</dt><dd className="mt-1 font-medium text-slate-900">{call.final_outcome ?? 'Not recorded'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-sm text-slate-500">Final notes</dt><dd className="mt-1 whitespace-pre-wrap text-slate-700">{call.final_notes ?? 'Not recorded'}</dd></div>
          </dl>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-900">AI summary</h2>
          {call.summary ? (
            <div className="space-y-3">
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-600">AI-generated summary</p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{call.summary.summary_text}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-600">No summary has been generated for this call yet.</p>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Eight-stage summary</h2>
        {STAGES.map((stage) => {
          const result = call.stageResults.find((item) => item.stage_number === stage.number);
          return (
            <div key={stage.number} className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-500">Stage {stage.number}</p>
                  <h3 className="text-lg font-semibold text-slate-900">{stage.title}</h3>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{result?.stage_status ?? 'not_started'}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{result?.notes ?? 'No notes recorded for this stage.'}</p>
            </div>
          );
        })}
      </section>
    </main>
  );
}
