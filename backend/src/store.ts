import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Call, CallStageResult, CallSummary, StageQuestion, StageStatus } from './types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'calls.json');

interface PersistedState {
  calls: Call[];
  stageResults: CallStageResult[];
  summaries: CallSummary[];
}

const defaultState: PersistedState = { calls: [], stageResults: [], summaries: [] };
let pool: Pool | null = null;
let mode: 'postgres' | 'local-json' | null = null;
let localMutationQueue: Promise<void> = Promise.resolve();
const localSummaryLocks = new Map<string, Promise<void>>();

export interface CallListFilters {
  query?: string;
  status?: 'in_progress' | 'completed';
  outcome?: string;
  startedAfter?: string;
  startedBefore?: string;
  sort?: 'newest' | 'oldest';
}

export interface CallListCursor {
  createdAt: string;
  id: string;
  filterKey: string;
  snapshotCreatedAt: string;
  snapshotId: string;
  sort: 'newest' | 'oldest';
}

export interface CallListPage {
  calls: Call[];
  nextCursor: CallListCursor | null;
  totalCount: number;
}

export class InvalidCallCursorError extends Error {
  constructor() {
    super('Call list cursor does not match the current filters.');
    this.name = 'InvalidCallCursorError';
  }
}

interface LocalMutationResult<T> {
  result: T;
  persist: boolean;
}

export class CallAlreadyCompletedError extends Error {
  constructor() {
    super('Call is already completed.');
    this.name = 'CallAlreadyCompletedError';
  }
}

function configureStore() {
  if (mode) return;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const connectionUrl = new URL(databaseUrl);
    // SSL is configured below so libpq-style URL flags cannot weaken or replace it.
    for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connectionUrl.searchParams.delete(option);
    const ca = process.env.DATABASE_SSL_CA?.replaceAll('\\n', '\n').trim();
    if (ca && (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----'))) {
      throw new Error('DATABASE_SSL_CA must contain a PEM encoded CA certificate.');
    }
    if (ca) {
      try { new X509Certificate(ca); }
      catch { throw new Error('DATABASE_SSL_CA is not a valid PEM certificate.'); }
    }
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(connectionUrl.hostname);
    const localDevelopment = process.env.NODE_ENV !== 'production' && localHost && !ca;
    pool = new Pool({
      connectionString: connectionUrl.toString(),
      ssl: localDevelopment ? false : { ...(ca ? { ca } : {}), rejectUnauthorized: true },
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    mode = 'postgres';
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production. Configure the Supabase PostgreSQL connection string.');
  }

  mode = 'local-json';
}

export function getPersistenceMode() {
  configureStore();
  return mode!;
}

function getPool() {
  configureStore();
  if (!pool) throw new Error('PostgreSQL pool is not configured.');
  return pool;
}

export async function initializeStore() {
  configureStore();
  if (pool) await pool.query('SELECT 1');
}

export async function getStoreHealth(): Promise<'connected' | 'unavailable' | 'local'> {
  if (getPersistenceMode() !== 'postgres') return 'local';
  try {
    await getPool().query('SELECT 1');
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

export async function closeStore() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function ensureFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await open(DATA_FILE, 'r').then((handle) => handle.close());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const handle = await open(DATA_FILE, 'wx');
      await handle.writeFile(JSON.stringify(defaultState, null, 2), 'utf-8');
      await handle.close();
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
    }
  }
}

export class LocalDataCorruptionError extends Error {
  constructor() {
    super(`Local data file is invalid JSON or has an invalid shape; preserve and repair ${DATA_FILE} before continuing.`);
    this.name = 'LocalDataCorruptionError';
  }
}

async function readState(): Promise<PersistedState> {
  await ensureFile();
  const content = await readFile(DATA_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(content) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.calls) || !Array.isArray(parsed.stageResults) || !Array.isArray(parsed.summaries)) throw new Error('invalid shape');
    return {
      calls: parsed.calls,
      stageResults: parsed.stageResults,
      summaries: parsed.summaries,
    };
  } catch {
    throw new LocalDataCorruptionError();
  }
}

