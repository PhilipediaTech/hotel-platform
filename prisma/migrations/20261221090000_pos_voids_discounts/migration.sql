-- AlterTable
ALTER TABLE "pos_order_lines" ADD COLUMN     "discount_approval_request_id" UUID,
ADD COLUMN     "discount_minor" BIGINT,
ADD COLUMN     "discount_reason" TEXT,
ADD COLUMN     "discounted_at" TIMESTAMPTZ(6),
ADD COLUMN     "discounted_by_id" UUID,
ADD COLUMN     "void_approval_request_id" UUID,
ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_at" TIMESTAMPTZ(6),
ADD COLUMN     "voided_by_id" UUID;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_discounted_by_id_fkey" FOREIGN KEY ("discounted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules (T-143, PRD M8-04).
-- A voided item stays on the order with who voided it, when and why.
ALTER TABLE "pos_order_lines"
  ADD CONSTRAINT "pos_order_lines_void_check" CHECK (
    ("voided_at" IS NULL) = ("voided_by_id" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    AND ("void_approval_request_id" IS NULL OR "voided_at" IS NOT NULL)),
  ADD CONSTRAINT "pos_order_lines_void_reason_check" CHECK (
    "void_reason" IS NULL OR length(btrim("void_reason")) BETWEEN 1 AND 500),
  -- A discount is more than nothing and has who gave it, when and why.
  ADD CONSTRAINT "pos_order_lines_discount_check" CHECK (
    ("discount_minor" IS NULL) = ("discounted_by_id" IS NULL)
    AND ("discount_minor" IS NULL) = ("discount_reason" IS NULL)
    AND ("discount_minor" IS NULL) = ("discounted_at" IS NULL)
    AND ("discount_approval_request_id" IS NULL OR "discount_minor" IS NOT NULL)
    AND ("discount_minor" IS NULL OR "discount_minor" > 0)),
  ADD CONSTRAINT "pos_order_lines_discount_reason_check" CHECK (
    "discount_reason" IS NULL OR length(btrim("discount_reason")) BETWEEN 1 AND 500);

-- M8-04: voids and discounts above the cashier's limit need approval. New properties get
-- these policies when they are created; these are the ones that already exist.
INSERT INTO "approval_policies" ("id", "organisation_id", "property_id", "action", "approver_role_ids", "expiry_minutes")
SELECT gen_random_uuid(), p."organisation_id", p."id", a."action",
       COALESCE((SELECT array_agg(r."id") FROM "roles" r
                 WHERE r."organisation_id" = p."organisation_id"
                   AND r."name" IN ('Owner', 'General Manager')), '{}'),
       30
FROM "properties" p CROSS JOIN (VALUES ('pos.void'), ('pos.discount')) AS a("action")
ON CONFLICT ("property_id", "action") DO NOTHING;
