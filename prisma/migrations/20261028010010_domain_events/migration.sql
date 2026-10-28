-- CreateTable
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_events_published_at_idx" ON "domain_events"("published_at");

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL (T-021)
-- Event types are `resource.past_tense`, e.g. `reservation.created`.
ALTER TABLE "domain_events"
  ADD CONSTRAINT "domain_events_type_check" CHECK ("type" ~ '^[a-z_]+(\.[a-z_]+)+$');
-- The publisher only ever reads unpublished events, oldest first.
CREATE INDEX "domain_events_unpublished_idx" ON "domain_events" ("id") WHERE "published_at" IS NULL;
