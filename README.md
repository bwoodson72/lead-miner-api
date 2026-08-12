# Lead Miner API

Express API server that discovers businesses with slow websites by combining Serper local-business discovery with SerpApi paid Google Ads discovery, analyzing mobile performance with PageSpeed Insights, and emailing a lead report.

Pairs with a Next.js frontend. Deploy free on Render.

## Setup

npm install
cp .env.example .env
# Fill in your API keys
npm run dev

## Environment Variables

- SERPER_API_KEY — from serper.dev; used for organic/local business discovery
- SERPAPI_KEY — from serpapi.com; used for paid Google Ads discovery via the `google_ads` engine
- PAGESPEED_API_KEY — from Google Cloud Console
- RESEND_API_KEY — from resend.com
- REPORT_EMAIL — default recipient email
- CRON_SECRET — (optional) protects /api/cron
- ALLOWED_ORIGINS — comma-separated frontend URLs (default: http://localhost:3000)
- PORT — server port (default: 3001)

## API Endpoints

- POST /api/run-lead-search — runs the full pipeline
- GET /api/cron — runs with default keywords (for scheduled triggers)
- GET /health — health check

## Deploy to Render

1. Push to GitHub
2. Create a Web Service on render.com
3. Build Command: npm install && npm run build
4. Start Command: npm run start
5. Add environment variables, including both `SERPER_API_KEY` and `SERPAPI_KEY`
6. Set ALLOWED_ORIGINS to your frontend URL

Free tier sleeps after 15 min inactivity. First request after sleep can be slower.

## Lead Discovery Flow

1. **Organic/local discovery** — Query Serper Places for businesses matching each keyword.
2. **Paid-ad discovery** — Query SerpApi `engine=google_ads` for paid Google Search ads using the requested location or a city/state inferred from Serper local results.
3. **Merge** — Deduplicate by destination domain. If the same business appears organically and as an advertiser, `paid_ad` wins and the real paid landing page is preserved.
4. **Filter** — Remove known franchises.
5. **Analyze** — Run PageSpeed Insights mobile audits. Paid advertisers are prioritized before organic businesses when `maxDomains` caps the queue.
6. **Identify Slow Sites** — Apply the configured performance thresholds.
7. **Enrich** — Extract business/contact information from qualifying sites.
8. **Save** — Create or update lead records in the database, including `adSource` and the keyword that found the lead.
9. **Email Report** — Send the lead summary via Resend.

### Paid Ads Notes

- Standard Google Search ads returned by SerpApi are marked `paid_ad`.
- The actual advertiser landing-page URL is sent to PageSpeed Insights.
- Google Local Services Ads are currently detected in the SerpApi response but skipped because their returned links point to Google Local Services rather than directly to an advertiser website.
- If `SERPAPI_KEY` is not configured, the pipeline continues with organic/local discovery only and logs that paid-ad discovery was skipped.

## Lead Data

Lead records include:

- `domain`
- `businessName`
- `landingPageUrl`
- `keyword`
- `adSource` — `paid_ad` or `local_organic`
- PageSpeed metrics
- email, phone, address, and contact-page data when enrichment succeeds
- agency/chain flags
- timestamps and outreach status
