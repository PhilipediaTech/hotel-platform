# Channex PMS certification: runbook

How to pass Channex's PMS certification (docs.channex.io, "PMS Certification Tests") with this PMS. Channex wants every test triggered by real actions in the PMS screens, not by scripts. They review the results on a live screenshare, where they ask for changes on the spot (for example "set this price to 250 and this minimum stay to 3"). Results go in their form: https://forms.gle/xA8F3eSYBPBd8apYA (the task IDs, the answers below, and any test skipped).

Written for T-154. Everything below runs against the **Channex staging** account, which is free. Production access comes after certification and needs the paid plan.

## Before you start

1. **Settings.** In `.env`, set:
   - `CHANNEL_PROVIDER=channex`
   - `CHANNEX_API_KEY`: the staging key, which is already there
   - `CHANNEX_BASE_URL=https://staging.channex.io/api/v1`

   Start the API, the worker and the web app (`npm run dev`). The worker does the sending and takes the bookings in.

2. **Dates.** The tests are dated November 2027 to May 2028. We send 500 days ahead, so test 8 (up to 1 May 2028) fits from **18 December 2026** on. Run the certification on or after that date, or tell Channex in the form that test 8 was cut at our 500-day horizon.
3. **Pacing.** A change is sent once edits have been quiet for 2 minutes. This is so a scenario's edits go in one call, as Channex requires (at the latest 10 minutes after the first edit).
   - Make all the edits of one scenario, then wait about 3 minutes.
   - The scenario's send then shows in **Channel manager → Activity**, with its **task ID**.
   - Copy the task ID, then start the next scenario. If you start the next scenario's edits before the send shows, the two scenarios go out together.

## Setup ("Setup Mapping")

Sign up a new test organisation in your local PMS (it is your own local app). The setup wizard (onboarding) creates the property. Then:

1. **Property,** in the wizard, before going live:
   - name `Test Property - <your company name>`
   - currency **USD**
   - time zone **Europe/London**

   These can't change once the property is live.

2. **Room types:**
   - **Twin Room** with 8 rooms
   - **Double Room** with 5 rooms

   Channex suggests 1 Double room, but test 10 asks for 4 Double rooms left, so 5 are needed.

3. **Rate plans:** **Best Available Rate** (code BAR, room only) and **Bed & Breakfast Rate** (code BB, breakfast). Each sells both room types.
4. **Rate calendar:** BAR at 100 and BB at 120, for both room types, over the whole 500 days. A save covers at most 366 days, so it takes two saves per plan.
5. Make the first 500 days look like a real hotel. Channex rejects a full sync where every date is the same. For example:
   - higher weekend prices
   - a few minimum stays
   - one or two stop-sells
   - a booking or two
6. Go live, then open **Channel manager**, tick both plans and press **Connect**.
   - **Channex** gets the property (USD, Europe/London, type hotel) and two room types.
   - **It also gets four rate plans,** named "Best Available Rate · Twin Room" and so on.

## The tests

Do each scenario's edits in the screens named, one after the other. Then wait for the send and copy the task ID from Activity: **AVAILABILITY** lines for availability, **RESTRICTIONS** lines for prices and restrictions.

| #   | Test                           | What to do in the PMS                                                                                                                                                                                                                                     | Calls |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Full sync                      | Connecting sends everything: 500 days, one availability call (all room types) and one restrictions call (all rates). To do it again, press **Send everything again** on Channel manager.                                                                  | 1 + 1 |
| 2   | Single date, single rate       | Rate calendar: Twin, BAR, 22 Nov 2027, price 333.                                                                                                                                                                                                         | 1     |
| 3   | Single date, multiple rates    | Rate calendar, three saves: Twin BAR 21 Nov 2027 → 333; Double BAR 25 Nov → 444; Double BB 29 Nov → 456.23.                                                                                                                                               | 1     |
| 4   | Multiple dates, multiple rates | Three saves: Twin BAR 1–10 Nov 2027 → 241; Double BAR 10–16 Nov → 312.66; Double BB 1–20 Nov → 111.                                                                                                                                                       | 1     |
| 5   | Min stay                       | Three saves: Twin BAR 23 Nov → minimum stay 3; Double BAR 25 Nov → 2; Double BB 15 Nov → 5.                                                                                                                                                               | 1     |
| 6   | Stop sell                      | Three saves: Twin BAR 14 Nov, Double BAR 16 Nov, Double BB 20 Nov → stop sell on.                                                                                                                                                                         | 1     |
| 7   | Multiple restrictions          | Four saves: Twin BAR 1–10 Nov → closed to arrival on, closed to departure off, max stay 4, min stay 1; Twin BB 12–16 Nov → closed to departure on, min stay 6; Double BAR 10–16 Nov → closed to arrival on, min stay 2; Double BB 1–20 Nov → min stay 10. | 1     |
| 8   | Half-year                      | Two saves: Twin BAR 1 Dec 2027 – 1 May 2028 → 432, min stay 2 (closed to arrival and departure off); Double BAR same dates → 342, min stay 3.                                                                                                             | 1     |
| 9   | Single date availability       | Settings → Rooms → room → block: put **one** Twin room out of order for the night of 21 Nov 2027, and **all five** Double rooms for the night of 25 Nov. Twin then has 7 left and Double 0. Bookings work too.                                            | 1     |
| 10  | Multiple date availability     | Put **five** Twin rooms out of order for the nights of 10–16 Nov 2027 (3 left), and **one** Double room for 17–24 Nov (4 left).                                                                                                                           | 1     |
| 11  | Bookings                       | See below.                                                                                                                                                                                                                                                | —     |

