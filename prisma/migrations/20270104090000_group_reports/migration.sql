-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "group_currency" CHAR(3);

-- CreateTable
CREATE TABLE "group_exchange_rates" (
    "organisation_id" UUID NOT NULL,
    "from_currency" CHAR(3) NOT NULL,
    "to_currency" CHAR(3) NOT NULL,
    "month" DATE NOT NULL,
    "rate_micros" BIGINT NOT NULL,
    "set_by_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_exchange_rates_pkey" PRIMARY KEY ("organisation_id","from_currency","to_currency","month")
);

-- AddForeignKey
ALTER TABLE "group_exchange_rates" ADD CONSTRAINT "group_exchange_rates_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_exchange_rates" ADD CONSTRAINT "group_exchange_rates_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "organisations"
  ADD CONSTRAINT "organisations_group_currency_check" CHECK ("group_currency" IS NULL OR "group_currency" ~ '^[A-Z]{3}$');
ALTER TABLE "group_exchange_rates"
  ADD CONSTRAINT "group_exchange_rates_rate_check" CHECK ("rate_micros" > 0),
  ADD CONSTRAINT "group_exchange_rates_month_check" CHECK (EXTRACT(DAY FROM "month") = 1),
  ADD CONSTRAINT "group_exchange_rates_currencies_check" CHECK ("from_currency" <> "to_currency");

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "group_exchange_rates" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "group_exchange_rates"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
