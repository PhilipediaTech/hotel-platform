-- AlterTable
ALTER TABLE "room_allocations" ADD COLUMN     "ends_at" TIMESTAMPTZ(6),
ADD COLUMN     "starts_at" TIMESTAMPTZ(6);


-- Day-use (T-052): a day-use stay holds its room for hours, not nights. Overnight rows keep the
-- night rule; day-use rows never overlap in time; the two kinds do not collide, so a room is
-- sold for the day and again for the night (the app refuses a day-use while a guest stays
-- through that day).
ALTER TABLE "room_allocations" DROP CONSTRAINT "room_allocations_no_overlap";
ALTER TABLE "room_allocations"
  ADD CONSTRAINT "room_allocations_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  ) WHERE ("active" AND "starts_at" IS NULL);
ALTER TABLE "room_allocations"
  ADD CONSTRAINT "room_allocations_day_use_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("active" AND "starts_at" IS NOT NULL);
ALTER TABLE "room_allocations"
  ADD CONSTRAINT "room_allocations_times_check" CHECK (
    ("starts_at" IS NULL AND "ends_at" IS NULL)
    OR ("ends_at" > "starts_at" AND "end_date" = "start_date" + 1));

-- A day-use stay has its hours and no nights; an overnight stay has no hours.
ALTER TABLE "stays"
  ADD CONSTRAINT "stays_day_use_check" CHECK (
    ("is_day_use" AND "day_use_start" IS NOT NULL AND "day_use_end" > "day_use_start"
      AND "departure" = "arrival")
    OR (NOT "is_day_use" AND "day_use_start" IS NULL AND "day_use_end" IS NULL));
