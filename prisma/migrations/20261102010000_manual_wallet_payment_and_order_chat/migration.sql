-- Add private shop wallet details and per-confirmation payment snapshots.
CREATE TYPE "ShopPaymentMethod" AS ENUM ('GCASH', 'MAYA');
CREATE TYPE "PaymentReviewStatus" AS ENUM ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED');

ALTER TABLE "printing_shops"
  ADD COLUMN "payment_qr_storage_key" TEXT,
  ADD COLUMN "payment_method" "ShopPaymentMethod",
  ADD COLUMN "payment_recipient_name" TEXT,
  ADD COLUMN "payment_wallet_number" TEXT;

ALTER TABLE "payments"
  ADD COLUMN "review_status" "PaymentReviewStatus",
  ADD COLUMN "reference_number" TEXT,
  ADD COLUMN "recipient_name_snapshot" TEXT,
  ADD COLUMN "wallet_number_snapshot" TEXT,
  ADD COLUMN "payment_method_snapshot" "ShopPaymentMethod",
  ADD COLUMN "recipient_qr_storage_key" TEXT,
  ADD COLUMN "proof_storage_key" TEXT,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "reviewer_id" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payments_reference_number_key" ON "payments"("reference_number");
CREATE UNIQUE INDEX "payments_proof_storage_key_key" ON "payments"("proof_storage_key");
CREATE INDEX "payments_review_status_created_at_idx" ON "payments"("review_status", "created_at");

CREATE TABLE "order_messages" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "sender_id" TEXT NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_messages"
  ADD CONSTRAINT "order_messages_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "print_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "order_messages_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_messages_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "order_messages_order_id_created_at_idx" ON "order_messages"("order_id", "created_at");
CREATE INDEX "order_messages_recipient_id_read_at_created_at_idx" ON "order_messages"("recipient_id", "read_at", "created_at");
