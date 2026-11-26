-- Future reservations from the old system (T-169): import_jobs accepts the RESERVATIONS kind.
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_kind_check";
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_kind_check"
    CHECK (kind IN ('ROOMS', 'RATES', 'GUESTS', 'COMPANIES', 'BALANCES', 'RESERVATIONS'));
