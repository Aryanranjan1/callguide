"use client";

import Link, { type LinkProps } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { loadSystemHealth } from '@/lib/api';
import type { SystemHealth } from '@/lib/types';
import { StartCallPanel } from '@/components/start-call-panel';

type NavigationGuard = () => Promise<boolean>;
type NavigationContextValue = {
  register: (guard: NavigationGuard) => () => void;
  beforeNavigate: () => Promise<boolean>;
};

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigationGuard(guard: NavigationGuard) {
  const navigation = useContext(NavigationContext);
  useEffect(() => navigation?.register(guard), [guard, navigation]);
}

export function GuardedLink({ href, onClick, ...props }: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: LinkProps['href'] }) {
  const navigation = useContext(NavigationContext);
  const router = useRouter();

  async function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(event.currentTarget.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    event.preventDefault();
    if (navigation && !(await navigation.beforeNavigate())) return;
    router.push(`${destination.pathname}${destination.search}${destination.hash}`);
  }

  return <Link href={href} {...props} onClick={handleClick} />;
}

function WorkspaceNav({ pathname }: { pathname: string }) {
  const active = pathname === '/';
  return <nav className="cg-nav" aria-label="Workspace">
    <GuardedLink href="/" aria-current={active ? 'page' : undefined} className={`cg-nav-link${active ? ' active' : ''}`}><span aria-hidden="true">◷</span> Call History</GuardedLink>
    {[
      ['↻', 'Callbacks'], ['▥', 'Dashboard'], ['♙', 'Prospects'], ['▦', 'Comparison'], ['✧', 'AI Usage'],
    ].map(([icon, label]) => <span className="cg-nav-link cg-nav-disabled" aria-disabled="true" key={label}><span className="cg-nav-icon" aria-hidden="true">{icon}</span><span className="cg-nav-name">{label}</span><small>Coming Soon</small></span>)}
  </nav>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthState, setHealthState] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [healthRetry, setHealthRetry] = useState(0);
  const [globalSearch, setGlobalSearch] = useState('');
  const guardRef = useRef<NavigationGuard | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const register = useCallback((guard: NavigationGuard) => {
    guardRef.current = guard;
    return () => { if (guardRef.current === guard) guardRef.current = null; };
  }, []);
  const beforeNavigate = useCallback(() => guardRef.current?.() ?? Promise.resolve(true), []);
  const navigation = useMemo(() => ({ register, beforeNavigate }), [register, beforeNavigate]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) searchRef.current?.blur();
    }
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSystemHealth(controller.signal).then((result) => {
      setHealth(result);
      setHealthState('available');
    }).catch(() => {
      if (!controller.signal.aborted) setHealthState('unavailable');
    });
    return () => controller.abort();
  }, [healthRetry]);

  const databaseLabel = health?.database === 'connected' ? 'Connected'
    : health?.database === 'local' ? 'Not used · local JSON'
      : health?.database === 'unavailable' ? 'Unavailable' : 'Unknown';

  return <NavigationContext.Provider value={navigation}><Suspense fallback={<div className="cg-shell"><div className="cg-page-column">{children}</div></div>}><ShellFrame pathnameFallback="/" globalSearch={globalSearch} setGlobalSearch={setGlobalSearch} searchRef={searchRef} router={router} health={health} healthState={healthState} databaseLabel={databaseLabel} onRetry={() => { setHealthState('checking'); setHealthRetry((value) => value + 1); }}>{children}</ShellFrame></Suspense></NavigationContext.Provider>;
}

function ShellFrame({ pathnameFallback, globalSearch, setGlobalSearch, searchRef, router, health, healthState, databaseLabel, onRetry, children }: {
  pathnameFallback: string;
  globalSearch: string;
  setGlobalSearch: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  router: ReturnType<typeof useRouter>;
  health: SystemHealth | null;
  healthState: 'checking' | 'available' | 'unavailable';
  databaseLabel: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || pathnameFallback;
  const isHistory = pathname === '/';
  useEffect(() => {
    const timer = window.setTimeout(() => setGlobalSearch(new URLSearchParams(window.location.search).get('q') ?? ''), 0);
    const syncSearch = (event: Event) => setGlobalSearch((event as CustomEvent<{ query?: string }>).detail?.query ?? '');
    window.addEventListener('callguide:search', syncSearch);
    return () => { window.clearTimeout(timer); window.removeEventListener('callguide:search', syncSearch); };
  }, [pathname, setGlobalSearch]);
  function search(value: string) {
    setGlobalSearch(value);
    if (isHistory) window.dispatchEvent(new CustomEvent('callguide:search', { detail: { query: value } }));
  }
  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = `/?q=${encodeURIComponent(globalSearch.trim())}`;
    if (!isHistory) router.push(target);
    else {
      window.dispatchEvent(new CustomEvent('callguide:search', { detail: { query: globalSearch.trim() } }));
      router.replace(target, { scroll: false });
    }
  }
  return <div className={`cg-shell${isHistory ? ' cg-shell-history' : ''}`}>
    <aside className="cg-sidebar" aria-label="Main navigation">
      <GuardedLink href="/" className="cg-brand" aria-label="CallGuide home"><span>CALL</span><strong>GUIDE</strong><small>OUTBOUND WORKSPACE</small></GuardedLink>
      <WorkspaceNav pathname={pathname} />
      <section className="cg-sidebar-footer" aria-label="System status">
        <h2><span className={`cg-status-mark ${healthState}`} aria-hidden="true" /> System status</h2>
        <p><span>API</span><strong className={healthState === 'available' ? 'is-healthy' : healthState === 'unavailable' ? 'is-unavailable' : ''}>{healthState === 'checking' ? 'Checking' : healthState === 'available' ? 'Connected' : 'Unavailable'}</strong></p>
        <p><span>Database</span><strong className={health?.database === 'connected' || health?.database === 'local' ? 'is-healthy' : health?.database === 'unavailable' ? 'is-unavailable' : ''}>{databaseLabel}</strong></p>
        <p><span>OpenRouter</span><strong className={health?.openrouter === 'configured' ? 'is-healthy' : ''}>{health?.openrouter === 'configured' ? 'Configured · checked on use' : health?.openrouter === 'not_configured' ? 'Not configured' : 'Unknown'}</strong></p>
        {healthState === 'unavailable' ? <button type="button" className="cg-health-retry" onClick={onRetry}>Retry status</button> : null}
      </section>
    </aside>
    <div className="cg-page-column">
      <header className="cg-topbar">
        <GuardedLink href="/" className="cg-topbar-brand"><span>CALL</span><strong>GUIDE</strong></GuardedLink>
        <form className="cg-global-search" role="search" onSubmit={submitSearch}><label htmlFor="global-call-search">⌕</label><input id="global-call-search" ref={searchRef} value={globalSearch} onChange={(event) => search(event.target.value)} placeholder="Search prospects, companies, or calls…" /><button type="submit" className="cg-key-hint" aria-label="Search calls">Ctrl K</button></form>
        {!isHistory ? <GuardedLink className="cg-topbar-history" href="/">Call History</GuardedLink> : null}
      </header>
      <div className="cg-content">{children}</div>
    </div>
    {isHistory ? <StartCallPanel /> : null}
  </div>;
}
