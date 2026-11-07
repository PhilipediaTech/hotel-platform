# Load tests (T-101)

k6 load tests for the PRD performance targets. They run against the local database
(`hotel_dev`) and never against production. Results: [docs/RELEASE-NOTES.md](../docs/RELEASE-NOTES.md).

You need [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`winget install k6`) and
PostgreSQL running, as for `npm run dev`.

1. Stop `npm run dev` if it is running, then start the API as measured:

   ```bash
   npm run load:api
   ```

2. In a second terminal, build a fresh load-test hotel (80 rooms, 70 guests in house, one
   session per clerk in `load/.session.json`, which git ignores):

   ```bash
   npm run load:prepare
   ```

3. Run the tests. Each prints ✓ or ✗ per target and exits non-zero on a miss:

   ```bash
   k6 run load/k6/availability.js
   k6 run load/k6/front-desk.js
   k6 run load/k6/booking.js
   npm run load:verify
   npm run load:night-audit
   ```

`load:verify` checks that the booking races sold no night beyond its rooms. The night audit
closes the hotel's day, so run it last and `npm run load:prepare` again before the next round.
Each prepare adds a new "Load Test Hotels …" group to `hotel_dev`; `npm run db:reset` clears
them with everything else.
