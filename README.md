# Lead Miner API

Express/TypeScript backend for Lead Miner. It discovers service-business candidates, persists them before expensive qualification, screens website performance, ranks candidates for AI website research, qualifies rebuild opportunities, enriches contact data only for qualified rebuild candidates, generates outreach, sends through Gmail, manages follow-ups, syncs replies, and records CRM/analytics history.

Pairs with the Next.js `bwoodson72/lead-miner` operator UI.

## Setup

```sh
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Production `npm start` runs `prisma migrate deploy` automatically before starting the API, so committed schema migrations are applied before code that depends on them begins serving requests.

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

## Candidate-first pipeline

1. **Discover** — find local service businesses and paid-ad landing pages.
2. **Deduplicate / basic exclusion** — normalize domains and remove deterministic exclusions such as known franchises.
3. **Persist candidate** — save the legitimate candidate before PageSpeed, contact enrichment, or AI research can fail.
4. **Screen website** — run mobile PageSpeed when available and classify performance as `strong`, `moderate`, `none`, or `unknown`. Performance is a research signal, never an admission gate.
5. **Rank research queue** — calculate the canonical stateless research score from acquisition intent, performance signal, screening completeness, listing identity, and capped aging. Email contributes no points.
6. **AI website research** — research screened candidates regardless of whether an email is known and classify them as `rebuild_candidate`, `no_material_opportunity`, or `needs_review`.
7. **Contact enrichment** — only qualified `rebuild_candidate` leads enter automatic email/contact discovery.
8. **Prioritize / select angle / draft** — qualified rebuild candidates with usable contact data proceed into outreach preparation.
9. **Send / follow up / reply handling** — Gmail sending, sequence state, suppression, reply classification, and CRM lifecycle remain protected by deterministic safety rules.

The automation tick preserves this ordering by running research before qualified contact enrichment. Missing, deferred, failed, or exhausted email enrichment cannot suppress website research.

## Pipeline visibility

Useful candidate-pipeline endpoints include:

- `GET /api/pipeline/summary` — research, screening, performance, and post-qualification contact-stage counts
- `GET /api/pipeline/research-queue` — backend-ranked research queue and canonical score breakdown
- `GET /api/leads/:id/pipeline-state` — one lead's research eligibility, queue score, screening state, and contact stage
- `POST /api/leads/:id/research` — run/re-run website research without requiring an email
- `POST /api/leads/bulk-research` — explicit-ID or canonical-queue bulk website research

## Outreach and replies

Gmail / Google Workspace is the sole email transport. The backend stores exact outbound content, provider message/thread IDs, send attempts, follow-up state, replies, classifications, suppressions, AI jobs, and activity history.

Sending remains protected by deterministic eligibility checks, suppression, daily caps, send windows, locks, idempotency, and the independent `AUTOMATION_SEND_ENABLED` production switch. Outreach is limited to qualified custom-rebuild opportunities with a usable recipient; contact-neutral research does not weaken those sending requirements.

## Other useful endpoints

- `POST /api/run-lead-search` — start a candidate search job
- `GET /api/jobs/:id` — inspect search-job progress/results
- `GET /api/leads` — list/filter persisted leads
- `GET /api/leads/:id/detail` — aggregate lead CRM view
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
