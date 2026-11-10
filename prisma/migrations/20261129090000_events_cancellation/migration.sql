-- AlterTable
ALTER TABLE "event_bookings" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancellation_fee_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6);


-- T-121b: a cancelled event gives its space back (it is outside event_bookings_no_overlap).
ALTER TABLE "event_bookings" DROP CONSTRAINT "event_bookings_status_check";
ALTER TABLE "event_bookings"
  ADD CONSTRAINT "event_bookings_status_check" CHECK ("status" IN ('HOLD', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'CLOSED', 'CANCELLED')),
  ADD CONSTRAINT "event_bookings_cancellation_fee_check" CHECK ("cancellation_fee_minor" >= 0);
