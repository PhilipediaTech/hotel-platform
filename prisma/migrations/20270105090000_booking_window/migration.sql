-- AlterTable
ALTER TABLE "rate_days" ADD COLUMN     "max_advance_days" INTEGER,
ADD COLUMN     "min_advance_days" INTEGER;

-- Rules the application keeps, kept by the database too.
ALTER TABLE "rate_days"
  ADD CONSTRAINT "rate_days_advance_check" CHECK (
    ("min_advance_days" IS NULL OR "min_advance_days" BETWEEN 0 AND 730)
    AND ("max_advance_days" IS NULL OR "max_advance_days" BETWEEN 0 AND 730)
    AND ("min_advance_days" IS NULL OR "max_advance_days" IS NULL OR "min_advance_days" <= "max_advance_days")
  );
