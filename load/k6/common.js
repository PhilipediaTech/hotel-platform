// Shared by the k6 scripts (T-101). k6 runs these files itself (not Node): `open` reads the
// sessions `npm run load:prepare` wrote; the API must be running (`npm run dev`).

export const session = JSON.parse(open('../.session.json'));

/** This virtual user's own front-desk session (one clerk per VU; 300 requests/min each). */
export function clerk() {
  return session.cookies.desk[(__VU - 1) % session.cookies.desk.length];
}

export function headers(cookie, write = false) {
  const h = {
    Cookie: cookie,
    'X-Property-Id': session.propertyId,
    Accept: 'application/json',
  };
  if (write) {
    h['Content-Type'] = 'application/json';
    h.Origin = session.origin;
    h['Idempotency-Key'] = uuid();
  }
  return h;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

/** YYYY-MM-DD plus `days`. */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
