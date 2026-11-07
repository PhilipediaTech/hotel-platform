# Release notes

## Load test results (T-101, 2026-11-07)

Spec tab 8: "Load: k6 — availability p95, booking throughput, 80-room night audit time"; PRD
NFR "Performance". How to run them again: [load/README.md](../load/README.md).

**Machine.** One laptop running everything (API, PostgreSQL, k6): Intel Core i7-6500U, 2 cores
/ 4 threads, 8 GB RAM, Windows 10, Node 24.22, k6 2.3.0. The API ran as `npm run load:api`
(the dev server without the file watcher and without per-request logs).

**Hotel.** 80 rooms (4 types × 20), BAR rates for 90 days, 70 guests checked in, 40 future
bookings (`npm run load:prepare`). Each virtual user is its own signed-in front-desk clerk
pausing 0.25 s between actions; the per-user limit of 300 requests a minute (spec tab 4) stays
on.

| Test                                                 | Load                          | Result                                                        | Target             |     |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ------------------ | --- |
| Availability, 30 nights, all room types              | 10 clerks, 30 s, 929 searches | p95 **148 ms**, 0 errors                                      | p95 < 800 ms       | ✔   |
| Front-desk lists (arrivals, departures, in-house)    | 10 clerks, 30 s, 849 requests | p95 **215 ms**, 0 errors                                      | p95 < 500 ms       | ✔   |
| Booking races (quote → reserve on the same 5 nights) | 8 clerks, 30 s, 675 requests  | 198 booked, 272 refused as sold out, 0 errors; p95 **210 ms** | nothing sold twice | ✔   |
| Overselling check (`npm run load:verify`)            | all 1,600 room-type nights    | no night sold beyond its rooms                                | none               | ✔   |
| Night audit, 80 rooms, 70 in house                   | one run                       | **2.8 s**, 70 room charges posted                             | < 2 minutes        | ✔   |

**Not measured here.** The front-desk target is "from Lagos": latency over the network to the
hosted API is measured against staging once it exists (T-005). Throughput here is bounded by
this laptop, which also ran the database and k6.

**Findings on the way.**

- With every virtual user sharing one session, about 70 % to 90 % of requests were refused with 429. That was the per-user rate limit working as specified, not slowness, so the scripts now
  use one clerk per virtual user.
- The front-desk role gets 403 on the housekeeping board (it lacks `hk.read`), as intended.
  The board is not part of the desk mix.
- On `npm run dev` the same desk test measured p95 505 ms. Pretty-printed request logs and the
  file watcher cost more than the requests themselves on this laptop. Production logs JSON, as
  `load:api` does.
