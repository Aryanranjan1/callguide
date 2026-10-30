import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { closeCall, closeStore, createCall, getCallById, getPersistenceMode, initializeStore, listCalls, saveSummary, upsertStageResult } from './store.js';
import { generateCallSummary } from './summary.js';
import type { ApiEnvelope, Call, CallOutcome, CallStageResult, CallSummary, StageStatus } from './types.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const isProduction = process.env.NODE_ENV === 'production';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim() || (isProduction ? '' : 'http://localhost:3000');
if (!frontendOrigin) throw new Error('FRONTEND_ORIGIN is required in production.');
const allowedOrigins = isProduction ? [frontendOrigin] : [frontendOrigin, 'http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));

const withEnvelope = <T>(data: T | null, error: { code: string; message: string } | null = null): ApiEnvelope<T> => ({
  data,
  error,
});

function validateText(value: unknown, maxLength = 2000): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

async function generateSummary(callId: string) {
  const result = await getCallById(callId);
  if (!result) {
    return null;
  }
  return generateCallSummary(result.call, result.stageResults);
}

app.get('/health', (_req, res) => {
  res.json(withEnvelope({ status: 'ok', service: 'callguide-api', persistence: getPersistenceMode() }, null));
});

app.get('/calls', async (_req, res) => {
  try {
    const calls = await listCalls();
    res.json(withEnvelope(calls, null));
  } catch (error) {
    res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to list calls.' }));
  }
});

app.post('/calls', async (req, res) => {
  try {
    const { contact_name, company_name, contact_role, call_purpose, initial_context } = req.body ?? {};
    const call = await createCall({
      contact_name: validateText(contact_name, 255),
      company_name: validateText(company_name, 255),
      contact_role: validateText(contact_role, 255),
      call_purpose: validateText(call_purpose, 2000),
      initial_context: validateText(initial_context, 4000),
    });

    res.status(201).json(withEnvelope(call, null));
  } catch (error) {
    res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to create call.' }));
  }
});

app.get('/calls/:id', async (req, res) => {
  try {
    const result = await getCallById(req.params.id);
    if (!result) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }
    return res.json(withEnvelope({ ...result.call, stageResults: result.stageResults, summary: result.summary }, null));
  } catch (error) {
    return res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to load call.' }));
  }
});

app.post('/calls/:id/stages', async (req, res) => {
  try {
    const { stage_number, stage_status, notes, structured_result } = req.body ?? {};
    const stageNumber = Number(stage_number);
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 8) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage number must be between 1 and 8.' }));
    }
    const validStageStatuses: StageStatus[] = ['not_started', 'in_progress', 'completed'];
    if (stage_status != null && !validStageStatuses.includes(stage_status)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage status is invalid.' }));
    }
    if (notes != null && typeof notes !== 'string') {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Stage notes must be text.' }));
    }
    if (structured_result != null && (typeof structured_result !== 'object' || Array.isArray(structured_result))) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Structured stage data must be an object.' }));
    }

    const call = await getCallById(req.params.id);
    if (!call) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }

    const saved = await upsertStageResult({
      callId: req.params.id,
      stage_number: stageNumber,
      stage_status: (stage_status as StageStatus | undefined) ?? 'in_progress',
      notes: typeof notes === 'string' ? notes : null,
      structured_result: (structured_result as Record<string, unknown> | undefined) ?? {},
    });

    if (!saved) return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    return res.status(200).json(withEnvelope(saved, null));
  } catch (error) {
    return res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to save stage.' }));
  }
});

app.post('/calls/:id/close', async (req, res) => {
  try {
    const { final_outcome, final_notes } = req.body ?? {};
    const outcomes: CallOutcome[] = ['follow_up_agreed', 'meeting_agreed', 'information_requested', 'not_interested', 'wrong_person', 'no_contact_made', 'no_clear_outcome', 'other'];
    if (!outcomes.includes(final_outcome)) {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'A valid final outcome is required.' }));
    }
    if (final_notes != null && typeof final_notes !== 'string') {
      return res.status(400).json(withEnvelope(null, { code: 'VALIDATION_ERROR', message: 'Final notes must be text.' }));
    }

    const call = await closeCall(req.params.id, final_outcome, typeof final_notes === 'string' ? final_notes : null);
    if (!call) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }

    return res.status(200).json(withEnvelope(call, null));
  } catch (error) {
    return res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to close call.' }));
  }
});

app.post('/calls/:id/summary', async (req, res) => {
  try {
    const call = await getCallById(req.params.id);
    if (!call) {
      return res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Call not found.' }));
    }

    const generated = await generateSummary(req.params.id);
    if (!generated) {
      return res.status(500).json(withEnvelope(null, { code: 'SUMMARY_ERROR', message: 'Unable to create summary.' }));
    }

    const summary = await saveSummary(req.params.id, generated.summary, generated.modelName, {
      call_id: req.params.id,
      stage_count: call.stageResults.length,
      final_outcome: call.call.final_outcome,
    });

    return res.status(200).json(withEnvelope(summary, null));
  } catch (error) {
    return res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unable to generate summary.' }));
  }
});

app.use((_req, res) => {
  res.status(404).json(withEnvelope(null, { code: 'NOT_FOUND', message: 'Route not found.' }));
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json(withEnvelope(null, { code: 'SERVER_ERROR', message: error.message || 'Unexpected server error.' }));
});

async function start() {
  await initializeStore();
  const persistence = getPersistenceMode();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CallGuide API listening on port ${port} (${persistence} persistence)`);
  });

  const shutdown = () => {
    server.close(async (error) => {
      await closeStore();
      if (error) {
        console.error('Error while shutting down the HTTP server.');
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

start().catch(async (error: unknown) => {
  if (error instanceof Error && error.message.startsWith('DATABASE_URL is required')) {
    console.error(error.message);
  } else {
    console.error('CallGuide API failed to start. Check environment configuration and database connectivity.');
  }
  await closeStore();
  process.exitCode = 1;
});
