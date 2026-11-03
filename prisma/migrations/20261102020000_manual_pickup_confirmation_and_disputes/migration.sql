-- Record authenticated manual pickup completion while preserving historical pickup tokens.
CREATE TYPE "PickupDisputeStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

ALTER TABLE "print_orders"
  ADD COLUMN "pickup_confirmed_by_user_id" TEXT,
  ADD COLUMN "pickup_confirmed_by_role" "UserRole",
  ADD COLUMN "pickup_confirmed_at" TIMESTAMP(3);

ALTER TABLE "print_orders"
  ADD CONSTRAINT "print_orders_pickup_confirmed_by_user_id_fkey"
  FOREIGN KEY ("pickup_confirmed_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "pickup_disputes" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "opened_by_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "PickupDisputeStatus" NOT NULL DEFAULT 'OPEN',
  "reviewed_by_id" TEXT,
  "resolution_notes" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pickup_disputes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "pickup_disputes"
  ADD CONSTRAINT "pickup_disputes_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "print_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pickup_disputes_opened_by_id_fkey"
  FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pickup_disputes_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "pickup_disputes_order_id_key" ON "pickup_disputes"("order_id");
CREATE INDEX "pickup_disputes_status_created_at_idx" ON "pickup_disputes"("status", "created_at");