async function writeState(state: PersistedState) {
  await ensureFile();
  const temporaryFile = `${DATA_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state, null, 2), { encoding: 'utf-8', flag: 'wx' });
  await rename(temporaryFile, DATA_FILE);
}

function mutateLocalState<T>(mutate: (state: PersistedState) => LocalMutationResult<T> | Promise<LocalMutationResult<T>>): Promise<T> {
  const operation = localMutationQueue.then(async () => {
    const state = await readState();
    const mutation = await mutate(state);
    if (mutation.persist) await writeState(state);
    return mutation.result;
  });

  // Keep the queue usable after a failed read, mutation, or write while returning
  // the original rejection to the operation's caller.
  localMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function inTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function inReadSnapshot<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listCalls(limit = 100): Promise<Call[]> {
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>(`SELECT c.id, c.contact_name, c.company_name, c.contact_role,
      c.status, c.final_outcome, c.callback_at, c.started_at, c.completed_at, c.created_at, c.updated_at,
      COUNT(s.id)::int AS stage_count, ARRAY_REMOVE(ARRAY_AGG(s.stage_number ORDER BY s.stage_number), NULL) AS reached_stages,
      (SELECT LEFT(sm.summary_text, 180) FROM call_summaries sm WHERE sm.call_id = c.id ORDER BY sm.created_at DESC LIMIT 1) AS summary_preview
      FROM calls c LEFT JOIN call_stage_results s ON s.call_id = c.id
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }
  const state = await readState();
  return [...state.calls]
    .map((call) => {
      const latestSummary = [...state.summaries].filter((summary) => summary.call_id === call.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.summary_text;
      return {
        ...call,
        stage_count: state.stageResults.filter((result) => result.call_id === call.id).length,
        reached_stages: state.stageResults.filter((result) => result.call_id === call.id).map((result) => result.stage_number).sort((a, b) => a - b),
        ...(latestSummary === undefined ? {} : { summary_preview: latestSummary.slice(0, 180) }),
      };
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
    .map(({ initial_context: _initialContext, final_notes: _finalNotes, call_purpose: _callPurpose, do_not_call_confirmed: _doNotCallConfirmed, ...call }) => call as unknown as Call);
}

function compareCallTuple(left: { created_at: string; id: string }, right: { created_at: string; id: string }) {
  const dateDifference = Date.parse(left.created_at) - Date.parse(right.created_at);
  return dateDifference || left.id.localeCompare(right.id);
}

function matchesCallFilters(call: Call, filters: CallListFilters) {
  const query = filters.query?.trim().toLocaleLowerCase();
  return (!query || `${call.contact_name ?? ''} ${call.company_name ?? ''} ${call.contact_role ?? ''}`.toLocaleLowerCase().includes(query))
    && (!filters.status || call.status === filters.status)
    && (!filters.outcome || call.final_outcome === filters.outcome)
    && (!filters.startedAfter || Date.parse(call.started_at) >= Date.parse(filters.startedAfter))
    && (!filters.startedBefore || Date.parse(call.started_at) < Date.parse(filters.startedBefore));
}

function callListFilterKey(filters: CallListFilters) {
  return createHash('sha256').update(JSON.stringify({
    query: filters.query?.trim() ?? '', status: filters.status ?? '', outcome: filters.outcome ?? '',
    startedAfter: filters.startedAfter ?? '', startedBefore: filters.startedBefore ?? '', sort: filters.sort ?? 'newest',
  })).digest('hex');
}

export async function listCallsPage(limit: number, filters: CallListFilters, cursor?: CallListCursor): Promise<CallListPage> {
  const sort = filters.sort ?? 'newest';
  const filterKey = callListFilterKey(filters);
  if (cursor && cursor.filterKey !== filterKey) throw new InvalidCallCursorError();
  if (getPersistenceMode() === 'postgres') {
    const values: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.query?.trim()) {
      const query = `%${filters.query.trim().replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
      const parameter = bind(query);
      where.push(`(c.contact_name ILIKE ${parameter} ESCAPE '!' OR c.company_name ILIKE ${parameter} ESCAPE '!' OR c.contact_role ILIKE ${parameter} ESCAPE '!')`);
    }
    if (filters.status) where.push(`c.status = ${bind(filters.status)}`);
    if (filters.outcome) where.push(`c.final_outcome = ${bind(filters.outcome)}`);
    if (filters.startedAfter) where.push(`c.started_at >= ${bind(filters.startedAfter)}::timestamptz`);
    if (filters.startedBefore) where.push(`c.started_at < ${bind(filters.startedBefore)}::timestamptz`);
    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let snapshot = cursor ? { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId } : null;
    if (!snapshot) {
      const newest = await getPool().query<{ created_at: string; id: string }>(`SELECT c.created_at, c.id FROM calls c ${baseWhere} ORDER BY c.created_at DESC, c.id DESC LIMIT 1`, values);
      if (!newest.rows[0]) return { calls: [], nextCursor: null, totalCount: 0 };
      snapshot = { createdAt: newest.rows[0].created_at, id: newest.rows[0].id };
    }
    const snapshotDate = bind(snapshot.createdAt);
    const snapshotId = bind(snapshot.id);
    const snapshotWhere = `WHERE ${[...where, `(c.created_at, c.id) <= (${snapshotDate}::timestamptz, ${snapshotId}::uuid)`].join(' AND ')}`;
    const count = await getPool().query<{ total_count: string }>(`SELECT COUNT(*)::text AS total_count FROM calls c ${snapshotWhere}`, [...values]);
    const pageValues = [...values];
    const cursorWhere = cursor
      ? ` AND (c.created_at, c.id) ${sort === 'newest' ? '<' : '>'} ($${pageValues.push(cursor.createdAt)}::timestamptz, $${pageValues.push(cursor.id)}::uuid)`
      : '';
    const limitPlaceholder = `$${pageValues.push(limit + 1)}`;
    const direction = sort === 'newest' ? 'DESC' : 'ASC';
    const rows = await getPool().query<Call>(`SELECT c.id, c.contact_name, c.company_name, c.contact_role,
      c.status, c.final_outcome, c.callback_at, c.started_at, c.completed_at, c.created_at, c.updated_at,
      COUNT(s.id)::int AS stage_count, ARRAY_REMOVE(ARRAY_AGG(s.stage_number ORDER BY s.stage_number), NULL) AS reached_stages,
      (SELECT LEFT(sm.summary_text, 180) FROM call_summaries sm WHERE sm.call_id = c.id ORDER BY sm.created_at DESC LIMIT 1) AS summary_preview
      FROM calls c LEFT JOIN call_stage_results s ON s.call_id = c.id
      ${snapshotWhere}${cursorWhere}
      GROUP BY c.id ORDER BY c.created_at ${direction}, c.id ${direction} LIMIT ${limitPlaceholder}`, pageValues);
    const hasMore = rows.rows.length > limit;
    const calls = rows.rows.slice(0, limit);
    const last = calls.at(-1);
    return {
      calls,
      totalCount: Number(count.rows[0]?.total_count ?? 0),
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id, snapshotCreatedAt: snapshot.createdAt, snapshotId: snapshot.id, sort, filterKey } : null,
    };
  }

  const state = await readState();
  const matching = state.calls.filter((call) => matchesCallFilters(call, filters));
  const newest = [...matching].sort((left, right) => compareCallTuple(right, left))[0];
  const snapshot = cursor
    ? { created_at: cursor.snapshotCreatedAt, id: cursor.snapshotId }
    : newest ? { created_at: newest.created_at, id: newest.id } : null;
  if (!snapshot) return { calls: [], nextCursor: null, totalCount: 0 };
  const inSnapshot = matching.filter((call) => compareCallTuple(call, snapshot!) <= 0);
  const afterCursor = cursor ? inSnapshot.filter((call) => sort === 'newest'
    ? compareCallTuple(call, { created_at: cursor.createdAt, id: cursor.id }) < 0
    : compareCallTuple(call, { created_at: cursor.createdAt, id: cursor.id }) > 0) : inSnapshot;
  const ordered = afterCursor.sort((left, right) => (sort === 'newest' ? -1 : 1) * compareCallTuple(left, right));
  const page = ordered.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const selected = page.slice(0, limit).map((call) => {
    const latestSummary = [...state.summaries].filter((summary) => summary.call_id === call.id).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0]?.summary_text;
    return {
      ...call,
      stage_count: state.stageResults.filter((stage) => stage.call_id === call.id).length,
      reached_stages: state.stageResults.filter((stage) => stage.call_id === call.id).map((stage) => stage.stage_number).sort((a, b) => a - b),
      ...(latestSummary === undefined ? {} : { summary_preview: latestSummary.slice(0, 180) }),
    };
  }).map(({ initial_context: _initialContext, final_notes: _finalNotes, call_purpose: _callPurpose, do_not_call_confirmed: _doNotCallConfirmed, ...call }) => call as unknown as Call);
  const last = selected.at(-1);
  return {
    calls: selected,
    totalCount: inSnapshot.length,
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id, snapshotCreatedAt: snapshot.created_at, snapshotId: snapshot.id, sort, filterKey } : null,
  };
}

export async function listUpcomingCallbacks(limit?: number): Promise<Call[]> {
  const now = new Date().toISOString();
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>(`SELECT id, contact_name, company_name, contact_role, status,
      final_outcome, callback_at, started_at, completed_at, created_at, updated_at
      FROM calls WHERE callback_at IS NOT NULL
      ORDER BY (callback_at < $1::timestamptz) DESC, callback_at ASC, id ASC${limit === undefined ? '' : ' LIMIT $2'}`, limit === undefined ? [now] : [now, limit]);
    return result.rows;
  }
  const state = await readState();
  const callbacks = state.calls.filter((call) => call.callback_at)
    .sort((left, right) => Number(Date.parse(right.callback_at!) < Date.parse(now)) - Number(Date.parse(left.callback_at!) < Date.parse(now)) || Date.parse(left.callback_at!) - Date.parse(right.callback_at!) || left.id.localeCompare(right.id));
  return limit === undefined ? callbacks : callbacks.slice(0, limit);
}

export interface CallAnalytics {
  total: number;
  completed: number;
  in_progress: number;
  follow_ups: number;
  buckets: Array<{ label: string; start: string; count: number }>;
  outcomes: Array<{ outcome: string; count: number }>;
}

export async function getCallAnalytics(period: 'daily' | 'weekly', timeZone: string, dateFrom?: string, dateTo?: string): Promise<CallAnalytics> {
  const days = period === 'daily' ? 7 : 56;
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<{ total: string; completed: string; in_progress: string; follow_ups: string; bucket_data: CallAnalytics['buckets']; outcome_data: CallAnalytics['outcomes'] }>(
      `WITH bounds AS (SELECT COALESCE(NULLIF($4, '')::date::timestamp, CASE WHEN $3='week' THEN date_trunc('week', now() AT TIME ZONE $1) - interval '7 weeks'
          ELSE date_trunc('day', now() AT TIME ZONE $1) - (($2::int - 1) * interval '1 day') END) AS first_day,
        COALESCE((NULLIF($5, '')::date + 1)::timestamp, CASE WHEN $3='week' THEN date_trunc('week', now() AT TIME ZONE $1) + interval '1 week'
          ELSE date_trunc('day', now() AT TIME ZONE $1) + interval '1 day' END) AS end_day),
      filtered AS (SELECT c.*, c.started_at AT TIME ZONE $1 AS local_started FROM calls c, bounds b
        WHERE c.started_at AT TIME ZONE $1 >= b.first_day AND c.started_at AT TIME ZONE $1 < b.end_day),
      series AS (SELECT generate_series(date_trunc($3, first_day), date_trunc($3, end_day - interval '1 second'), CASE WHEN $3='day' THEN interval '1 day' ELSE interval '1 week' END) AS bucket FROM bounds),
      bucket_rows AS (SELECT s.bucket, count(f.id)::int AS count FROM series s LEFT JOIN filtered f ON date_trunc($3, f.local_started)=s.bucket GROUP BY s.bucket),
      outcome_rows AS (SELECT COALESCE(final_outcome, 'unrecorded') AS outcome, count(*)::int AS count FROM filtered WHERE status = 'completed' GROUP BY 1)
      SELECT (SELECT count(*)::text FROM filtered) AS total,
        (SELECT count(*)::text FROM filtered WHERE status='completed') AS completed,
        (SELECT count(*)::text FROM filtered WHERE status='in_progress') AS in_progress,
        (SELECT count(*)::text FROM filtered WHERE callback_at IS NOT NULL) AS follow_ups,
        (SELECT COALESCE(json_agg(json_build_object('label', to_char(bucket, CASE WHEN $3='day' THEN 'Mon DD' ELSE 'IYYY "W"IW' END), 'start', bucket::text, 'count', count) ORDER BY bucket), '[]'::json) FROM bucket_rows) AS bucket_data,
        (SELECT COALESCE(json_agg(json_build_object('outcome', outcome, 'count', count) ORDER BY outcome), '[]'::json) FROM outcome_rows) AS outcome_data`,
      [timeZone, days, period === 'daily' ? 'day' : 'week', dateFrom ?? '', dateTo ?? ''],
    );
    const row = result.rows[0]!;
    return { total: Number(row.total), completed: Number(row.completed), in_progress: Number(row.in_progress), follow_ups: Number(row.follow_ups), buckets: row.bucket_data ?? [], outcomes: row.outcome_data ?? [] };
  }
  const state = await readState();
  const now = new Date();
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const [year, month, day] = localDate.split('-').map(Number);
  const today = new Date(Date.UTC(year!, month! - 1, day!));
  const monday = (value: Date) => { const result = new Date(value); result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7)); return result; };
  const currentWeek = monday(today);
  const defaultFirstDay = period === 'daily' ? new Date(today.getTime() - 6 * 86400000) : new Date(currentWeek.getTime() - 7 * 7 * 86400000);
  const firstDay = dateFrom ? new Date(`${dateFrom}T00:00:00.000Z`) : defaultFirstDay;
  const lastDay = dateTo ? new Date(`${dateTo}T00:00:00.000Z`) : period === 'daily' ? today : new Date(currentWeek.getTime() + 6 * 86400000);
  const calls = state.calls.filter((call) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(call.started_at));
    return date >= firstDay.toISOString().slice(0, 10) && date <= lastDay.toISOString().slice(0, 10);
  });
  const bucketMap = new Map<string, number>();
  const outcomeMap = new Map<string, number>();
  for (const call of calls) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(call.started_at));
    const callDay = new Date(`${date}T00:00:00.000Z`);
    const week = monday(callDay).toISOString().slice(0, 10);
    const key = period === 'daily' ? date : week;
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
    if (call.status === 'completed') { const outcome = call.final_outcome ?? 'unrecorded'; outcomeMap.set(outcome, (outcomeMap.get(outcome) ?? 0) + 1); }
  }
  const bucketFirstDay = period === 'weekly' ? monday(firstDay) : firstDay;
  const bucketCount = Math.floor((lastDay.getTime() - bucketFirstDay.getTime()) / (period === 'daily' ? 86400000 : 7 * 86400000)) + 1;
  const buckets = Array.from({ length: Math.max(0, bucketCount) }, (_, index) => {
    const startDate = new Date(bucketFirstDay.getTime() + index * (period === 'daily' ? 86400000 : 7 * 86400000));
    const start = startDate.toISOString().slice(0, 10);
    const label = period === 'daily'
      ? new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(`${start}T12:00:00.000Z`))
      : `Week of ${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(`${start}T12:00:00.000Z`))}`;
    return { label, start, count: bucketMap.get(start) ?? 0 };
  });
  return {
    total: calls.length, completed: calls.filter((call) => call.status === 'completed').length,
    in_progress: calls.filter((call) => call.status === 'in_progress').length,
    follow_ups: calls.filter((call) => call.callback_at).length,
    buckets,
    outcomes: [...outcomeMap].map(([outcome, count]) => ({ outcome, count })),
  };
}

export async function withSummaryGenerationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (getPersistenceMode() === 'postgres') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const result = await action();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const previous = localSummaryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  localSummaryLocks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (localSummaryLocks.get(key) === tail) localSummaryLocks.delete(key);
  }
}

export async function getCallById(id: string) {
  if (getPersistenceMode() === 'postgres') {
    return inReadSnapshot(async (db) => {
      const [callResult, stagesResult, summaryResult, questionsResult] = await Promise.all([
        db.query<Call>('SELECT * FROM calls WHERE id = $1', [id]),
        db.query<CallStageResult>('SELECT * FROM call_stage_results WHERE call_id = $1 ORDER BY stage_number', [id]),
        db.query<CallSummary>('SELECT * FROM call_summaries WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
        db.query<StageQuestion & { stage_result_id: string }>(`SELECT q.* FROM call_stage_questions q
        JOIN call_stage_results s ON s.id = q.stage_result_id WHERE s.call_id = $1
        ORDER BY s.stage_number, q.position`, [id]),
      ]);
      const call = callResult.rows[0];
      if (!call) return null;
      const questionsByStage = new Map<string, StageQuestion[]>();
      for (const { stage_result_id, ...question } of questionsResult.rows) {
        const rows = questionsByStage.get(stage_result_id) ?? [];
        rows.push(question);
        questionsByStage.set(stage_result_id, rows);
      }
      return { call, stageResults: stagesResult.rows.map((stage) => ({ ...stage, questions: questionsByStage.get(stage.id) ?? [] })), summary: summaryResult.rows[0] ?? null };
    });
  }

  const state = await readState();
  const call = state.calls.find((item) => item.id === id);
  if (!call) return null;
  return {
    call,
    stageResults: state.stageResults.filter((result) => result.call_id === id).sort((a, b) => a.stage_number - b.stage_number),
    summary: [...state.summaries].filter((item) => item.call_id === id).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null,
  };
}

export async function createCall(input: { contact_name?: string | null; company_name?: string | null; contact_role?: string | null; call_purpose?: string | null; initial_context?: string | null }): Promise<Call> {
  const now = new Date().toISOString();
  const call: Call = {
    id: randomUUID(),
    contact_name: input.contact_name ?? null,
    company_name: input.company_name ?? null,
    contact_role: input.contact_role ?? null,
    call_purpose: input.call_purpose ?? null,
    initial_context: input.initial_context ?? null,
    status: 'in_progress',
    final_outcome: null,
    do_not_call_confirmed: false,
    final_notes: null,
    callback_at: null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };

  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>(
      `INSERT INTO calls (id, contact_name, company_name, contact_role, call_purpose, initial_context, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8) RETURNING *`,
      [call.id, call.contact_name, call.company_name, call.contact_role, call.call_purpose, call.initial_context, call.status, now],
    );
    return result.rows[0]!;
  }

  return mutateLocalState((state) => {
    state.calls.push(call);
    return { result: call, persist: true };
  });
}

export async function upsertStageResult(payload: { callId: string; stage_number: number; stage_status: StageStatus; notes?: string | null; structured_result?: Record<string, unknown>; questions?: StageQuestion[]; callbackAt?: string | null }): Promise<CallStageResult | null> {
  if (getPersistenceMode() === 'postgres') {
    return inTransaction(async (client) => {
      const call = await client.query(`UPDATE calls SET updated_at = NOW(),
        callback_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE callback_at END
        WHERE id = $1 AND status = 'in_progress' RETURNING id`, [payload.callId, payload.callbackAt !== undefined, payload.callbackAt ?? null]);
      if (!call.rowCount) {
        const existing = await client.query<{ status: Call['status'] }>('SELECT status FROM calls WHERE id = $1', [payload.callId]);
        if (existing.rows[0]?.status === 'completed') throw new CallAlreadyCompletedError();
        return null;
      }
      const result = await client.query<CallStageResult>(
        `INSERT INTO call_stage_results (id, call_id, stage_number, stage_status, notes, structured_result)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (call_id, stage_number) DO UPDATE SET
           stage_status = EXCLUDED.stage_status,
           notes = COALESCE(EXCLUDED.notes, call_stage_results.notes),
           structured_result = CASE WHEN $7::boolean THEN EXCLUDED.structured_result ELSE call_stage_results.structured_result END,
           updated_at = NOW()
         RETURNING *`,
        [randomUUID(), payload.callId, payload.stage_number, payload.stage_status, payload.notes ?? null,
          payload.structured_result === undefined ? '{}' : JSON.stringify(payload.structured_result), payload.structured_result !== undefined],
      );
      const savedStage = result.rows[0]!;
      if (payload.questions !== undefined) {
        await client.query('DELETE FROM call_stage_questions WHERE stage_result_id = $1', [savedStage.id]);
        for (const question of payload.questions) {
          await client.query(`INSERT INTO call_stage_questions
            (id, stage_result_id, question_text, source, asked, response, position)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [question.id, savedStage.id, question.question_text, question.source, question.asked, question.response, question.position]);
        }
      }
      return { ...savedStage, ...(payload.questions === undefined ? {} : { questions: payload.questions }) };
    });
  }

  return mutateLocalState((state) => {
    const call = state.calls.find((item) => item.id === payload.callId);
    if (!call) return { result: null, persist: false };
    if (call.status === 'completed') throw new CallAlreadyCompletedError();
    const now = new Date().toISOString();
    const existing = state.stageResults.find((result) => result.call_id === payload.callId && result.stage_number === payload.stage_number);
    const next: CallStageResult = existing
      ? { ...existing, stage_status: payload.stage_status, notes: payload.notes ?? existing.notes, structured_result: payload.structured_result ?? existing.structured_result, ...(payload.questions === undefined ? {} : { questions: payload.questions }), updated_at: now }
      : { id: randomUUID(), call_id: payload.callId, stage_number: payload.stage_number, stage_status: payload.stage_status, structured_result: payload.structured_result ?? {}, notes: payload.notes ?? null, questions: payload.questions ?? [], updated_at: now, created_at: now };
    if (existing) state.stageResults[state.stageResults.indexOf(existing)] = next;
    else state.stageResults.push(next);
    call.updated_at = now;
    if (payload.callbackAt !== undefined) call.callback_at = payload.callbackAt;
    return { result: next, persist: true };
  });
}

