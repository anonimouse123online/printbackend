CREATE TYPE "DocumentScanStatus" AS ENUM ('QUARANTINED', 'AVAILABLE', 'REJECTED', 'EXPIRED');

ALTER TABLE "document_files"
  ADD COLUMN "scan_status" "DocumentScanStatus" NOT NULL DEFAULT 'QUARANTINED',
  ADD COLUMN "scanned_at" TIMESTAMP(3);

CREATE INDEX "document_files_scan_status_expires_at_idx"
  ON "document_files"("scan_status", "expires_at");
