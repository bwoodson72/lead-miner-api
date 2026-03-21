-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "business_name" TEXT,
    "landing_page_url" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "ad_source" TEXT NOT NULL DEFAULT 'local_organic',
    "lighthouse_score" INTEGER NOT NULL,
    "lcp" INTEGER NOT NULL,
    "cls" DOUBLE PRECISION,
    "tbt" INTEGER,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "contact_page_url" TEXT,
    "enrichment_status" TEXT,
    "enrichment_notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "outreach_count" INTEGER NOT NULL DEFAULT 0,
    "last_outreach_date" TIMESTAMP(3),
    "notes" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_domain_key" ON "leads"("domain");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_lighthouse_score_idx" ON "leads"("lighthouse_score");

