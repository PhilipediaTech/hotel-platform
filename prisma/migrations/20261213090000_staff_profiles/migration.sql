-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "department_id" UUID,
    "job_title" TEXT NOT NULL,
    "manager_id" UUID,
    "employment_type" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "pay_rate_minor" BIGINT,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "emergency_relation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_certifications" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "reference" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "reminded_for" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_profiles_property_id_status_idx" ON "staff_profiles"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_property_id_number_key" ON "staff_profiles"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_property_id_user_id_key" ON "staff_profiles"("property_id", "user_id");

-- CreateIndex
CREATE INDEX "staff_certifications_staff_id_idx" ON "staff_certifications"("staff_id");

-- CreateIndex
CREATE INDEX "staff_certifications_expires_on_idx" ON "staff_certifications"("expires_on");

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_certifications" ADD CONSTRAINT "staff_certifications_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rules (T-136).
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_employment_type_check" CHECK (
  "employment_type" IN ('MONTHLY_SALARY', 'DAILY_PAID', 'HOURLY', 'CONTRACTOR')
);
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_status_check" CHECK (
  ("status" = 'ACTIVE' AND "end_date" IS NULL) OR ("status" = 'LEFT' AND "end_date" IS NOT NULL)
);
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_dates_check" CHECK (
  "end_date" IS NULL OR "end_date" >= "start_date"
);
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_number_check" CHECK ("number" > 0);
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_pay_check" CHECK (
  "pay_rate_minor" IS NULL OR "pay_rate_minor" >= 0
);
ALTER TABLE "staff_certifications" ADD CONSTRAINT "staff_certifications_dates_check" CHECK (
  "issued_on" IS NULL OR "expires_on" IS NULL OR "expires_on" >= "issued_on"
);
