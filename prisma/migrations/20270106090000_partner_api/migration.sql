-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secret_enc" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" BIGINT,
    "event_type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_token_hash_key" ON "api_keys"("token_hash");

-- CreateIndex
CREATE INDEX "api_keys_property_id_idx" ON "api_keys"("property_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_property_id_idx" ON "webhook_endpoints"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_property_id_id_key" ON "webhook_endpoints"("property_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_property_id_created_at_idx" ON "webhook_deliveries"("property_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_event_id_key" ON "webhook_deliveries"("endpoint_id", "event_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_property_id_endpoint_id_fkey" FOREIGN KEY ("property_id", "endpoint_id") REFERENCES "webhook_endpoints"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "api_keys_scopes_check" CHECK (
    cardinality("scopes") >= 1
    AND "scopes" <@ ARRAY['availability:read', 'reservations:read', 'guests:read', 'folios:read']::text[]
  ),
  ADD CONSTRAINT "api_keys_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by_id" IS NULL));
ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_url_check" CHECK ("url" ~ '^https?://' AND length("url") <= 500),
  ADD CONSTRAINT "webhook_endpoints_events_check" CHECK (cardinality("events") >= 1);
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('PENDING', 'DELIVERED', 'FAILED')),
  ADD CONSTRAINT "webhook_deliveries_pending_check" CHECK (("status" = 'PENDING') = ("next_attempt_at" IS NOT NULL)),
  ADD CONSTRAINT "webhook_deliveries_delivered_check" CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)),
  ADD CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("attempts" >= 0);

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_endpoints"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
