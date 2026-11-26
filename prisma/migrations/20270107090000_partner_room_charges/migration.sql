-- Partner room charges (T-167): an outside POS posts to a guest's room with its own check
-- number. The key and check number are the charge line's source; one posting per check.

-- A key may now hold pos:charge.
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_check";
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_scopes_check" CHECK (
    cardinality("scopes") >= 1
    AND "scopes" <@ ARRAY['availability:read', 'reservations:read', 'guests:read', 'folios:read', 'pos:charge']::text[]
  );

-- The same check number from the same key posts once.
CREATE UNIQUE INDEX "folio_lines_partner_source_key" ON "folio_lines" ("property_id", "source_id")
  WHERE "source_type" = 'PARTNER';
ALTER TABLE "folio_lines"
  ADD CONSTRAINT "folio_lines_partner_source_check" CHECK (
    "source_type" IS DISTINCT FROM 'PARTNER' OR ("source_id" IS NOT NULL AND "kind" = 'CHARGE')
  );
