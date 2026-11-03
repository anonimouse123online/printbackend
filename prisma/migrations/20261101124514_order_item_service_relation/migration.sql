-- AlterTable
ALTER TABLE "print_order_items" ADD COLUMN     "service_id" TEXT;

-- AddForeignKey
ALTER TABLE "print_order_items" ADD CONSTRAINT "print_order_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "shop_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
