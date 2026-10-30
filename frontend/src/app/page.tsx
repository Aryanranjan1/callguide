'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listCalls } from '@/lib/api';
import type { Call } from '@/lib/types';

export default function HomePage() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCalls() {
      try {
        const data = await listCalls();
        setCalls(data);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load call history.');
      } finally {
        setLoading(false);
      }
    }

    loadCalls();
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">CallGuide</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">Call history</h1>
        </div>
        <Link href="/calls/new" className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700">Start new call</Link>
      </header>

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-700">Loading previous calls...</div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700">{error}</div>
      ) : calls.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">No calls yet</h2>
          <p className="mt-2 text-slate-600">Create your first call to begin a structured conversation.</p>
          <Link href="/calls/new" className="mt-4 inline-flex rounded-xl bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700">Create a call</Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {calls.map((call) => (
            <Link key={call.id} href={call.status === 'completed' ? `/calls/${call.id}/review` : `/calls/${call.id}`} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">{call.status === 'completed' ? 'Completed' : 'In progress'}</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-900">{call.contact_name ?? 'Unnamed prospect'}</h2>
                  <p className="text-sm text-slate-600">{call.company_name ?? 'Company not recorded'}</p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-600">
                  {call.final_outcome ?? 'No outcome yet'}
                </div>
              </div>
              <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                <div><span className="font-medium text-slate-500">Created</span><div>{new Date(call.created_at).toLocaleString()}</div></div>
                <div><span className="font-medium text-slate-500">Status</span><div>{call.status}</div></div>
                <div><span className="font-medium text-slate-500">Purpose</span><div>{call.call_purpose ?? 'Not recorded'}</div></div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
