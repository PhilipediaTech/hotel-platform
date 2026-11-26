-- Help centre (Versions V2 "enhanced onboarding, support tooling"; Strategy "published help
-- centre"; T-173; Philip, 2026-11-26): articles the platform team writes for every hotel,
-- plain text, each tied to the app pages it explains. Not a tenant table: the same articles
-- for every group, written only by platform staff.

-- CreateTable
CREATE TABLE "help_articles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "help_articles_slug_key" ON "help_articles"("slug");

-- AddForeignKey
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules the application keeps, kept by the database too.
ALTER TABLE "help_articles"
  ADD CONSTRAINT "help_articles_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 80),
  ADD CONSTRAINT "help_articles_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "help_articles_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 20000),
  ADD CONSTRAINT "help_articles_pages_check" CHECK (cardinality("pages") <= 10);

-- The starter set (Philip: in the migration, so every environment starts with it). Plain
-- text: paragraphs, and lines starting "- " or "1. " shown as lists.
INSERT INTO "help_articles" ("slug", "title", "body", "pages", "published") VALUES
('make-a-booking', 'Make a booking', $$A booking holds one or more rooms for a guest. Rooms themselves are given out later, before arrival.

1. Open New booking.
2. Choose the dates, the room type, the rate plan and the number of guests, then price the stay.
3. Find the guest by name, phone or email, or add a new one.
4. Choose how the booking is guaranteed and add any notes.
5. Confirm. The booking gets its confirmation number at once.

To hold rooms for a guest who has not decided yet, set a hold time: the booking stays tentative and the rooms come back when the hold ends.

A guest flagged do-not-rent needs a manager's approval before the booking goes through.$$, ARRAY['/bookings/new', '/reservations', '/calendar'], true),
('check-a-guest-in', 'Check a guest in', $$Arrivals for today are on the Front desk.

1. Open the arrival.
2. Give the stay a clean room if it has none yet.
3. Complete the registration card and the guest's ID as your hotel asks.
4. Take a deposit or a payment if one is due.
5. Check in. Issue the keys.

If the room is not ready yet, the guest can wait: the room shows as not ready on the board until housekeeping marks it clean.$$, ARRAY['/front-desk'], true),
('check-a-guest-out', 'Check a guest out', $$Departures for today are on the Front desk.

1. Open the departure and look at the bill.
2. Settle what is left: take a payment, or move the balance to the company's city ledger account if the guest's company pays.
3. Check out. Collect the keys.

Check-out warns you about an unpaid balance, open tasks on the room and keys not returned. A late check-out fee is added by your hotel's rules.$$, ARRAY['/front-desk', '/folios'], true),
('take-a-payment', 'Take a payment', $$Payments go on the guest's bill (folio) and into your open cashier shift.

1. Open the bill from the stay or from Folios.
2. Choose Take payment, the method (cash, card on the POS terminal, bank transfer and so on) and the amount.
3. For a card or transfer, enter the terminal or transfer reference so it can be matched later.
4. Save. Print or send the receipt if the guest wants one.

You need an open cashier shift to take payments. Refunds and discounts above your limit go to a manager for approval.$$, ARRAY['/folios'], true),
('cashier-shift', 'Open and close your cashier shift', $$Every payment, refund and paid-out you take belongs to your shift.

1. At the start, open your shift and count the cash float you were given.
2. Work as usual.
3. At the end, count the cash in your drawer and close the shift.

If the count differs from what the shift expected, explain the difference. A manager signs the shift off. You can hand cash over to the next cashier when the shift changes.$$, ARRAY['/shift'], true),
('night-audit', 'Run the night audit', $$The night audit closes the business day: it posts each in-house room's charge and taxes, checks the day and moves the hotel to the next business date.

1. Open Night audit at your usual time.
2. Read the checks. Deal with anything that stops the audit, for example arrivals still to check in or no-shows to mark.
3. Start the audit and wait for it to finish.

If something fails part way, fix the reason shown and resume: the audit carries on safely from where it stopped. The day's reports are ready when it finishes.$$, ARRAY['/night-audit'], true),
('room-status', 'Keep room status up to date', $$Housekeepers see the rooms given to them under My rooms.

1. Open a room when you start cleaning it.
2. Mark it clean when you finish. If your hotel inspects rooms, a supervisor then marks it inspected.
3. Report anything broken or missing from the room: it becomes a task for maintenance.

The front desk sees the same status on the room board, so a guest can be given the room as soon as it is ready.$$, ARRAY['/housekeeping', '/my-rooms'], true),
('rate-calendar', 'Set prices on the rate calendar', $$Prices are set per rate plan, room type and date.

1. Open Rates and choose the rate plan.
2. Select the room types and the dates.
3. Enter the price, and any restrictions: minimum or maximum stay, closed to arrival or departure, or stop sell.
4. Save.

Derived plans, such as a corporate rate a percentage below the best available rate, follow their parent plan's price on their own.$$, ARRAY['/rates'], true),
('import-a-spreadsheet', 'Import from a spreadsheet', $$Rooms, rates, guests, companies, company opening balances and future bookings can be loaded from a spreadsheet.

1. Open Imports and choose what you are importing.
2. Download the template and fill it in. Keep the column names.
3. Upload the file (CSV or Excel .xlsx).
4. Read the check report. Nothing has changed yet.
5. If there are problems, fix them in the file and upload it again. Otherwise import it: every row goes in, or none does.

Import companies before their opening balances, and rooms, rates and companies before future bookings.$$, ARRAY['/settings/imports'], true),
('approvals', 'Approve or reject a request', $$Some actions need a manager: a discount above the cashier's limit, a refund, a booking for a do-not-rent guest and others your hotel set.

1. Open Approvals. Requests waiting for you are at the top.
2. Read who asked, what for and why.
3. Approve or reject it. You may be asked for a one-time code sent to your phone.

When you approve, the action runs at once. Every decision is kept in the audit log.$$, ARRAY['/approvals'], true),
('get-help', 'Get help from the support team', $$Use Help in the top bar whenever you are stuck.

1. Write what happened and choose how urgent it is. Choose "The front desk can't work" only when you cannot serve guests.
2. Send it. The support team answers in the app, and by email too.
3. Reply in the same conversation until it is sorted, then mark it resolved.

The Help page also shows your first steps, your training sessions with the support team and your hotel's onboarding contact.$$, ARRAY['/support'], true);
