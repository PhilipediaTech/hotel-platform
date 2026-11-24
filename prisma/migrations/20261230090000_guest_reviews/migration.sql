-- CreateTable
CREATE TABLE "guest_reviews" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rating" INTEGER,
    "comment" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "draft" TEXT,
    "drafted_at" TIMESTAMPTZ(6),
    "reply" TEXT,
    "replied_at" TIMESTAMPTZ(6),
    "replied_by_id" UUID,

    CONSTRAINT "guest_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_reviews_token_hash_key" ON "guest_reviews"("token_hash");

-- CreateIndex
CREATE INDEX "guest_reviews_property_id_requested_at_idx" ON "guest_reviews"("property_id", "requested_at");

-- CreateIndex
CREATE INDEX "guest_reviews_reservation_id_guest_id_idx" ON "guest_reviews"("reservation_id", "guest_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_reviews_property_id_stay_id_key" ON "guest_reviews"("property_id", "stay_id");

-- AddForeignKey
ALTER TABLE "guest_reviews" ADD CONSTRAINT "guest_reviews_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_reviews" ADD CONSTRAINT "guest_reviews_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_reviews" ADD CONSTRAINT "guest_reviews_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_reviews" ADD CONSTRAINT "guest_reviews_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_reviews" ADD CONSTRAINT "guest_reviews_replied_by_id_fkey" FOREIGN KEY ("replied_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "guest_reviews"
  ADD CONSTRAINT "guest_reviews_channel_check" CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
  ADD CONSTRAINT "guest_reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "guest_reviews_submitted_check" CHECK (("rating" IS NULL) = ("submitted_at" IS NULL)),
  ADD CONSTRAINT "guest_reviews_comment_check" CHECK ("comment" IS NULL OR ("rating" IS NOT NULL AND char_length("comment") <= 2000)),
  ADD CONSTRAINT "guest_reviews_replied_check" CHECK (("reply" IS NULL) = ("replied_at" IS NULL) AND ("reply" IS NULL OR ("submitted_at" IS NOT NULL AND char_length("reply") <= 2000))),
  ADD CONSTRAINT "guest_reviews_expiry_check" CHECK ("expires_at" > "requested_at");

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "guest_reviews" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guest_reviews"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
