import http from 'k6/http';
import { check, sleep } from 'k6';
import { addDays, clerk, headers, session } from './common.js';

// Availability search for 80 rooms × 30 nights (PRD NFR: p95 < 800 ms; T-101).
//   k6 run load/k6/availability.js

export const options = {
  scenarios: {
    search: { executor: 'constant-vus', vus: 10, duration: '30s' },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // Arrivals across the next fortnight, 30 nights each.
  const arrival = addDays(session.businessDate, Math.floor(Math.random() * 14));
  const departure = addDays(arrival, 30);
  const res = http.get(
    `${session.apiBase}/availability?arrival=${arrival}&departure=${departure}&adults=2`,
    { headers: headers(clerk()), tags: { name: 'availability' } },
  );
  check(res, {
    200: (r) => r.status === 200,
    'four room types': (r) => r.status === 200 && r.json('roomTypes').length === 4,
  });
  // A clerk's pace, about 4 searches a second, under the 300/min per-user limit.
  sleep(0.25);
}
