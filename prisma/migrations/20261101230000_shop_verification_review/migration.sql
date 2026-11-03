-- Persist the outcome and reviewer for each administrator shop review.
ALTER TABLE "printing_shops"
  ADD COLUMN "verification_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "verification_reviewer_id" TEXT,
  ADD COLUMN "verification_notes" TEXT;

ALTER TABLE "printing_shops"
  ADD CONSTRAINT "printing_shops_verification_reviewer_id_fkey"
  FOREIGN KEY ("verification_reviewer_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
