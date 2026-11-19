-- AlterTable
ALTER TABLE "attendance_events" ADD COLUMN     "note" TEXT;



-- Rules (T-138a): a manager may add a missed clock, always with a note.
ALTER TABLE "attendance_events" DROP CONSTRAINT "attendance_events_channel_check";
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_channel_check" CHECK (
  "channel" IN ('TABLET', 'PHONE', 'MANUAL')
);
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_note_check" CHECK (
  ("channel" = 'MANUAL') = ("note" IS NOT NULL)
);
