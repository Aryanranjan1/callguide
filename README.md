# CallGuide

CallGuide is a browser-based calling assistant built to guide a sales representative through eight structured call stages, capture the prospect's real responses, and store a durable record of what happened. The app prioritizes clarity, data integrity, and a reliable post-call summary without inventing facts.

## Problem it solves

Commercial calls often involve multiple steps: confirming the right contact, explaining the purpose, asking for permission, understanding the business, capturing needs in the prospect's own words, handling objections, agreeing on next steps, and closing the conversation cleanly. Without structure, important information can be missed or misrecorded. CallGuide makes that workflow explicit and keeps notes in a persistent, reviewable record.

## Core features

- Call history for starting and viewing calls
- Create a call with optional contact context
- Eight guided call stages
- Notes and structured response capture
- Resume existing calls after refresh or return
- Close a call with a final outcome
- Completed-call review with saved notes
- AI-assisted summary generated from saved call data
- PostgreSQL persistence in production, with a JSON file fallback for local development

## Architecture

```text
Browser (Next.js) -> HTTP JSON API (Express + TypeScript) -> PostgreSQL (Supabase)
                                         -> Summary generator (server-side only)
```

## Tech stack

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL schema in database/schema.sql, with Supabase compatibility
- Persistence: PostgreSQL through `pg`; local JSON fallback only when developing without `DATABASE_URL`
- AI: server-side OpenRouter chat completions through backend `fetch`; deterministic local fallbacks remain available when configuration or generation fails

## Repository structure

```text
callguide/
├── backend/
│   ├── src/
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── database/
│   └── schema.sql
├── frontend/
│   ├── src/
│   ├── .env.example
│   ├── package.json
│   └── next.config.ts
├── .gitignore
├── README.md
└── package-lock.json
```

## Local setup

1. Install dependencies:

```bash
cd backend && npm install
cd ../frontend && npm install
```

2. Create local environment files from the examples. The backend uses a local JSON file when `DATABASE_URL` is empty; the file is stored at `backend/data/calls.json` and ignored by Git.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

3. Edit `backend/.env` and manually enter your Supabase PostgreSQL connection string, OpenRouter API key, and OpenRouter model identifier. The frontend URL is `http://localhost:3000`; the backend URL is `http://localhost:4000`.

4. To use Supabase while developing locally, create a Supabase project, apply `database/schema.sql` in its SQL Editor, and place that project's PostgreSQL connection string in `backend/.env` as `DATABASE_URL`. Remote connections verify the server certificate; configure `DATABASE_SSL_CA` with the provider's root CA when needed. If `DATABASE_URL` is empty while developing, the backend uses local JSON persistence. Production requires `DATABASE_URL` and never falls back to JSON.

5. Start the backend:

```bash
cd backend
npm run dev
```

6. Start the frontend in a second terminal:

```bash
cd frontend
npm run dev
```

7. Open http://localhost:3000 and check the API at http://localhost:4000/health.

## Backend commands

```bash
cd backend
npm install
npm run dev
npm run build
npm start
```

## Frontend commands

```bash
cd frontend
npm install
npm run dev
npm run build
npm run start
```

## Database schema

The fresh-install schema is defined in [database/schema.sql](database/schema.sql). It includes the `calls`, `call_stage_results`, `call_stage_questions`, and `call_summaries` tables with the constraints, indexes, and relationships used by the backend queries. Existing installations should apply `database/migrations/20261030_call_workflow_fields.sql`, which adds callback and question records and preserves historical outcome values without deleting calls. PostgreSQL writes use parameterized statements; stage and question saves update the call timestamp and upsert the stage result in one transaction. The previous `backend/data/calls.json`, if present, is left untouched and is not imported automatically; migrate any records you need before switching production to PostgreSQL.

To apply it in Supabase, create a new SQL query in the Supabase SQL editor and paste the contents of the file.

## Environment variables

Put private variables in `backend/.env` for local development or in the backend host's environment settings in production. Put only the public API URL in `frontend/.env.local` or the frontend host's build environment. Next.js embeds `NEXT_PUBLIC_*` variables into browser JavaScript at build time; never put credentials there.

