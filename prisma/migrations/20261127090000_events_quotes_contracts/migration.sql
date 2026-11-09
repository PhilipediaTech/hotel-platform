-- AlterTable
ALTER TABLE "event_bookings" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "confirmed_by_override" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "event_quotes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_quote_versions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_quote_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_contracts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "quote_version_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "client_name" TEXT NOT NULL,
    "client_email" TEXT NOT NULL,
    "client_phone" TEXT NOT NULL,
    "terms" TEXT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "damage_deposit_minor" BIGINT NOT NULL DEFAULT 0,
    "issued_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "signed_by_name" TEXT,
    "signed_on" DATE,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_payment_schedules" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "event_payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_deposits" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "schedule_id" UUID,
    "payment_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "event_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_quotes_booking_id_key" ON "event_quotes"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_quote_versions_quote_id_version_key" ON "event_quote_versions"("quote_id", "version");

-- CreateIndex
CREATE INDEX "event_contracts_booking_id_idx" ON "event_contracts"("booking_id");

-- CreateIndex
CREATE INDEX "event_contracts_folio_id_idx" ON "event_contracts"("folio_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_contracts_property_id_number_key" ON "event_contracts"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "event_payment_schedules_contract_id_sequence_key" ON "event_payment_schedules"("contract_id", "sequence");

-- CreateIndex
CREATE INDEX "event_deposits_contract_id_idx" ON "event_deposits"("contract_id");

-- CreateIndex
CREATE INDEX "event_deposits_payment_id_idx" ON "event_deposits"("payment_id");

-- AddForeignKey
ALTER TABLE "event_quotes" ADD CONSTRAINT "event_quotes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_quotes" ADD CONSTRAINT "event_quotes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "event_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_quote_versions" ADD CONSTRAINT "event_quote_versions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_quote_versions" ADD CONSTRAINT "event_quote_versions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "event_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_quote_versions" ADD CONSTRAINT "event_quote_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_contracts" ADD CONSTRAINT "event_contracts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_contracts" ADD CONSTRAINT "event_contracts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "event_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_contracts" ADD CONSTRAINT "event_contracts_quote_version_id_fkey" FOREIGN KEY ("quote_version_id") REFERENCES "event_quote_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_contracts" ADD CONSTRAINT "event_contracts_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_contracts" ADD CONSTRAINT "event_contracts_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_payment_schedules" ADD CONSTRAINT "event_payment_schedules_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_payment_schedules" ADD CONSTRAINT "event_payment_schedules_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "event_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deposits" ADD CONSTRAINT "event_deposits_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deposits" ADD CONSTRAINT "event_deposits_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "event_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deposits" ADD CONSTRAINT "event_deposits_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "event_payment_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deposits" ADD CONSTRAINT "event_deposits_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M9-05: one live contract per booking; a replaced or voided one stays for the record.
CREATE UNIQUE INDEX "event_contracts_one_live" ON "event_contracts" ("booking_id")
  WHERE "status" IN ('ISSUED', 'SIGNED');

ALTER TABLE "event_quote_versions"
  ADD CONSTRAINT "event_quote_versions_total_check" CHECK ("net_minor" >= 0 AND "tax_minor" >= 0 AND "total_minor" = "net_minor" + "tax_minor");
ALTER TABLE "event_contracts"
  ADD CONSTRAINT "event_contracts_status_check" CHECK ("status" IN ('ISSUED', 'SIGNED', 'SUPERSEDED', 'VOID')),
  ADD CONSTRAINT "event_contracts_amounts_check" CHECK ("total_minor" > 0 AND "damage_deposit_minor" >= 0);
ALTER TABLE "event_payment_schedules"
  ADD CONSTRAINT "event_payment_schedules_kind_check" CHECK ("kind" IN ('DEPOSIT', 'INSTALMENT', 'DAMAGE_DEPOSIT')),
  ADD CONSTRAINT "event_payment_schedules_paid_check" CHECK ("amount_minor" > 0 AND "paid_minor" >= 0 AND "paid_minor" <= "amount_minor");
ALTER TABLE "event_deposits"
  ADD CONSTRAINT "event_deposits_kind_check" CHECK ("kind" IN ('DEPOSIT', 'INSTALMENT', 'DAMAGE_DEPOSIT', 'UNALLOCATED')),
  ADD CONSTRAINT "event_deposits_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "event_deposits_schedule_check" CHECK (("schedule_id" IS NULL) = ("kind" = 'UNALLOCATED'));

-- M9-06: confirming without the contract or deposit needs approval. New properties get this
-- policy when they are created; these are the ones that already exist.
INSERT INTO "approval_policies" ("id", "organisation_id", "property_id", "action", "approver_role_ids", "expiry_minutes")
SELECT gen_random_uuid(), p."organisation_id", p."id", 'event.confirm',
       COALESCE((SELECT array_agg(r."id") FROM "roles" r
                 WHERE r."organisation_id" = p."organisation_id"
                   AND r."name" IN ('Owner', 'General Manager')), '{}'),
       2880
FROM "properties" p
ON CONFLICT ("property_id", "action") DO NOTHING;
