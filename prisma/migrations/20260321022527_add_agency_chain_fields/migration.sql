-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "agency_name" TEXT,
ADD COLUMN     "chain_reason" TEXT,
ADD COLUMN     "is_agency_managed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_national_chain" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "leads_is_agency_managed_idx" ON "leads"("is_agency_managed");

-- CreateIndex
CREATE INDEX "leads_is_national_chain_idx" ON "leads"("is_national_chain");
