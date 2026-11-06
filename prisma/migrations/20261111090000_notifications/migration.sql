-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "provider_template_name" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "property_id" UUID,
    "channel" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organisation_id_code_channel_language_key" ON "message_templates"("organisation_id", "code", "channel", "language");

-- CreateIndex
CREATE INDEX "notification_deliveries_provider_ref_idx" ON "notification_deliveries"("provider_ref");

-- CreateIndex
CREATE INDEX "notification_deliveries_property_id_created_at_idx" ON "notification_deliveries"("property_id", "created_at");

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- T-024: the values tab 3 lists in comments.
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_channel"
  CHECK ("channel" IN ('EMAIL', 'WHATSAPP', 'SMS'));
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_language"
  CHECK ("language" ~ '^[a-z]{2}$');
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel"
  CHECK ("channel" IN ('EMAIL', 'WHATSAPP', 'SMS'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_status"
  CHECK ("status" IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts"
  CHECK ("attempts" >= 0);
