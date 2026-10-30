'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCall } from '@/lib/api';

export default function NewCallPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    contact_name: '',
    company_name: '',
    contact_role: '',
    call_purpose: '',
    initial_context: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const call = await createCall(form);
      router.push(`/calls/${call.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to create call.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">New call</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">Call setup</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-5 md:grid-cols-2">
          <label className="space-y-2 text-sm font-medium text-slate-700">
            <span>Prospect/contact name</span>
            <input value={form.contact_name} onChange={(event) => handleChange('contact_name', event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-0 transition focus:border-slate-500" placeholder="Optional" />
          </label>
          <label className="space-y-2 text-sm font-medium text-slate-700">
            <span>Company name</span>
            <input value={form.company_name} onChange={(event) => handleChange('company_name', event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-0 transition focus:border-slate-500" placeholder="Optional" />
          </label>
          <label className="space-y-2 text-sm font-medium text-slate-700">
            <span>Role or designation</span>
            <input value={form.contact_role} onChange={(event) => handleChange('contact_role', event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-0 transition focus:border-slate-500" placeholder="Optional" />
          </label>
          <label className="space-y-2 text-sm font-medium text-slate-700">
            <span>Call purpose</span>
            <input value={form.call_purpose} onChange={(event) => handleChange('call_purpose', event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-0 transition focus:border-slate-500" placeholder="Optional" />
          </label>
        </div>

        <label className="block space-y-2 text-sm font-medium text-slate-700">
          <span>Initial context or preparation notes</span>
          <textarea value={form.initial_context} onChange={(event) => handleChange('initial_context', event.target.value)} className="min-h-32 w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none transition focus:border-slate-500" placeholder="Optional notes before the conversation begins" />
        </label>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => router.push('/')} className="rounded-xl border border-slate-300 px-4 py-2 font-medium text-slate-700 transition hover:bg-slate-100">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="rounded-xl bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400">
            {isSubmitting ? 'Creating...' : 'Create call'}
          </button>
        </div>
      </form>
    </main>
  );
}