| Variable | Owner | Required | Purpose |
|---|---|---:|---|
| `PORT` | Backend | No (defaults to `4000`; Render supplies it) | HTTP port. |
| `NODE_ENV` | Backend | No | Set to `production` on Render; production requires PostgreSQL. |
| `FRONTEND_ORIGIN` | Backend | Production | Exact browser origin allowed by CORS, such as `https://app.example.com`. Local default is `http://localhost:3000`. |
| `DATABASE_URL` | Backend | Production; optional locally | PostgreSQL connection string. Without it in development, the backend uses the local JSON file. SSL is always enabled for PostgreSQL. |
| `DATABASE_SSL_CA` | Backend | No | Optional provider root CA certificate (PEM). Remote PostgreSQL connections verify certificates by default; non-production localhost may use plaintext when no CA is configured. |
| `AI_PROVIDER` | Backend | No | Active provider; use `openrouter`. |
| `OPENROUTER_API_KEY` | Backend | For AI generation | OpenRouter API key. Keep it in backend environment settings only. |
| `OPENROUTER_MODEL` | Backend | For AI generation | Model identifier accepted by OpenRouter. It is required and has no application default. |
| `OPENROUTER_SITE_URL` | Backend | No | Optional site attribution sent as `HTTP-Referer`. |
| `OPENROUTER_APP_NAME` | Backend | No | Optional app attribution sent as `X-OpenRouter-Title`. |
| `AI_REQUEST_TIMEOUT_MS` | Backend | No | Provider request timeout in milliseconds; defaults to `20000`. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Production | Browser-visible base URL for the Express API, for example `https://callguide-api.onrender.com`. Local default is `http://localhost:4000`. Set it at frontend build time. |

No Supabase service-role key is used: the Express backend connects directly to PostgreSQL using `DATABASE_URL`. Never set `DATABASE_URL` or `OPENROUTER_API_KEY` in the frontend environment.

### Backend local example (`backend/.env.example`)

```text
PORT=4000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:3000
DATABASE_URL=
DATABASE_SSL_CA=
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=CallGuide
AI_REQUEST_TIMEOUT_MS=20000
```

### Frontend local example (`frontend/.env.example`)

```text
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

## API contract

### Public demo data notice

CallGuide is a public, no-login assignment application. Anyone who can reach the API can read and modify call records. CORS only controls which browser origins may read responses; it is not authentication or authorization. Use fictional demonstration data only. Do not enter real personal information, confidential business information, or other sensitive data. The History API uses cursor pagination (100 records by default, 200 maximum per request); the browser loads 50 at a time. This is not an access control.

### Health

- `GET /health`

### Calls

- `POST /calls`
- `GET /calls`
- `GET /calls/callbacks`
- `GET /calls/:id`
- `POST /calls/:id/stages`
- `POST /calls/:id/close`
- `POST /calls/:id/summary`

Each response uses the same envelope pattern:

```json
{
  "data": {},
  "error": null
}
```

`GET /calls` accepts `limit`, `cursor`, `q`, `status`, `outcome`, `started_after`, `started_before`, and `sort`. Search and filters are applied on the server before pagination. The `data` array remains unchanged; `X-Next-Cursor`, `X-Has-More`, `X-Page-Count`, and `X-Total-Count` response headers describe the page. Cursors are tied to their filters and a first-page snapshot, so new calls do not shift later pages. The matching total is counted across the full snapshot; status metrics in the UI are explicitly labeled as counts for loaded pages. Callback reminders use a separate query across all records and show the next four scheduled callbacks.

## AI summary feature

The backend sends summary and live suggested-question requests to OpenRouter at `https://openrouter.ai/api/v1/chat/completions` using standard `fetch`. The provider, API key, and model are configured with `AI_PROVIDER`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`; no model is hardcoded. Requests use the configurable `AI_REQUEST_TIMEOUT_MS` timeout (20 seconds by default). Optional `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` values add the `HTTP-Referer` and `X-OpenRouter-Title` attribution headers. A normalized summary projection builds both the unchanged prompt input and a versioned source hash; internal row IDs and update timestamps are excluded. Changes to actual prompt inputs, prompt version, or output-contract version invalidate the cache. The stored model name participates in summary cache checks, and question cache identity includes the configured model. In-process requests share matching snapshots, while PostgreSQL advisory locks and the unique source-hash index coordinate generation and rows across instances. Advisory locks hold a database connection during the provider request.

