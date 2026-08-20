ALTER TABLE "leads"
  ADD COLUMN "discovery_source" TEXT NOT NULL DEFAULT 'search',
  ADD COLUMN "import_batch_id" INTEGER,
  ADD COLUMN "supplied_url" TEXT;

CREATE TABLE "import_batches" (
  "id" SERIAL NOT NULL,
  "source" TEXT NOT NULL,
  "file_name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "ready_rows" INTEGER NOT NULL DEFAULT 0,
  "created_leads" INTEGER NOT NULL DEFAULT 0,
  "existing_rows" INTEGER NOT NULL DEFAULT 0,
  "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
  "invalid_rows" INTEGER NOT NULL DEFAULT 0,
  "franchise_rows" INTEGER NOT NULL DEFAULT 0,
  "screened_leads" INTEGER NOT NULL DEFAULT 0,
  "screening_failures" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_import_batch_id_fkey"
  FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "leads_discovery_source_idx" ON "leads"("discovery_source");
CREATE INDEX "leads_import_batch_id_idx" ON "leads"("import_batch_id");
CREATE INDEX "import_batches_created_at_idx" ON "import_batches"("created_at");
CREATE INDEX "import_batches_status_created_at_idx" ON "import_batches"("status", "created_at");
