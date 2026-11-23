-- Row-level security (T-144; spec tab 2 "Tenancy", tab 3 rule 6; ADR-018): the second
-- tenancy layer under the application's tenant client. The API sets app.property_id and
-- app.organisation_id on each connection it takes from the pool (core/db.ts), from the
-- request's tenant. A row of another tenant is then invisible and can't be written, even by
-- raw SQL. With no tenant set (sign-in, platform, worker sweeps, migrations) the policies
-- let the query through, and the application layer is the guard.
--
-- FORCE: the app connects as the tables' owner, which row-level security skips unless forced.
-- Tables with no tenant column of their own (stay nights, status history, steps, events of
-- a parent) are reached through their scoped parent. Platform tables (subscriptions, support
-- sessions, usage, invoices, partners) are not tenant data and have no policy.

CREATE FUNCTION app_property_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.property_id', true), '')::uuid
$$;

CREATE FUNCTION app_organisation_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.organisation_id', true), '')::uuid
$$;


-- Rows of one property.
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "approval_policies"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "approval_requests"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "ar_accounts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ar_accounts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "ar_allocations" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ar_allocations"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "ar_invoices" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ar_invoices"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "ar_payments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ar_payments"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assets"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "attendance_events" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "attendance_events"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bank_statement_lines"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "booking_engine_settings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "booking_engine_settings"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "business_days" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "business_days"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "cancellation_policies" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cancellation_policies"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "cashier_shifts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cashier_shifts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "checklist_runs" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "checklist_runs"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "checklists" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "checklists"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "commissions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "commissions"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "departments"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "deposit_ledger_entries" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "deposit_ledger_entries"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "duties" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "duties"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_bookings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_bookings"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_briefs" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_briefs"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_contracts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_contracts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_deposits" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_deposits"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_enquiries" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_enquiries"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_payment_schedules" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_payment_schedules"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_quote_versions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_quote_versions"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "event_quotes" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_quotes"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exchange_rates"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "files"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "folio_lines" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "folio_lines"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "folios" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "folios"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "generators" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "generators"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "group_block_nights" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "group_block_nights"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "group_blocks" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "group_blocks"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "guest_links" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guest_links"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "handover_notes" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "handover_notes"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "hk_assignments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "hk_assignments"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "id_documents" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "id_documents"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_jobs"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "inspections" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inspections"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "key_issues" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "key_issues"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "leakage_alerts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leakage_alerts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "leakage_rules" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leakage_rules"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leave_requests"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "lost_found_items" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lost_found_items"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "menu_categories"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "menu_items"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "message_threads" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_threads"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "meter_readings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meter_readings"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "modifiers" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "modifiers"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "night_audit_runs" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "night_audit_runs"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_deliveries"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "online_check_ins" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "online_check_ins"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "outlets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outlets"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "pay_items" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pay_items"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "payment_intents" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_intents"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payments"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "pos_order_lines" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_order_lines"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "pos_orders" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_orders"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "preventive_plans" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "preventive_plans"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promo_codes"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "property_counters" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "property_counters"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotes"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "rate_days" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_days"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "rate_plans" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_plans"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "reconciliation_matches" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reconciliation_matches"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "registration_cards" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "registration_cards"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reservations"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "revenue_codes" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "revenue_codes"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_allocations" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_allocations"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_blocks" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_blocks"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_charge_postings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_charge_postings"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_status_reports" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_status_reports"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_type_inventory" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_type_inventory"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "room_types" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "room_types"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rooms"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "rota_patterns" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rota_patterns"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "service_bookings" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service_bookings"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "services"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "shift_assignments" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shift_assignments"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "space_layouts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "space_layouts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "space_rate_rules" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "space_rate_rules"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "spaces" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "spaces"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "staff_documents" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "staff_documents"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "staff_profiles"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "stay_occupants" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stay_occupants"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "stays" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stays"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "task_templates" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "task_templates"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tasks"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "tax_rules" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tax_rules"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "timesheets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "timesheets"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "unmatched_transfers" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unmatched_transfers"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "virtual_accounts" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "virtual_accounts"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
ALTER TABLE "visitors" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "visitors"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());

-- Rows of the organisation (any of its properties, or none).
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_events"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "companies"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "domain_events" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "domain_events"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "feature_flags"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "guests" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guests"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_templates"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "properties" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "properties"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "roles"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());

-- The organisation itself.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organisations"
  USING (app_organisation_id() IS NULL OR "id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "id" = app_organisation_id());
