-- CreateEnum
CREATE TYPE "session_kind" AS ENUM ('USER', 'DEVICE');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "kind" "session_kind" NOT NULL DEFAULT 'USER';

-- A device session is a top-level shared-device session; user sessions run under it.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_is_top_level_shared"
  CHECK ("kind" = 'USER' OR ("parent_session_id" IS NULL AND "shared_device"));
