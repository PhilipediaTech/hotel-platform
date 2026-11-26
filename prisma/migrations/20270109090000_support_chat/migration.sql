-- In-app support chat (Versions V2 "enhanced onboarding, support tooling"; T-170; Philip,
-- 2026-11-26): a hotel's staff ask the platform team for help, the team answers from S31, and
-- each hotel group has a named onboarding contact.

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN "onboarding_contact_id" UUID;

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID,
    "opened_by_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "page" TEXT,
    "assigned_admin_id" UUID,
    "hotel_unread" BOOLEAN NOT NULL DEFAULT false,
    "platform_unread" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_response_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "from_platform" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_organisation_id_id_key" ON "support_tickets"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "support_tickets_organisation_id_last_message_at_idx" ON "support_tickets"("organisation_id", "last_message_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_onboarding_contact_id_fkey" FOREIGN KEY ("onboarding_contact_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_organisation_id_ticket_id_fkey" FOREIGN KEY ("organisation_id", "ticket_id") REFERENCES "support_tickets"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules the application keeps, kept by the database too.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_subject_check" CHECK (length(btrim("subject")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "support_tickets_urgency_check" CHECK ("urgency" IN ('NORMAL', 'BLOCKER')),
  ADD CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('OPEN', 'ANSWERED', 'RESOLVED')),
  ADD CONSTRAINT "support_tickets_resolved_check" CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL)),
  ADD CONSTRAINT "support_tickets_page_check" CHECK ("page" IS NULL OR length("page") <= 200);
ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_messages_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000);

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_tickets"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_messages"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
