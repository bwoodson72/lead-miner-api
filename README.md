# Lead Miner API

Express API server that discovers businesses with slow websites by searching Google for local businesses via SerpApi, analyzing their mobile performance with PageSpeed Insights, and emailing a lead report.

Pairs with a Next.js frontend. Deploy free on Render.

## Setup

npm install
cp .env.example .env
# Fill in your API keys
npm run dev

## Environment Variables

- SERPAPI_KEY — from serpapi.com
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
5. Add environment variables
6. Set ALLOWED_ORIGINS to your frontend URL

Free tier sleeps after 15 min inactivity. First request after sleep takes ~60s. No timeout limits on pipeline execution.
