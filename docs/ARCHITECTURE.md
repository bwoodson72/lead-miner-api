# Lead Miner architecture and migration workflow

## Source of truth

`lead-miner-api` owns the canonical PostgreSQL schema, Prisma schema, migrations, workflow invariants, automation policy, AI calls, Gmail integration, and CRM state transitions.

`lead-miner` is an operator console. It consumes backend APIs and must not introduce its own Prisma schema, migrations, database client, send policy, follow-up scheduler, or independent status-transition logic.

## Canonical workflow

`DISCOVER -> DEDUPLICATE -> ENRICH -> RESEARCH -> QUALIFY -> PRIORITIZE -> SELECT OUTREACH ANGLE -> GENERATE MESSAGE -> APPROVE/AUTO-SEND -> MONITOR -> FOLLOW UP -> DETECT REPLY -> CLASSIFY INTENT -> HUMAN HANDOFF -> RECORD OUTCOME -> IMPROVE FUTURE DECISIONS`

Research is intentionally stage-pure. `lead-research-v10` evaluates the website as a business/customer-acquisition asset and stores evidence-backed asset findings. It does not choose the prospect's sales priority or outreach angle. Prioritization is deterministic and configurable; outreach-angle selection is a separate evidence-bound AI stage.

## Intentional product-spec supersessions

- Email is Gmail/Google Workspace only. The earlier generalized email-provider abstraction is not part of the current product direction.
- Outreach uses one initial message plus four follow-ups. Follow-up 4 is the terminal breakup message. The default delay policy is `[4, 6, 10, 14]` days and is normalized to eligible business send windows.
- Research v10 uses the business-asset assessment contract instead of the older research-time sales scoring contract.
- Learning analytics query durable CRM/AI history directly for the current single-operator product instead of requiring a separate aggregate cache job.

## Migration workflow

Create and test schema changes in `lead-miner-api` only.

1. Update `prisma/schema.prisma`.
2. Create a new ordered migration under `prisma/migrations/`.
3. Regenerate the backend Prisma client.
4. Run the backend test/build check.
5. Review destructive SQL carefully before applying it to the production database.
6. Apply migrations to the target database before starting backend code that depends on the new schema.
7. Deploy/update the frontend only after the backend API contract it consumes is available.

For this repository's current scripts, the normal local update sequence is:

```bash
npm run db:migrate
npx prisma generate
npm run check
```

The frontend does not run Prisma migrations or generate a Prisma client.

## Operational safety invariants

- Suppression and current lifecycle eligibility are checked again at the backend send boundary.
- Global daily send limits, configured send windows, weekend policy, minimum same-lead intervals, sequence touch caps, scheduled send times, and emergency outreach pause are deterministic backend rules.
- Sends are claimed idempotently before provider delivery and stale/uncertain sends are reconciled before retrying.
- A normal prospect reply stops future automated outreach. Out-of-office replies pause/reschedule rather than being treated as buying replies. `not_now` prospects may enter a deterministic revisit queue.
- Bounce/unsubscribe/spam-or-scam classifications suppress the affected address; bounce also triggers contact re-enrichment.
- AI spend ceilings and concurrency limits gate non-free AI calls.
- Machine-actionable AI outputs are structured and validated before persistence.
- Evidence packet hashes are stored/reused where applicable to avoid paying for identical analysis.
- Activity, message, AI-job, automation-run, and reply history are durable audit data and should not be silently deleted by transient cleanup jobs.

## Automation jobs

The scheduled automation tick orchestrates named jobs rather than embedding their logic in the scheduler:

- `sync_replies`
- `revisit_due`
- `enrich`
- `research`
- `recalculate_priorities`
- `prepare_outreach`
- `reconcile_sends`
- `followups`
- `send_approved`

Every named run writes an `AutomationRun` record with status, processed/succeeded/failed counts, timing, and error summary.
