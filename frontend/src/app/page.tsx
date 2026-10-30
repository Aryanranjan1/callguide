'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { listCallsPage, listUpcomingCallbacks, loadCallAnalytics } from '@/lib/api';
import type { Call, CallAnalytics, CallListFilters } from '@/lib/types';

const outcomeLabels: Record<string, string> = {
  next_step_agreed: 'Next step agreed', agreed_to_receive_report: 'Agreed to receive report', interested: 'Interested',
  follow_up: 'Follow-up', call_again: 'Call again', not_interested: 'Not interested', do_not_call: 'Do not call', wrong_person: 'Wrong person', moved_company: 'Moved company',
  follow_up_agreed: 'Follow-up (legacy)', meeting_agreed: 'Meeting agreed (legacy)', information_requested: 'Information requested (legacy)', no_contact_made: 'No contact made (legacy)', no_clear_outcome: 'No clear outcome (legacy)', other: 'Other (legacy)',
};
const outcomeOptions = Object.entries(outcomeLabels);
const outcomeChartColors = ['#0866ff', '#277bff', '#9bb8e9', '#668bc9', '#3d6eae'];

export default function HomePage() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [callbacks, setCallbacks] = useState<Call[]>([]);
  const [callbackPage, setCallbackPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [callbacksLoading, setCallbacksLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'in_progress' | 'completed'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [refreshKey, setRefreshKey] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageHistory, setPageHistory] = useState<Array<{ calls: Call[]; nextCursor: string | null; hasMore: boolean; pageCount: number }>>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [analytics, setAnalytics] = useState<CallAnalytics | null>(null);
  const [analyticsLoadedPeriod, setAnalyticsLoadedPeriod] = useState<string | null>(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState<'daily' | 'weekly'>('daily');
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsRetry, setAnalyticsRetry] = useState(0);
  const [clientNow, setClientNow] = useState<number | null>(null);
  const requestEpoch = useRef(0);
  const requests = useRef<AbortController | null>(null);
  const filters: CallListFilters = { query, status: statusFilter, outcome: outcomeFilter, dateFrom, dateTo, sort: sortOrder };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const initial = new URLSearchParams(window.location.search).get('q');
      if (initial !== null) setQuery(initial);
    }, 0);
    const handleGlobalSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      const nextQuery = detail?.query ?? '';
      resetResultsForFilterChange();
      setQuery(nextQuery);
    };
    window.addEventListener('callguide:search', handleGlobalSearch);
    return () => { window.clearTimeout(timer); window.removeEventListener('callguide:search', handleGlobalSearch); };
  }, []);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    requests.current?.abort();
    const controller = new AbortController();
    const activeFilters: CallListFilters = { query, status: statusFilter, outcome: outcomeFilter, dateFrom, dateTo, sort: sortOrder };
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setCalls([]);
      setNextCursor(null);
      setHasMore(false);
      setPageCount(0);
      setPageHistory([]);
      setPageIndex(0);
      requests.current = controller;
      void listCallsPage(activeFilters, null, controller.signal).then((page) => {
        if (requestEpoch.current !== epoch) return;
        setCalls(page.calls);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setPageCount(page.pageCount);
        setPageHistory([page]);
      }).catch((loadError: unknown) => {
        if (requestEpoch.current === epoch && !(loadError instanceof DOMException && loadError.name === 'AbortError')) setError(loadError instanceof Error ? loadError.message : 'Unable to load call history.');
      }).finally(() => {
        if (requestEpoch.current === epoch) setLoading(false);
      });
    }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (requestEpoch.current === epoch) requestEpoch.current += 1;
    };
  // The explicit fields ensure any filter change resets the cursor and replaces the result set.
  }, [query, statusFilter, outcomeFilter, dateFrom, dateTo, sortOrder, refreshKey]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCallbacksLoading(true);
      setCallbackError(null);
    }, 0);
    listUpcomingCallbacks(controller.signal).then((data) => { if (active) { setCallbacks(data); setCallbackPage(0); } })
      .catch((loadError: unknown) => { if (active) setCallbackError(loadError instanceof Error ? loadError.message : 'Unable to load callback reminders.'); })
      .finally(() => { if (active) setCallbacksLoading(false); });
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [refreshKey]);

  const analyticsRequestKey = `${analyticsPeriod}:${dateFrom}:${dateTo}`;
  useEffect(() => {
    const controller = new AbortController();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    loadCallAnalytics(analyticsPeriod, timezone, dateFrom, dateTo, controller.signal).then((data) => { setAnalytics(data); setAnalyticsLoadedPeriod(analyticsRequestKey); setAnalyticsError(null); })
      .catch((loadError: unknown) => { if (!controller.signal.aborted) setAnalyticsError(loadError instanceof Error ? loadError.message : 'Unable to load call analytics.'); });
    return () => controller.abort();
  }, [analyticsPeriod, analyticsRetry, dateFrom, dateTo, analyticsRequestKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setClientNow(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function navigateCalls(direction: 'next' | 'previous') {
    if (loadingMore || (direction === 'next' && !nextCursor) || (direction === 'previous' && pageIndex === 0)) return;
    if (direction === 'previous') {
      const previousPage = pageHistory[pageIndex - 1];
      if (!previousPage) return;
      setCalls(previousPage.calls);
      setNextCursor(previousPage.nextCursor);
      setHasMore(previousPage.hasMore);
      setPageCount(previousPage.pageCount);
      setPageIndex((index) => index - 1);
      return;
    }
    const epoch = requestEpoch.current;
    setLoadingMore(true);
    setError(null);
    try {
      const controller = new AbortController();
      requests.current?.abort();
      requests.current = controller;
      const targetIndex = direction === 'next' ? pageIndex + 1 : pageIndex - 1;
      const cursor = nextCursor;
      const page = await listCallsPage(filters, cursor, controller.signal);
      if (requestEpoch.current !== epoch) return;
      setCalls(page.calls);
      setTotalCount(page.totalCount);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setPageCount(page.pageCount);
      setPageIndex(targetIndex);
      setPageHistory((previous) => [...previous.slice(0, targetIndex), page]);
    } catch (loadError) {
      if (requestEpoch.current === epoch) setError(loadError instanceof Error ? loadError.message : 'Unable to load more calls.');
    } finally {
      if (requestEpoch.current === epoch) setLoadingMore(false);
    }
  }

  const refreshCalls = useCallback(() => setRefreshKey((value) => value + 1), []);

  function resetResultsForFilterChange() {
    setLoading(true); setCalls([]); setTotalCount(0); setPageCount(0); setNextCursor(null); setHasMore(false); setPageHistory([]); setPageIndex(0);
  }

  const filteredCalls = calls;

  function focusStartCall() { window.dispatchEvent(new Event('callguide:focus-start-call')); }

  const hasActiveFilter = Boolean(query.trim() || statusFilter !== 'all' || outcomeFilter !== 'all' || dateFrom || dateTo);
  const highestCallBucket = Math.max(0, ...(analytics?.buckets.map((bucket) => bucket.count) ?? [0]));
  const chartStep = Math.max(1, Math.ceil(highestCallBucket / 4));
  const chartTicks = Array.from({ length: 5 }, (_, index) => (4 - index) * chartStep);
  const callbackPageSize = 5;
  const callbackPageCount = Math.ceil(callbacks.length / callbackPageSize);
  const visibleCallbacks = callbacks.slice(callbackPage * callbackPageSize, (callbackPage + 1) * callbackPageSize);

  return (
    <main className="cg-history-main">
      <p className="cg-crumb"><b aria-hidden="true">▣</b> WORKSPACE / OUTBOUND OPERATIONS</p>
      <header className="cg-page-heading">
        <div><h1>Call History</h1><p className="cg-subtitle">Track conversations, manage follow-ups, and pick up where you left off.</p></div>
        <fieldset className="cg-date-range"><legend>Date range</legend><label>From<input aria-label="Calls starting on or after" type="date" value={dateFrom} onChange={(event) => { const nextDate = event.target.value; resetResultsForFilterChange(); setDateFrom(nextDate); if (dateTo && nextDate > dateTo) setDateTo(''); }} /></label><span>to</span><label>To<input aria-label="Calls starting on or before" type="date" min={dateFrom || undefined} value={dateTo} onChange={(event) => { resetResultsForFilterChange(); setDateTo(event.target.value); }} /></label></fieldset>
      </header>

      <section className="cg-history-stats" aria-label="Call metrics">
        {([['TOTAL CALLS', analytics?.total], ['COMPLETED', analytics?.completed], ['IN PROGRESS', analytics?.in_progress], ['FOLLOW-UPS', analytics?.follow_ups]] as const).map(([label, value]) => <article className="cg-history-stat" key={label}><small>{label}</small><strong>{value ?? '—'}</strong><span>{dateFrom || dateTo ? 'Selected date range' : analyticsPeriod === 'daily' ? 'Last 7 days' : 'Last 8 weeks'}</span></article>)}
      </section>
      <section className="cg-history-analytics" aria-label="Call analytics">
        <article className="cg-panel cg-history-chart"><div className="cg-panel-header"><h2>Call volume</h2><select className="cg-select" aria-label="Call volume interval" value={analyticsPeriod} onChange={(event) => { setAnalyticsError(null); setAnalyticsPeriod(event.target.value as 'daily' | 'weekly'); }}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>{analyticsError ? <p className="cg-alert" role="alert">{analyticsError} <button type="button" className="cg-health-retry" onClick={() => setAnalyticsRetry((value) => value + 1)}>Retry</button></p> : !analytics || analyticsLoadedPeriod !== analyticsRequestKey ? <p className="cg-empty" role="status">Loading call analytics…</p> : analytics.total === 0 ? <p className="cg-empty" role="status">No calls in this period.</p> : <div className="cg-bar-chart" role="img" aria-label={`Call volume by ${analyticsPeriod === 'daily' ? 'day' : 'week'}`}><div className="cg-chart-y-axis" aria-hidden="true">{chartTicks.map((tick) => <span key={tick}>{tick}</span>)}</div><div className="cg-chart-main"><div className="cg-chart-plot">{analytics.buckets.map((bucket) => { const barHeight = highestCallBucket > 0 ? bucket.count / (chartStep * 4) * 100 : 0; return <div className="cg-bar-column" key={bucket.start} title={`${bucket.label}: ${bucket.count}`}><span style={{ '--bar-height': `${barHeight}%` } as CSSProperties}>{bucket.count}</span><i style={{ height: `${barHeight}%` }} /></div>; })}</div><div className="cg-chart-labels" aria-hidden="true">{analytics.buckets.map((bucket) => <small key={bucket.start} title={bucket.label}>{bucket.label}</small>)}</div></div></div>}</article>
        <article className="cg-panel cg-history-chart"><div className="cg-panel-header"><h2>Outcome distribution</h2><span className="cg-muted">Completed calls · {analytics?.completed ?? '—'}</span></div>{analyticsError ? <p className="cg-alert" role="alert">{analyticsError} <button type="button" className="cg-health-retry" onClick={() => setAnalyticsRetry((value) => value + 1)}>Retry</button></p> : !analytics || analyticsLoadedPeriod !== analyticsRequestKey ? <p className="cg-empty" role="status">Loading outcome data…</p> : analytics.outcomes.length ? <div className="cg-outcome-chart"><div className="cg-donut" role="img" aria-label={`Completed calls by outcome: ${analytics.outcomes.map((item) => `${outcomeLabels[item.outcome] ?? (item.outcome === 'unrecorded' ? 'Outcome not recorded' : item.outcome)}, ${item.count}`).join('; ')}`} style={{ background: `conic-gradient(${analytics.outcomes.reduce((state, item, index) => { const share = analytics.completed ? item.count / analytics.completed * 100 : 0; state.parts.push(`${outcomeChartColors[index % outcomeChartColors.length]} ${state.position}% ${state.position + share}%`); state.position += share; return state; }, { position: 0, parts: [] as string[] }).parts.join(',')})` }}><strong aria-hidden="true">{analytics.completed}<small>completed</small></strong></div><ul>{analytics.outcomes.map((item, index) => <li key={item.outcome}><i style={{ backgroundColor: outcomeChartColors[index % outcomeChartColors.length] }} />{outcomeLabels[item.outcome] ?? (item.outcome === 'unrecorded' ? 'Outcome not recorded' : item.outcome)}<span>{item.count} · {analytics.completed ? Math.round(item.count / analytics.completed * 100) : 0}%</span></li>)}</ul></div> : <p className="cg-empty">No completed calls in this period.</p>}</article>
      </section>

      <section className="cg-panel cg-callback-strip" aria-labelledby="callback-heading"><div className="cg-panel-header"><div><h2 id="callback-heading">CALLBACK QUEUE</h2><span className="cg-muted">All scheduled callbacks · {callbacksLoading ? '—' : callbacks.length}</span></div></div>{callbackError ? <div role="alert" className="cg-alert">{callbackError}<button type="button" className="cg-health-retry" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div> : callbacksLoading ? <p className="cg-empty" role="status">Loading callback reminders…</p> : callbacks.length ? <><div className="cg-table-scroll"><table className="cg-data-table cg-callback-table"><thead><tr><th scope="col">Prospect</th><th scope="col">Company</th><th scope="col">Callback time</th><th scope="col">Outcome</th><th scope="col">Action</th></tr></thead><tbody>{visibleCallbacks.map((call) => { const overdue = clientNow !== null && Date.parse(call.callback_at!) < clientNow; const dueToday = clientNow !== null && new Date(call.callback_at!).toDateString() === new Date(clientNow).toDateString(); const href = call.status === 'completed' ? `/calls/${call.id}/review` : `/calls/${call.id}`; return <tr key={call.id}><td><Link className="cg-table-person" href={href}>{call.contact_name || 'Unnamed prospect'}</Link></td><td>{call.company_name || 'Company not recorded'}</td><td><time className={overdue ? 'overdue' : dueToday ? 'due-today' : ''} dateTime={call.callback_at!}>{new Date(call.callback_at!).toLocaleString()} <span className={`cg-time-badge ${overdue ? 'overdue' : dueToday ? 'due-today' : 'upcoming'}`}>{overdue ? 'Overdue' : dueToday ? 'Due today' : 'Upcoming'}</span></time></td><td>{outcomeLabels[call.final_outcome ?? ''] ?? 'No outcome recorded'}</td><td><Link className="cg-outline-button" href={href}>{call.status === 'completed' ? 'Review' : 'Resume'}</Link></td></tr>; })}</tbody></table></div>{callbackPageCount > 1 ? <nav className="cg-pagination cg-callback-pagination" aria-label="Callback queue pages"><span className="cg-muted">Showing {callbackPage * callbackPageSize + 1}–{Math.min((callbackPage + 1) * callbackPageSize, callbacks.length)} of {callbacks.length} callbacks · Page {callbackPage + 1}</span><div><button type="button" className="cg-quiet-button" onClick={() => setCallbackPage((page) => Math.max(0, page - 1))} disabled={callbackPage === 0}>← Previous</button><button type="button" className="cg-quiet-button" onClick={() => setCallbackPage((page) => Math.min(callbackPageCount - 1, page + 1))} disabled={callbackPage >= callbackPageCount - 1}>Next →</button></div></nav> : null}</> : <p className="cg-empty">No callbacks are scheduled.</p>}</section>

      <section className="cg-panel mt-6">
        <div className="cg-panel-header"><div><h2>All conversations</h2><span className="cg-muted">{loading ? 'Loading records…' : `${totalCount} matching records`}</span></div><button type="button" className="cg-quiet-button" onClick={refreshCalls} disabled={loading}>Refresh</button></div>
        <div className="cg-toolbar cg-history-filters">
          <label className="cg-search"><span aria-hidden="true">⌕</span><input aria-label="Search calls" value={query} onChange={(event) => { const value = event.target.value; resetResultsForFilterChange(); setQuery(value); window.dispatchEvent(new CustomEvent('callguide:search', { detail: { query: value } })); }} placeholder="Search prospect or company…" /></label>
          <select id="call-status" aria-label="Filter by status" className="cg-select" value={statusFilter} onChange={(event) => { resetResultsForFilterChange(); setStatusFilter(event.target.value as typeof statusFilter); }}><option value="all">All statuses</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select>
          <select aria-label="Filter by outcome" className="cg-select" value={outcomeFilter} onChange={(event) => { resetResultsForFilterChange(); setOutcomeFilter(event.target.value); }}><option value="all">All outcomes</option>{outcomeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Sort calls" className="cg-select" value={sortOrder} onChange={(event) => { resetResultsForFilterChange(); setSortOrder(event.target.value as typeof sortOrder); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        </div>
        {error ? <div role="alert" className="cg-alert"><span>{error}</span><button className="cg-quiet-button" type="button" onClick={() => void refreshCalls()}>Try again</button></div> : null}
        {loading ? <div className="cg-empty" role="status">Loading call history…</div> : !error && filteredCalls.length === 0 ? (
          <div className="cg-empty"><h3>{hasActiveFilter ? 'No matching conversations' : 'No calls yet'}</h3><p>{hasActiveFilter ? 'Try another search or filter.' : 'Start your first call to create a structured conversation record.'}</p>{hasActiveFilter ? null : <button type="button" className="cg-primary-button mt-4" onClick={focusStartCall}>Create a call</button>}</div>
        ) : !error ? (
          <div className="cg-table-scroll"><table className="cg-data-table cg-conversations-table"><thead><tr><th scope="col">Prospect</th><th scope="col">Company</th><th scope="col">Reached stage</th><th scope="col">Last activity</th><th scope="col">Outcome</th><th scope="col">Action</th></tr></thead><tbody>
            {filteredCalls.map((call) => {
              const href = call.status === 'completed' ? `/calls/${call.id}/review` : `/calls/${call.id}`;
              const reached = new Set(call.reached_stages ?? []);
              const outcome = outcomeLabels[call.final_outcome ?? ''] ?? (call.status === 'completed' ? 'Outcome not recorded' : 'In progress');
              const outcomeTone = call.status === 'in_progress' ? 'progress' : ['next_step_agreed', 'agreed_to_receive_report', 'interested'].includes(call.final_outcome ?? '') ? 'positive' : ['follow_up', 'call_again'].includes(call.final_outcome ?? '') ? 'follow' : ['not_interested', 'do_not_call'].includes(call.final_outcome ?? '') ? 'negative' : 'neutral';
              return <tr key={call.id}>
                <td><Link className="cg-table-person" href={href}>{call.contact_name || 'Unnamed prospect'}{call.contact_role ? <small>{call.contact_role}</small> : null}</Link></td>
                <td>{call.company_name || <span className="cg-unrecorded">Company not recorded</span>}</td>
                <td><span className="cg-stage-indicator" aria-label={`${reached.size} of 8 stages recorded`}><strong>{reached.size}/8</strong>{Array.from({ length: 8 }, (_, index) => <i key={index} className={reached.has(index + 1) ? 'reached' : ''} />)}</span></td>
                <td><time dateTime={call.updated_at}>{new Date(call.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></td>
                <td><span className={`cg-outcome-tag ${outcomeTone}`}>{outcome}</span></td>
                <td><Link className="cg-outline-button" href={href}>{call.status === 'completed' ? 'Review' : 'Resume'}</Link></td>
              </tr>;
            })}
          </tbody></table></div>
        ) : null}
        {totalCount > 0 ? <nav className="cg-pagination" aria-label="Call history pages"><span className="cg-muted">Showing {pageIndex * 10 + 1}–{pageIndex * 10 + pageCount} of {totalCount} conversations · Page {pageIndex + 1}</span><div><button type="button" className="cg-quiet-button" onClick={() => void navigateCalls('previous')} disabled={pageIndex === 0 || loadingMore}>← Previous</button><button type="button" className="cg-quiet-button" onClick={() => void navigateCalls('next')} disabled={!hasMore || loadingMore}>{loadingMore ? 'Loading…' : 'Next →'}</button></div></nav> : null}
      </section>
    </main>
  );
}
