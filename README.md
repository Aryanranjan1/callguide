# CallGuide

CallGuide is a browser-based calling assistant built to guide a sales representative through eight structured call stages, capture the prospect's real responses, and store a durable record of what happened. The app prioritizes clarity, data integrity, and a reliable post-call summary without inventing facts.

## Problem it solves

Commercial calls often involve multiple steps: confirming the right contact, explaining the purpose, asking for permission, understanding the business, capturing needs in the prospect's own words, handling objections, agreeing on next steps, and closing the conversation cleanly. Without structure, important information can be missed or misrecorded. CallGuide makes that workflow explicit and keeps notes in a persistent, reviewable record.

## Core features

- Dashboard for starting and viewing calls
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
- AI: server-side Gemini API through Google's official `@google/genai` SDK; deterministic local summary when the key is absent or the provider fails

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

3. Edit `backend/.env` and manually enter your Supabase PostgreSQL connection string and Gemini API key. Keep the Gemini model at `gemini-3.8-flash` or enter another model available to your Gemini API key. The frontend URL is `http://localhost:3000`; the backend URL is `http://localhost:4000`.

4. To use Supabase while developing locally, create a Supabase project, apply `database/schema.sql` in its SQL Editor, and place that project's PostgreSQL connection string in `backend/.env` as `DATABASE_URL`. `DATABASE_SSL_CA` is optional; set it to the project's root CA certificate if certificate verification is desired. If `DATABASE_URL` is empty while developing, the backend uses local JSON persistence. Production requires `DATABASE_URL` and never falls back to JSON.

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

The schema is defined in [database/schema.sql](database/schema.sql). It includes the `calls`, `call_stage_results`, and `call_summaries` tables with the constraints, indexes, and relationships used by the backend queries. PostgreSQL writes use parameterized statements; stage saves update the call timestamp and upsert the stage result in one transaction. The previous `backend/data/calls.json`, if present, is left untouched and is not imported automatically; migrate any records you need before switching production to PostgreSQL.

To apply it in Supabase, create a new SQL query in the Supabase SQL editor and paste the contents of the file.

## Environment variables

Put private variables in `backend/.env` for local development or in the backend host's environment settings in production. Put only the public API URL in `frontend/.env.local` or the frontend host's build environment. Next.js embeds `NEXT_PUBLIC_*` variables into browser JavaScript at build time; never put credentials there.

| Variable | Owner | Required | Purpose |
|---|---|---:|---|
| `PORT` | Backend | No (defaults to `4000`; Render supplies it) | HTTP port. |
| `NODE_ENV` | Backend | No | Set to `production` on Render; production requires PostgreSQL. |
| `FRONTEND_ORIGIN` | Backend | Production | Exact browser origin allowed by CORS, such as `https://app.example.com`. Local default is `http://localhost:3000`. |
| `DATABASE_URL` | Backend | Production; optional locally | PostgreSQL connection string. Without it in development, the backend uses the local JSON file. SSL is always enabled for PostgreSQL. |
| `DATABASE_SSL_CA` | Backend | No | Optional Supabase root CA certificate (PEM) for TLS certificate verification. Without it, the PostgreSQL connection is encrypted but the server certificate is not verified. |
| `GEMINI_API_KEY` | Backend | No | Gemini API key for server-side summaries. If missing or the provider fails, the deterministic summary is used. Enter it manually in the backend environment only. |
| `GEMINI_MODEL` | Backend | No | Gemini model identifier; defaults to `gemini-3.8-flash`. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Production | Browser-visible base URL for the Express API, for example `https://callguide-api.onrender.com`. Local default is `http://localhost:4000`. Set it at frontend build time. |

No Supabase service-role key is used: the Express backend connects directly to PostgreSQL using `DATABASE_URL`. Never set `DATABASE_URL` or `GEMINI_API_KEY` in the frontend environment.

### Backend local example (`backend/.env.example`)

```text
PORT=4000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:3000
DATABASE_URL=
DATABASE_SSL_CA=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
```

### Frontend local example (`frontend/.env.example`)

```text
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

## API contract

### Health

- `GET /health`

### Calls

- `POST /calls`
- `GET /calls`
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

## AI summary feature

The summary endpoint reads saved call and stage data, then sends it from the backend to Google's Gemini API using the official `@google/genai` SDK. The backend defaults to `gemini-3.8-flash`, configurable through `GEMINI_MODEL`; requests have a 15-second timeout. If `GEMINI_API_KEY` is blank or the provider errors, times out, or returns empty text, the backend saves its deterministic local summary. The API key stays in the backend and summaries do not overwrite original notes. Create a key manually through [Google AI Studio](https://aistudio.google.com/apikey).

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

1. Create a Supabase project and apply `database/schema.sql` in its SQL Editor (or run it with a trusted PostgreSQL client).
2. Copy the project's PostgreSQL connection string. Use the direct endpoint when Render can reach it; use Supavisor session mode if the direct endpoint is unreachable over IPv6. SSL is enabled by the backend. For certificate verification, set `DATABASE_SSL_CA` to the project's root CA from Supabase Database Settings. Do not use the browser-facing Supabase anon key.
3. Create a Render Web Service for the `backend` directory. Use `npm install` for build setup if Render does not install automatically, `npm run build` as the build command, and `npm start` as the start command.
4. Configure `NODE_ENV=production`, `DATABASE_URL`, `FRONTEND_ORIGIN`, `GEMINI_API_KEY`, and `GEMINI_MODEL` in Render. `DATABASE_SSL_CA` is optional. Render supplies `PORT`.
5. Deploy the frontend separately and set `NEXT_PUBLIC_API_BASE_URL` to the Render service URL before building it. Set the backend's `FRONTEND_ORIGIN` to the deployed frontend origin and redeploy the backend.
6. Check `GET /health`, then exercise call creation, stage saves, closure, and summary generation. Health reports the active persistence mode but does not replace a workflow check.

No remote database, service, or deployment has been configured by these local changes.

## Known limitations

- No authentication or multi-user permission model yet
- Local JSON persistence is not shared across backend instances and is only intended for development; use PostgreSQL in production
- AI summaries depend on provider availability unless the local fallback is used
- Telephony, transcription, and CRM integrations remain out of scope for the MVP

## Demo workflow

1. Open the dashboard
2. Start a new call
3. Complete the eight stages
4. Save notes while navigating
5. Reopen the call after refresh
6. Close the call and record a final outcome
7. Generate and review the summary

## Assessment demo

The app is designed to demonstrate a complete call flow from creation through final review and summary generation, with durable saved records and a clear review page. The repository is public-facing and ready for deployment documentation and video submission.