The limit is five uncached summaries and eight live-question generations per resolved client IP per minute per backend process. No automatic provider retry loops are used. Closing a call saves a deterministic fallback; an explicit request retries OpenRouter when configuration is available and upgrades the fallback only after successful bounded output. Failed requests retain an existing valid summary or fallback. Suggested questions appear from deterministic context immediately and are replaced only after valid strict-schema output. The UI marks AI text unverified. Backend checks enforce non-empty text and a 6,000-character maximum for summaries, not semantic factuality; verify AI claims against the saved record. Summaries never update outcomes, callbacks, do-not-call status, or stage data. The API key stays in the backend. Create an API key in your OpenRouter account settings.

## Testing checklist

- Create a call from the dashboard
- Move through all eight stages
- Save notes and reopen a call
- Close the call with an outcome
- Open the completed call review page
- Generate a summary
- Confirm the API health endpoint succeeds

## Deployment notes

#### Supabase and Render setup

1. Create a Supabase project and apply `database/schema.sql` in its SQL Editor (or run it with a trusted PostgreSQL client). For an existing CallGuide database, apply `database/migrations/20261030_call_workflow_fields.sql`, `database/migrations/20261031_summary_source_hash.sql`, and then `database/migrations/20261101_history_cursor_indexes.sql`.
2. Copy the project's PostgreSQL connection string. Use the direct endpoint when Render can reach it; use Supavisor session mode if the direct endpoint is unreachable over IPv6. Remote PostgreSQL connections verify TLS certificates. Set `DATABASE_SSL_CA` to the PEM root CA from Supabase Database Settings when required. Only non-production localhost connections without a configured CA may use plaintext. Do not use the browser-facing Supabase anon key.
3. Create a Render Web Service for the `backend` directory. Use `npm ci --include=dev && npm run build` as the build command so the committed lockfile is used and TypeScript plus its declaration packages are installed even when `NODE_ENV=production`. Use `npm start` as the start command.
4. Configure `NODE_ENV=production`, `DATABASE_URL`, `FRONTEND_ORIGIN`, `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` in Render. Add `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`, and `AI_REQUEST_TIMEOUT_MS` only when needed. Set `DATABASE_SSL_CA` when the provider requires a custom CA. Render supplies `PORT`. Production trusts one reverse-proxy hop for Express client-IP resolution; local and test modes do not trust forwarded headers. Verify this hop count if changing hosting topology.
5. Deploy the frontend separately and set `NEXT_PUBLIC_API_BASE_URL` to the Render service URL before building it. Set the backend's `FRONTEND_ORIGIN` to the deployed frontend origin and redeploy the backend.
6. Check `GET /health`, then exercise call creation, stage saves, closure, and summary generation. Health reports the active persistence mode but does not replace a workflow check.

No remote database, service, or deployment has been configured by these local changes.

## Known limitations

- No authentication or multi-user permission model yet
- Local JSON persistence is not shared across backend instances and is only intended for development; use PostgreSQL in production
- AI summaries depend on provider availability unless the local fallback is used
- Telephony, transcription, and CRM integrations remain out of scope for the MVP

## Demo workflow

1. Open call history
2. Start a new call
3. Complete the eight stages
4. Save notes while navigating
5. Reopen the call after refresh
6. Close the call and record a final outcome
7. Generate and review the summary

## Assessment demo

The app is designed to demonstrate a complete call flow from creation through final review and summary generation, with durable saved records and a clear review page. The repository is public-facing and ready for deployment documentation and video submission.
