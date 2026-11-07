import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { addDays, clerk, headers, session } from './common.js';

// Booking throughput (spec tab 8 "booking throughput"; T-101): quote then reserve, many desks at
// once, on dates far enough out to sell rooms out. A sold-out answer (409 BOOKING_CONFLICT) is
// a correct result, not a failure; anything else is. `npm run load:verify` then checks that no
// night was sold beyond its rooms.
//   k6 run load/k6/booking.js

const booked = new Counter('bookings_made');
const soldOut = new Counter('bookings_sold_out');

export const options = {
  scenarios: {
    desks: { executor: 'constant-vus', vus: 8, duration: '30s' },
  },
  thresholds: {
    // Unexpected errors only (sold out answers 409 and is counted apart).
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const type = session.roomTypeIds[Math.floor(Math.random() * session.roomTypeIds.length)];
  // A narrow window of dates, so rooms run out and the races are real.
  const arrival = addDays(session.businessDate, 40 + Math.floor(Math.random() * 5));
  const quote = http.post(
    `${session.apiBase}/quotes`,
    JSON.stringify({
      roomTypeId: type,
      ratePlanId: session.ratePlanId,
      arrival,
      departure: addDays(arrival, 2),
      adults: 1,
    }),
    {
      headers: headers(clerk(), true),
      tags: { name: 'quote' },
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
  sleep(0.25);
  if (quote.status === 409) {
    soldOut.add(1);
    check(quote, { 'quote 201 or sold out': () => true });
    return;
  }
  if (!check(quote, { 'quote 201 or sold out': (r) => r.status === 201 })) return;
  const res = http.post(
    `${session.apiBase}/reservations`,
    JSON.stringify({
      source: 'PHONE',
      booker: { firstName: 'Load', lastName: `Desk${__VU}` },
      stays: [{ quoteId: quote.json('quoteId') }],
    }),
    {
      headers: headers(clerk(), true),
      tags: { name: 'reserve' },
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
  if (res.status === 201) booked.add(1);
  if (res.status === 409) soldOut.add(1);
  check(res, { 'booked or sold out': (r) => r.status === 201 || r.status === 409 });
  if (res.status !== 201 && res.status !== 409) console.warn(`reserve ${res.status}: ${res.body}`);
  sleep(0.25);
}