export async function closeCall(callId: string, final_outcome: string, final_notes?: string | null, callbackAt?: string | null, doNotCallConfirmed = false): Promise<Call | null> {
  const now = new Date().toISOString();
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>(
      `UPDATE calls SET status = 'completed', final_outcome = $2, do_not_call_confirmed = $6,
       final_notes = COALESCE($3, final_notes), callback_at = CASE WHEN $7::boolean THEN $5::timestamptz ELSE callback_at END,
       completed_at = $4, updated_at = $4 WHERE id = $1 AND status = 'in_progress' RETURNING *`,
      [callId, final_outcome, final_notes ?? null, now, callbackAt ?? null, doNotCallConfirmed, callbackAt !== undefined],
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await getPool().query<{ status: Call['status'] }>('SELECT status FROM calls WHERE id = $1', [callId]);
    if (existing.rows[0]?.status === 'completed') throw new CallAlreadyCompletedError();
    return null;
  }
  return mutateLocalState((state) => {
    const index = state.calls.findIndex((call) => call.id === callId);
    if (index < 0) return { result: null, persist: false };
    const current = state.calls[index]!;
    if (current.status === 'completed') throw new CallAlreadyCompletedError();
    state.calls[index] = { ...current, status: 'completed', final_outcome: final_outcome as Call['final_outcome'], do_not_call_confirmed: doNotCallConfirmed, final_notes: final_notes ?? current.final_notes, callback_at: callbackAt === undefined ? current.callback_at : callbackAt, completed_at: now, updated_at: now };
    return { result: state.calls[index]!, persist: true };
  });
}

