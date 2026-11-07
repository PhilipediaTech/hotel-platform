-- CreateTable
CREATE TABLE "subscriptions" (
    "organisation_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "price_per_room_minor" BIGINT NOT NULL,
    "minimum_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_end" DATE NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("organisation_id")
);

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "active_rooms" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_invoices_organisation_id_period_start_idx" ON "platform_invoices"("organisation_id", "period_start");

-- CreateIndex
CREATE INDEX "support_sessions_organisation_id_started_at_idx" ON "support_sessions"("organisation_id", "started_at");

-- CreateIndex
CREATE INDEX "support_sessions_admin_user_id_expires_at_idx" ON "support_sessions"("admin_user_id", "expires_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- T-100: the values tab 3 lists in comments.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan"
  CHECK ("plan" IN ('ESSENTIALS', 'PROFESSIONAL', 'GROUP'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status"
  CHECK ("status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_amounts"
  CHECK ("price_per_room_minor" >= 0 AND "minimum_minor" >= 0);
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_status"
  CHECK ("status" IN ('ISSUED', 'PAID', 'VOID'));
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_period"
  CHECK ("period_end" >= "period_start" AND "active_rooms" >= 0 AND "total_minor" >= 0);
-- One live invoice per hotel group and period (a voided one may be issued again).
CREATE UNIQUE INDEX "platform_invoices_one_per_period"
  ON "platform_invoices" ("organisation_id", "period_start") WHERE "status" <> 'VOID';
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_window"
  CHECK ("expires_at" > "started_at" AND "expires_at" <= "started_at" + INTERVAL '60 minutes'
         AND length(trim("reason")) >= 10);

-- An issued invoice's amounts never change: only its status moves (ISSUED -> PAID | VOID).
CREATE FUNCTION platform_invoice_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.active_rooms IS DISTINCT FROM OLD.active_rooms
     OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR OLD.status <> 'ISSUED' THEN
    RAISE EXCEPTION 'PLATFORM_INVOICE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_invoices_status_only BEFORE UPDATE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION platform_invoice_status_only();
CREATE TRIGGER platform_invoices_no_delete BEFORE DELETE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
