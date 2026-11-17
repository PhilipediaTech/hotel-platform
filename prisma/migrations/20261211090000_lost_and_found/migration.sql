-- CreateTable
CREATE TABLE "lost_found_items" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "valuable" BOOLEAN NOT NULL DEFAULT false,
    "found_at" TIMESTAMPTZ(6) NOT NULL,
    "found_where" TEXT,
    "room_id" UUID,
    "stay_id" UUID,
    "found_by_id" UUID NOT NULL,
    "storage_location" TEXT NOT NULL,
    "custodian_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "keep_until" DATE NOT NULL,
    "returned_to_name" TEXT,
    "returned_to_phone" TEXT,
    "returned_id_note" TEXT,
    "disposal" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lost_found_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_found_events" (
    "id" BIGSERIAL NOT NULL,
    "item_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "storage_location" TEXT,
    "custodian_id" UUID,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_found_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lost_found_items_property_id_status_idx" ON "lost_found_items"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lost_found_items_property_id_number_key" ON "lost_found_items"("property_id", "number");

-- CreateIndex
CREATE INDEX "lost_found_events_item_id_idx" ON "lost_found_events"("item_id");

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_stay_id_fkey" FOREIGN KEY ("stay_id") REFERENCES "stays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_found_by_id_fkey" FOREIGN KEY ("found_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_custodian_id_fkey" FOREIGN KEY ("custodian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_events" ADD CONSTRAINT "lost_found_events_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "lost_found_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_events" ADD CONSTRAINT "lost_found_events_custodian_id_fkey" FOREIGN KEY ("custodian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_events" ADD CONSTRAINT "lost_found_events_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules (T-133).
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_status_check" CHECK (
  ("status" = 'HELD' AND "closed_at" IS NULL AND "disposal" IS NULL AND "returned_to_name" IS NULL)
  OR ("status" = 'RETURNED' AND "closed_at" IS NOT NULL AND "returned_to_name" IS NOT NULL
      AND "returned_id_note" IS NOT NULL AND "disposal" IS NULL)
  OR ("status" = 'DISPOSED' AND "closed_at" IS NOT NULL
      AND "disposal" IN ('DISCARDED', 'DONATED', 'POLICE', 'OTHER'))
);
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_number_check" CHECK ("number" > 0);
ALTER TABLE "lost_found_events" ADD CONSTRAINT "lost_found_events_kind_check" CHECK (
  "kind" IN ('LOGGED', 'CUSTODY', 'RETURNED', 'DISPOSED', 'NOTE')
);

-- The custody trail is append-only.
CREATE TRIGGER lost_found_events_append_only BEFORE UPDATE OR DELETE ON lost_found_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
