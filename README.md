# Lead Miner API

Express API server that discovers businesses with slow websites by using Serper for local-business discovery and SerpApi for paid Google Ads discovery, analyzing their mobile performance with PageSpeed Insights, and emailing a lead report.

Pairs with a Next.js frontend. Deploy free on Render.

## Setup

npm install
cp .env.example .env
# Fill in your API keys
npm run dev

## Environment Variables

- SERPER_API_KEY — from serper.dev; used for local/organic business discovery
- SERPAPI_KEY — from serpapi.com; used for paid Google Ads discovery
- PAGESPEED_API_KEY — from Google Cloud Console
- RESEND_API_KEY — from resend.com
- REPORT_EMAIL — default recipient email
- HUBSPOT_ACCESS_TOKEN — private app access token from HubSpot
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
5. Add environment variables, including SERPER_API_KEY and SERPAPI_KEY
6. Set ALLOWED_ORIGINS to your frontend URL

Free tier sleeps after 15 min inactivity. First request after sleep takes ~60s. No timeout limits on pipeline execution.

## Enriched Lead Flow

The pipeline automatically discovers, analyzes, enriches, and pushes leads to HubSpot:

### Pipeline Steps

1. **Search** — Query Serper Places for local businesses and SerpApi `google_ads` for paid Google Search ads. Paid ads preserve the advertiser's actual landing-page URL; when a business appears in both sources, `paid_ad` wins.
2. **Filter** — Deduplicate by domain and filter out known franchises
3. **Analyze** — Run PageSpeed Insights mobile audits (45s timeout per site)
4. **Identify Slow Sites** — Filter sites below performance thresholds
5. **Enrich** — Extract contact info from slow sites:
   - Business name (from `<title>`, `og:site_name`, or `<h1>`)
   - Email addresses (from `mailto:` links and page text)
   - Phone numbers (from `tel:` links and formatted text)
   - Contact page URLs (from internal links)
   - Follows up to 2 contact pages per site (10s timeout each)
6. **Push to HubSpot** — Create/update contacts with enriched data
7. **Email Report** — Send summary via Resend

### Paid Ad Notes

- Standard Google Search ads returned by SerpApi are marked `paid_ad`.
- The actual ad landing page is tested with PageSpeed Insights.
- Google Local Services Ads are currently skipped because the returned links point to Google Local Services rather than directly to the advertiser website.
- If SERPAPI_KEY is not configured, the pipeline continues with local/organic discovery only.

### Data Pushed to HubSpot

**Contact Properties:**
- `website` — domain
- `company` — domain (fallback)
- `lighthouse_score` — performance score (0-100)
- `lcp` — Largest Contentful Paint (ms)
- `cls` — Cumulative Layout Shift
- `tbt` — Total Blocking Time (ms)
- `leadkeyword` — search keyword
- `landing_page_url` — tested URL
- `ad_source` — `paid_ad` or `local_organic`
- `pagespeed_tested_at` — ISO timestamp
- `pagespeed_strategy` — `mobile`
- `pagespeed_report_url` — PageSpeed Insights report URL
- `business_name` — extracted business name
- `contact_page_url` — contact page URL
- `phone` — normalized phone number
- `email` — email address
- `address` — physical address (if available)
- `source_title` — ad/listing title from search results
- `enrichment_status` — `enriched`, `failed`, or `skipped`

**Deal:**
- Created for new contacts only
- Name: `{Business Name} — Score {score}, LCP {lcp}s`
- Description: Full lead summary with all enrichment data
- Stage: New Lead

**Note:**
- Attached to all contacts (new and updated)
- Contains structured lead summary for audit trail

### Contact Matching Priority

HubSpot contact search tries these fields in order:
1. **Email** (exact match) — most reliable
2. **Phone** (exact match) — secondary identifier
3. **Domain** (token match) — fallback

### Required HubSpot Custom Properties

Create these custom contact properties in HubSpot:
- `lighthouse_score` (Number)
- `lcp` (Number)
- `cls` (Number)
- `tbt` (Number)
- `leadkeyword` (Single-line text)
- `landing_page_url` (Single-line text)
- `ad_source` (Single-line text)
- `pagespeed_tested_at` (Single-line text)
- `pagespeed_strategy` (Single-line text)
- `pagespeed_report_url` (Single-line text)
- `business_name` (Single-line text)
- `contact_page_url` (Single-line text)
- `source_title` (Single-line text)
- `enrichment_status` (Single-line text)
