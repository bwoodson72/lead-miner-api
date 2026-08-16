# Lead Miner API

Express/TypeScript backend for Lead Miner. It discovers businesses, analyzes mobile website performance, enriches contact data, persists leads in PostgreSQL, runs AI research and qualification, generates outreach, sends through Gmail, manages follow-ups, syncs replies, and records CRM/analytics history.

Pairs with the Next.js `bwoodson72/lead-miner` operator UI.

## Setup

```sh
npm install
cp .env.example .env
npm run dev
```

Run database migrations after pulling schema changes:

```sh
npm run db:migrate
```

## Environment variables

- `SERPER_API_KEY` — local/organic business discovery
- `SERPAPI_KEY` — paid Google Ads discovery when configured
- `PAGESPEED_API_KEY` — PageSpeed Insights
- `DATABASE_URL` — PostgreSQL connection
- `OPENAI_API_KEY` — AI research, drafting, follow-ups, and reply classification
- `GMAIL_CLIENT_ID` — Google OAuth client ID
- `GMAIL_CLIENT_SECRET` — Google OAuth client secret
- `GMAIL_REFRESH_TOKEN` — Google OAuth refresh token
- `CRON_SECRET` — protects automation/cron endpoints
- `AUTOMATION_ENABLED` — enables scheduled non-send automation
- `AUTOMATION_SEND_ENABLED` — independently enables automated email transmission
- `ALLOWED_ORIGINS` — comma-separated frontend URLs, default `http://localhost:3000`
- `PORT` — server port, default `3001`

Lead-search output is persisted directly in PostgreSQL. There is no emailed lead report and no report-recipient configuration.

## Lead discovery flow

1. **Search** — discover local businesses and paid-ad landing pages.
2. **Deduplicate** — normalize and deduplicate by business domain.
3. **Analyze** — run mobile PageSpeed analysis.
4. **Filter** — retain sites matching the configured performance criteria.
5. **Enrich** — gather business/contact data and agency/chain signals.
6. **Persist** — create or update the canonical lead in PostgreSQL.
7. **Research** — when enabled and contactable, run structured AI research and qualification.
8. **Draft** — generate evidence-backed outreach according to the configured approval policy.

Search results remain available through the database-backed lead/dashboard APIs and frontend.

## Outreach and replies

Gmail / Google Workspace is the sole email transport. The backend stores exact outbound content, provider message/thread IDs, send attempts, follow-up state, replies, classifications, suppressions, AI jobs, and activity history.

Sending remains protected by deterministic eligibility checks, suppression, daily caps, send windows, locks, idempotency, and the independent `AUTOMATION_SEND_ENABLED` production switch.

## Useful endpoints

- `POST /api/run-lead-search` — start a lead-search job
- `GET /api/jobs/:id` — inspect search-job progress/results
- `GET /api/leads` — list/filter persisted leads
- `GET /api/leads/:id/detail` — aggregate lead CRM view
- `POST /api/leads/:id/research` — run/re-run research
- `GET /api/outreach/review` — outreach review queue
- `POST /api/inbox/sync` — sync Gmail replies
- `GET /api/inbox/actions` — replies requiring attention
- `GET /api/analytics/summary` — outreach/AI analytics
- `GET /api/automation/status` — automation queue/status
- `POST /api/automation/tick` — run the protected automation cycle
- `GET /health` — process health

## Validation

```sh
npm run check
```

This runs the backend test suite and TypeScript build.
