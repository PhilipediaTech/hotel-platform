-- CreateTable
CREATE TABLE "id_documents" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "doc_type" TEXT,
    "number_enc" BYTEA,
    "expiry" DATE,
    "file_id" UUID,
    "purge_after" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_issues" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "issued_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returned_at" TIMESTAMPTZ(6),

    CONSTRAINT "key_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_cards" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "id_document_id" UUID,
    "data" JSONB NOT NULL,
    "file_id" UUID,
    "signed_at" TIMESTAMPTZ(6) NOT NULL,
    "signed_by_id" UUID,

    CONSTRAINT "registration_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "id_documents_property_id_purge_after_idx" ON "id_documents"("property_id", "purge_after");

-- CreateIndex
CREATE INDEX "id_documents_guest_id_idx" ON "id_documents"("guest_id");

-- CreateIndex
CREATE INDEX "key_issues_stay_id_idx" ON "key_issues"("stay_id");

-- CreateIndex
CREATE UNIQUE INDEX "registration_cards_stay_id_key" ON "registration_cards"("stay_id");

-- CreateIndex
CREATE UNIQUE INDEX "registration_cards_property_id_stay_id_key" ON "registration_cards"("property_id", "stay_id");

-- AddForeignKey
ALTER TABLE "id_documents" ADD CONSTRAINT "id_documents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_documents" ADD CONSTRAINT "id_documents_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_documents" ADD CONSTRAINT "id_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_issues" ADD CONSTRAINT "key_issues_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_issues" ADD CONSTRAINT "key_issues_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_issues" ADD CONSTRAINT "key_issues_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_id_document_id_fkey" FOREIGN KEY ("id_document_id") REFERENCES "id_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_cards" ADD CONSTRAINT "registration_cards_signed_by_id_fkey" FOREIGN KEY ("signed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At least one key per log line.
ALTER TABLE "key_issues" ADD CONSTRAINT "key_issues_count_check" CHECK ("count" > 0);

-- A guest in the house has a room and a check-in time.
ALTER TABLE "stays" ADD CONSTRAINT "stays_checked_in_check"
  CHECK ("status" <> 'CHECKED_IN' OR ("room_id" IS NOT NULL AND "checked_in_at" IS NOT NULL));
