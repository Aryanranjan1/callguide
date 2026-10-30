import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Call, CallStageResult, CallSummary, StageStatus } from './types.js';

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

function configureStore() {
  if (mode) return;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const connectionUrl = new URL(databaseUrl);
    // SSL is configured below so libpq-style URL flags cannot weaken or replace it.
    for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connectionUrl.searchParams.delete(option);
    const ca = process.env.DATABASE_SSL_CA?.replaceAll('\\n', '\n').trim();
    pool = new Pool({
      connectionString: connectionUrl.toString(),
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
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

export async function closeStore() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function ensureFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DATA_FILE, 'utf-8');
  } catch {
    await writeFile(DATA_FILE, JSON.stringify(defaultState, null, 2), 'utf-8');
  }
}

async function readState(): Promise<PersistedState> {
  await ensureFile();
  const content = await readFile(DATA_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(content) as Partial<PersistedState>;
    return {
      calls: parsed.calls ?? [],
      stageResults: parsed.stageResults ?? [],
      summaries: parsed.summaries ?? [],
    };
  } catch {
    return { ...defaultState };
  }
}

async function writeState(state: PersistedState) {
  await ensureFile();
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
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

export async function listCalls(): Promise<Call[]> {
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>('SELECT * FROM calls ORDER BY created_at DESC');
    return result.rows;
  }
  const state = await readState();
  return [...state.calls].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function getCallById(id: string) {
  if (getPersistenceMode() === 'postgres') {
    const db = getPool();
    const [callResult, stagesResult, summaryResult] = await Promise.all([
      db.query<Call>('SELECT * FROM calls WHERE id = $1', [id]),
      db.query<CallStageResult>('SELECT * FROM call_stage_results WHERE call_id = $1 ORDER BY stage_number', [id]),
      db.query<CallSummary>('SELECT * FROM call_summaries WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
    ]);
    const call = callResult.rows[0];
    if (!call) return null;
    return { call, stageResults: stagesResult.rows, summary: summaryResult.rows[0] ?? null };
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
    final_notes: null,
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

  const state = await readState();
  state.calls.push(call);
  await writeState(state);
  return call;
}

export async function upsertStageResult(payload: { callId: string; stage_number: number; stage_status: StageStatus; notes?: string | null; structured_result?: Record<string, unknown> }): Promise<CallStageResult | null> {
  if (getPersistenceMode() === 'postgres') {
    return inTransaction(async (client) => {
      const call = await client.query('UPDATE calls SET updated_at = NOW() WHERE id = $1 RETURNING id', [payload.callId]);
      if (!call.rowCount) return null;
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
      return result.rows[0]!;
    });
  }

  const state = await readState();
  const now = new Date().toISOString();
  const existing = state.stageResults.find((result) => result.call_id === payload.callId && result.stage_number === payload.stage_number);
  const next: CallStageResult = existing
    ? { ...existing, stage_status: payload.stage_status, notes: payload.notes ?? existing.notes, structured_result: payload.structured_result ?? existing.structured_result, updated_at: now }
    : { id: randomUUID(), call_id: payload.callId, stage_number: payload.stage_number, stage_status: payload.stage_status, structured_result: payload.structured_result ?? {}, notes: payload.notes ?? null, updated_at: now, created_at: now };
  if (existing) state.stageResults[state.stageResults.indexOf(existing)] = next;
  else state.stageResults.push(next);
  const call = state.calls.find((item) => item.id === payload.callId);
  if (!call) return null;
  call.updated_at = now;
  await writeState(state);
  return next;
}

export async function closeCall(callId: string, final_outcome: string, final_notes?: string | null): Promise<Call | null> {
  const now = new Date().toISOString();
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<Call>(
      `UPDATE calls SET status = 'completed', final_outcome = $2,
       final_notes = COALESCE($3, final_notes), completed_at = $4, updated_at = $4
       WHERE id = $1 RETURNING *`, [callId, final_outcome, final_notes ?? null, now],
    );
    return result.rows[0] ?? null;
  }
  const state = await readState();
  const index = state.calls.findIndex((call) => call.id === callId);
  if (index < 0) return null;
  const current = state.calls[index]!;
  state.calls[index] = { ...current, status: 'completed', final_outcome: final_outcome as Call['final_outcome'], final_notes: final_notes ?? current.final_notes, completed_at: now, updated_at: now };
  await writeState(state);
  return state.calls[index]!;
}

export async function saveSummary(callId: string, summaryText: string, modelName: string | null, sourceSnapshot: Record<string, unknown>): Promise<CallSummary> {
  const item: CallSummary = { id: randomUUID(), call_id: callId, summary_text: summaryText, model_name: modelName, source_snapshot: sourceSnapshot, created_at: new Date().toISOString() };
  if (getPersistenceMode() === 'postgres') {
    const result = await getPool().query<CallSummary>(
      `INSERT INTO call_summaries (id, call_id, summary_text, model_name, source_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [item.id, item.call_id, item.summary_text, item.model_name, JSON.stringify(item.source_snapshot)],
    );
    return result.rows[0]!;
  }
  const state = await readState();
  state.summaries.push(item);
  await writeState(state);
  return item;
}