export async function findSummaryBySourceHash(callId: string, sourceHash: string): Promise<CallSummary | null> {
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<CallSummary>('SELECT * FROM call_summaries WHERE call_id = $1 AND source_hash = $2 LIMIT 1', [callId, sourceHash]);
    return result.rows[0] ?? null;
  }
  const state = await readState();
  return state.summaries.find((summary) => summary.call_id === callId && summary.source_hash === sourceHash) ?? null;
}

export async function saveSummary(callId: string, summaryText: string, modelName: string | null, sourceSnapshot: Record<string, unknown>, sourceHash?: string): Promise<CallSummary> {
  const item: CallSummary = { id: randomUUID(), call_id: callId, summary_text: summaryText, model_name: modelName, source_snapshot: sourceSnapshot, source_hash: sourceHash ?? null, created_at: new Date().toISOString() };
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<CallSummary>(
      `INSERT INTO call_summaries (id, call_id, summary_text, model_name, source_snapshot, source_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (call_id, source_hash) WHERE source_hash IS NOT NULL
       DO UPDATE SET
         summary_text = CASE WHEN (call_summaries.model_name = 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary') OR (call_summaries.model_name <> 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary' AND call_summaries.model_name IS DISTINCT FROM EXCLUDED.model_name) THEN EXCLUDED.summary_text ELSE call_summaries.summary_text END,
         model_name = CASE WHEN (call_summaries.model_name = 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary') OR (call_summaries.model_name <> 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary' AND call_summaries.model_name IS DISTINCT FROM EXCLUDED.model_name) THEN EXCLUDED.model_name ELSE call_summaries.model_name END,
         source_snapshot = CASE WHEN (call_summaries.model_name = 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary') OR (call_summaries.model_name <> 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary' AND call_summaries.model_name IS DISTINCT FROM EXCLUDED.model_name) THEN EXCLUDED.source_snapshot ELSE call_summaries.source_snapshot END,
         created_at = CASE WHEN (call_summaries.model_name = 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary') OR (call_summaries.model_name <> 'local-deterministic-summary' AND EXCLUDED.model_name <> 'local-deterministic-summary' AND call_summaries.model_name IS DISTINCT FROM EXCLUDED.model_name) THEN EXCLUDED.created_at ELSE call_summaries.created_at END
       RETURNING *`,
      [item.id, item.call_id, item.summary_text, item.model_name, JSON.stringify(item.source_snapshot), item.source_hash],
    );
    return result.rows[0]!;
  }
  return mutateLocalState((state) => {
    const existingIndex = sourceHash ? state.summaries.findIndex((summary) => summary.call_id === callId && summary.source_hash === sourceHash) : -1;
    if (existingIndex >= 0) {
      const existing = state.summaries[existingIndex]!;
      if (modelName && modelName !== 'local-deterministic-summary'
        && (existing.model_name === 'local-deterministic-summary' || existing.model_name !== modelName)) {
        const upgraded = { ...existing, summary_text: summaryText, model_name: modelName, source_snapshot: sourceSnapshot, created_at: item.created_at };
        state.summaries[existingIndex] = upgraded;
        return { result: upgraded, persist: true };
      }
      return { result: existing, persist: false };
    }
    state.summaries.push(item);
    return { result: item, persist: true };
  });
}
