-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "follow_up_date" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_follow_up_date_idx" ON "leads"("follow_up_date");
