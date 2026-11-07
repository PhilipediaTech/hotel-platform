import http from 'k6/http';
import { check, sleep } from 'k6';
import { clerk, headers, session } from './common.js';

// The front desk's busiest reads (PRD NFR: front-desk API p95 < 500 ms; T-101). Measured here
// on this machine; the "from Lagos" target is checked again against staging (T-005).
//   k6 run load/k6/front-desk.js

export const options = {
  scenarios: {
    desk: { executor: 'constant-vus', vus: 10, duration: '30s' },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const LISTS = [
  `/front-desk/arrivals?date=${session.businessDate}`,
  `/front-desk/departures?date=${session.businessDate}`,
  '/front-desk/in-house',
  // The housekeeping board is not here: a front-desk clerk lacks hk.read (403, correctly).
];

export default function () {
  const path = LISTS[Math.floor(Math.random() * LISTS.length)];
  const res = http.get(`${session.apiBase}${path}`, {
    headers: headers(clerk()),
    tags: { name: path.split('?')[0] },
  });
  check(res, { 200: (r) => r.status === 200 });
  // A clerk's pace, under the 300/min per-user limit.
  sleep(0.25);
}