Each scenario is also an automated test: `apps/api/src/modules/channels/certification.int.test.ts` replays tests 1–10 through the same API the screens use. It checks one call per endpoint and the exact values.

### Test 11: bookings

1. **Make test bookings.** In the Channex staging extranet, add the **Booking CRS** app (Applications). Its **Create** button on the bookings page makes test bookings. A Booking.com test account works too: see Channex's guide "Test account for Booking.com".
2. **Create, modify, cancel.** Do each in Booking CRS. Each shows in the PMS within about a minute:
   - **Create:** a new reservation with source OTA, linked to the Channex booking.
   - **Modify:** the reservation's dates, prices or guests change to match.
   - **Cancel:** the reservation is cancelled, with no fee.
3. **What to check.**
   - **Activity** shows a BOOKING line for each.
   - **Every booking is acknowledged** (Channex requires this). We save it first, then call `POST /booking_revisions/:id/ack`.
   - **Bookings that can't be booked safely** wait on Channel manager under **OTA bookings**, with the reason. Examples: a room type not set up, no room left, another currency.
4. **Webhook.** Locally, bookings come from the booking feed (`GET /booking_revisions/feed`, every minute), since Channex can't reach a local machine. On staging and in production, a signed webhook makes the PMS read the feed at once. Registering it needs the public API address (T-005) and a Channex signing key, whose secret goes in `CHANNEX_WEBHOOK_SECRETS`.

## Answers for the form

**12. Rate limits: can you stay within them?** Yes.

- **Prices, restrictions and availability:** at most 4 calls per endpoint per property per minute, and a lease stops runs overlapping. Channex's limit is 10.
- **On a 429:** we wait for `Retry-After`. Otherwise we back off 1, 2, 4… up to 30 minutes. Nothing is dropped: what wasn't sent stays different, so it goes on the next run.
- **Bookings:** the booking feed is read at most once a minute per property, plus once when a webhook arrives.

**13. Update logic: only changes?** Yes.

- **What is sent:** the worker compares what Channex should show with what it last accepted. It sends only the dates that differ, as date ranges.
- **When:** a change is sent once edits have been quiet for 2 minutes, so edits made together go in one call.
- **Full sync:** once a day, off-peak, at a time between 02:00 and 05:00 hotel time that differs per property, so properties are spread out. Also on request.

**14. Extra notes.**

- **Min stay:** arrival based (`min_stay_arrival`). Min stay through is not used.
- **Restrictions:** stop sell, closed to arrival, closed to departure, min stay and max stay are all supported.
- **Room types and rate plans:** multiple room types, and multiple rate plans per room type. Derived rate plans are worked out by the PMS and sent as plain rates.
- **Credit card details:** not needed. Card data is never stored (it is removed from the booking before it is saved).
- **PCI:** we are not PCI certified, and we take no card data through Channex.

**Pre-flight questions.**

- **Where is `POST /availability` called from?** `apps/api/src/modules/channels/sync.ts`, `syncConnection` (around line 465), through `updateAvailability` in `apps/api/src/core/channel-manager.ts`.
- **Is a 429 backed off or dropped?** Backed off with `Retry-After` (`retryDelayMs` in `sync.ts`), never dropped.
- **Change detection:** database triggers on `room_type_inventory`, `rate_days` and `rate_plans` write `channel_ari_changes`. Every connection is also compared at least every 15 minutes.
- **Mapping:** `channel_mappings` keeps our room type or rate plan against the Channex ID. Nothing is hard-coded.
- **Bookings:** taken from the booking revisions feed (never `GET /bookings`), saved, then acknowledged. A signed webhook (`POST /webhooks/channel/channex`) makes the feed be read at once.
