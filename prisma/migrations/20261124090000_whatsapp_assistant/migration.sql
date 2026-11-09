-- AlterTable
ALTER TABLE "booking_engine_settings" ADD COLUMN     "assistant_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assistant_notes" TEXT;

-- AlterTable
ALTER TABLE "message_threads" ADD COLUMN     "assistant_paused_until" TIMESTAMPTZ(6),
ADD COLUMN     "assistant_run_at" TIMESTAMPTZ(6),
ADD COLUMN     "needs_staff" BOOLEAN NOT NULL DEFAULT false;

