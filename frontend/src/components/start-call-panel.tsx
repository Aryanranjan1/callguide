'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCall } from '@/lib/api';
import { CobeGlobe } from '@/components/cobe-globe';

const initialForm = { contact_name: '', contact_role: '', company_name: '', call_purpose: '', initial_context: '' };
const requiredFields = ['contact_name', 'contact_role', 'company_name', 'call_purpose'] as const;
type RequiredField = typeof requiredFields[number];

export function StartCallPanel() {
  const router = useRouter();
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RequiredField, string>>>({});
  const prospectRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => prospectRef.current?.focus();
    window.addEventListener('callguide:focus-start-call', focus);
    return () => window.removeEventListener('callguide:focus-start-call', focus);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])) as typeof form;
    const nextErrors: Partial<Record<RequiredField, string>> = {};
    for (const field of requiredFields) {
      if (!trimmed[field]) nextErrors[field] = 'This field is required.';
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const firstInvalid = requiredFields.find((field) => nextErrors[field]);
      if (firstInvalid) document.getElementById(`start-${firstInvalid}`)?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const call = await createCall(trimmed);
      router.push(`/calls/${call.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to create call.');
      setSubmitting(false);
    }
  }

  return <aside className="cg-start-panel" aria-label="Start a call">
    <button className="cg-start-panel-button" type="button" onClick={() => prospectRef.current?.focus()}>☎ <span>Start call</span></button>
    <section className="cg-panel cg-start-form-panel">
      <header><h2>Start new call</h2><p>Capture the context you want to bring into the call.</p></header>
      <form className="cg-form cg-start-form" onSubmit={submit}>
        <label>Prospect name <span>Required</span><input id="start-contact_name" ref={prospectRef} aria-invalid={Boolean(fieldErrors.contact_name)} aria-describedby={fieldErrors.contact_name ? 'error-contact_name' : undefined} maxLength={255} value={form.contact_name} onChange={(event) => { setForm({ ...form, contact_name: event.target.value }); setFieldErrors((previous) => ({ ...previous, contact_name: undefined })); }} placeholder="Name" />{fieldErrors.contact_name ? <small id="error-contact_name" className="cg-field-error">{fieldErrors.contact_name}</small> : null}</label>
        <label>Role <span>Required</span><input id="start-contact_role" aria-invalid={Boolean(fieldErrors.contact_role)} aria-describedby={fieldErrors.contact_role ? 'error-contact_role' : undefined} maxLength={255} value={form.contact_role} onChange={(event) => { setForm({ ...form, contact_role: event.target.value }); setFieldErrors((previous) => ({ ...previous, contact_role: undefined })); }} placeholder="Job title" />{fieldErrors.contact_role ? <small id="error-contact_role" className="cg-field-error">{fieldErrors.contact_role}</small> : null}</label>
        <label>Company <span>Required</span><input id="start-company_name" aria-invalid={Boolean(fieldErrors.company_name)} aria-describedby={fieldErrors.company_name ? 'error-company_name' : undefined} maxLength={255} value={form.company_name} onChange={(event) => { setForm({ ...form, company_name: event.target.value }); setFieldErrors((previous) => ({ ...previous, company_name: undefined })); }} placeholder="Company" />{fieldErrors.company_name ? <small id="error-company_name" className="cg-field-error">{fieldErrors.company_name}</small> : null}</label>
        <label>Call purpose <span>Required</span><input id="start-call_purpose" aria-invalid={Boolean(fieldErrors.call_purpose)} aria-describedby={fieldErrors.call_purpose ? 'error-call_purpose' : undefined} maxLength={2000} value={form.call_purpose} onChange={(event) => { setForm({ ...form, call_purpose: event.target.value }); setFieldErrors((previous) => ({ ...previous, call_purpose: undefined })); }} placeholder="What do you hope to learn?" />{fieldErrors.call_purpose ? <small id="error-call_purpose" className="cg-field-error">{fieldErrors.call_purpose}</small> : null}</label>
        <label>Preparation notes <span>Optional · {form.initial_context.length}/4000</span><textarea maxLength={4000} rows={4} value={form.initial_context} onChange={(event) => setForm({ ...form, initial_context: event.target.value })} placeholder="Context, key points, or questions…" /></label>
        {error ? <p className="cg-alert" role="alert">{error}</p> : null}
        <button className="cg-primary-button cg-start-submit" type="submit" disabled={submitting}>{submitting ? 'Creating call…' : '☎  Start call'}</button>
      </form>
    </section>
    <div className="cg-globe-stage"><CobeGlobe /></div>
  </aside>;
}
