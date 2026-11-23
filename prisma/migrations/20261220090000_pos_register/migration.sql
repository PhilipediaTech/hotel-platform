
-- CreateTable
CREATE TABLE "pos_orders" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "opened_by_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),
    "settled_by_id" UUID,
    "settled_shift_id" UUID,
    "folio_id" UUID,
    "stay_id" UUID,
    "signature_file_id" UUID,
    "total_minor" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "revenue_code_id" UUID NOT NULL,
    "note" TEXT,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_orders_property_id_outlet_id_status_idx" ON "pos_orders"("property_id", "outlet_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_property_id_number_key" ON "pos_orders"("property_id", "number");

-- CreateIndex
CREATE INDEX "pos_order_lines_order_id_idx" ON "pos_order_lines"("order_id");

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_settled_shift_id_fkey" FOREIGN KEY ("settled_shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_settled_by_id_fkey" FOREIGN KEY ("settled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_stay_id_fkey" FOREIGN KEY ("stay_id") REFERENCES "stays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_signature_file_id_fkey" FOREIGN KEY ("signature_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_revenue_code_id_fkey" FOREIGN KEY ("revenue_code_id") REFERENCES "revenue_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules (T-142).
-- An outlet shift is a cashier shift with its outlet (tab 3 cashier_shifts.outletId): one open
-- per cashier and outlet, and always someone's.
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_outlet_user_check" CHECK (
  "outlet_id" IS NULL OR "user_id" IS NOT NULL);
CREATE UNIQUE INDEX "cashier_shifts_one_open_outlet" ON "cashier_shifts" ("property_id", "user_id", "outlet_id")
  WHERE "status" = 'OPEN' AND "outlet_id" IS NOT NULL;

ALTER TABLE "pos_orders"
  ADD CONSTRAINT "pos_orders_status_check" CHECK (
    "status" IN ('OPEN', 'PAID', 'ROOM_CHARGED', 'CANCELLED')),
  ADD CONSTRAINT "pos_orders_label_check" CHECK (length("label") BETWEEN 1 AND 40),
  ADD CONSTRAINT "pos_orders_closed_check" CHECK (
    ("status" = 'OPEN') = ("settled_at" IS NULL AND "settled_by_id" IS NULL)),
  -- A settled order has its folio, total and the shift it was settled on.
  ADD CONSTRAINT "pos_orders_settled_check" CHECK (
    ("status" IN ('PAID', 'ROOM_CHARGED')) =
    ("folio_id" IS NOT NULL AND "total_minor" IS NOT NULL AND "settled_shift_id" IS NOT NULL)),
  -- M8-03: a room charge names the stay and carries the guest's signature.
  ADD CONSTRAINT "pos_orders_room_check" CHECK (
    ("status" = 'ROOM_CHARGED') = ("stay_id" IS NOT NULL AND "signature_file_id" IS NOT NULL)),
  ADD CONSTRAINT "pos_orders_total_check" CHECK ("total_minor" IS NULL OR "total_minor" >= 0);

ALTER TABLE "pos_order_lines"
  ADD CONSTRAINT "pos_order_lines_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99),
  ADD CONSTRAINT "pos_order_lines_price_check" CHECK ("unit_price_minor" >= 0);
