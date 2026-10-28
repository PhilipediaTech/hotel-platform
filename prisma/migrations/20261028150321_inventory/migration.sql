-- CreateTable
CREATE TABLE "room_type_inventory" (
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "capacity" INTEGER NOT NULL,
    "out_of_order" INTEGER NOT NULL DEFAULT 0,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "overbook_limit" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "room_type_inventory_pkey" PRIMARY KEY ("property_id","room_type_id","date")
);

-- AddForeignKey
ALTER TABLE "room_type_inventory" ADD CONSTRAINT "room_type_inventory_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_type_inventory" ADD CONSTRAINT "room_type_inventory_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-040; tab 3 SQL 2) ──────────────────────────────

-- Inventory can never go past capacity + overbooking.
ALTER TABLE "room_type_inventory"
  ADD CONSTRAINT "inventory_within_capacity"
    CHECK (sold + held + out_of_order <= capacity + overbook_limit AND sold >= 0 AND held >= 0),
  ADD CONSTRAINT "inventory_counts_check"
    CHECK (capacity >= 0 AND out_of_order BETWEEN 0 AND capacity AND overbook_limit BETWEEN 0 AND 50);
