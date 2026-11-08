import { ApiError, type Api, type Availability, type Booking, type Property } from './api.ts';

// The guest booking site (PRD M11-01, M11-02; S39; T-113): dates, rooms, plans, guest details,
// pay, confirmation and manage booking. No framework, to stay small on mobile data. Everything
// from the server goes in as text, never as HTML, so a hotel's wording can't inject anything.

export interface Env {
  path: string;
  search: string;
  origin: string;
  framed: boolean;
  api: Api;
  navigate(url: string): void;
}

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((event: Event) => void)>;

function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (typeof value === 'boolean') el.toggleAttribute(key, value);
    else el.setAttribute(key, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const money = (minor: string, currency: string) =>
  new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).format(Number(minor) / 100);

const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

const MEALS: Record<string, string> = {
  ROOM_ONLY: 'Room only',
  BREAKFAST: 'Breakfast included',
  HALF_BOARD: 'Half board',
  FULL_BOARD: 'Full board',
};

const STATUS: Record<string, string> = {
  TENTATIVE: 'Waiting for payment',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  CHECKED_OUT: 'Stay completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Missed arrival',
};

const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';

function field(
  label: string,
  input: Attrs & { name: string },
  hint?: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const id = `f-${input.name}`;
  const el = h('input', { id, ...input }) as HTMLInputElement;
  return {
    input: el,
    row: h(
      'div',
      { class: 'field' },
      h('label', { for: id }, label),
      el,
      hint && h('small', {}, hint),
    ),
  };
}

const tokenKey = (slug: string) => `booking-token:${slug}`;

function saveToken(slug: string, token: string) {
  try {
    sessionStorage.setItem(tokenKey(slug), token);
  } catch {
    // Private windows may refuse: the email has the link too.
  }
}

function readToken(slug: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(slug));
  } catch {
    return null;
  }
}

export function mount(root: HTMLElement, env: Env): void {
  const [slug, section] = env.path.split('/').filter(Boolean);
  const show = (...nodes: Child[]) => {
    root.replaceChildren(...nodes.filter((n): n is Node | string => Boolean(n)));
  };
  const alert = (message: string) => h('p', { class: 'alert', role: 'alert' }, message);
  const plain = (message: string) => h('p', { class: 'note' }, message);

  if (!slug) {
    show(plain('Use the booking link your hotel gave you.'));
    return;
  }
  if (section === 'manage') {
    const token = new URLSearchParams(env.search).get('token') ?? readToken(slug);
    if (token) void showManage(token);
    else show(alert('This link is not complete. Please use the link in your email.'));
    return;
  }
  void showHotel(slug);

  // ── The hotel and the search ──────────────────────────────────────────────────────────

  async function showHotel(hotelSlug: string) {
    let property: Property;
    try {
      property = await env.api.property(hotelSlug);
    } catch (err) {
      show(
        err instanceof ApiError && err.status === 404
          ? plain('This booking page is not available.')
          : alert(messageOf(err)),
      );
      return;
    }
    document.title = `Book ${property.name}`;
    const results = h('section', { 'aria-label': 'Rooms available' });
    show(header(property), searchForm(property, results), results, about(property));
  }

  function header(p: Property) {
    const [hero] = p.photoUrls;
    return h(
      'header',
      { class: 'hotel' },
      hero && h('img', { class: 'hero', src: hero, alt: '' }),
      h('h1', {}, p.name),
      p.headline && h('p', { class: 'lead' }, p.headline),
    );
  }

  function about(p: Property) {
    return h(
      'section',
      { class: 'card about' },
      p.description && h('p', { class: 'prose' }, p.description),
      h('p', {}, `Check-in from ${p.checkInTime}. Check-out by ${p.checkOutTime}.`),
      p.policies && h('h2', {}, 'Good to know'),
      p.policies && h('p', { class: 'prose' }, p.policies),
      (p.phone ?? p.email) &&
        h('p', {}, ['Questions?', p.phone, p.email].filter(Boolean).join(' ')),
    );
  }

  function searchForm(p: Property, results: HTMLElement) {
    const today = new Date().toISOString().slice(0, 10);
    const arrival = field('Arrival', { name: 'arrival', type: 'date', min: today, required: true });
    const departure = field('Departure', {
      name: 'departure',
      type: 'date',
      min: today,
      required: true,
    });
    const adults = field('Adults', {
      name: 'adults',
      type: 'number',
      min: '1',
      max: '20',
      value: '1',
    });
    const children = field('Children', {
      name: 'children',
      type: 'number',
      min: '0',
      max: '20',
      value: '0',
    });
    const promo = field('Promo code (optional)', { name: 'promo', autocomplete: 'off' });
    const submit = h('button', { type: 'submit' }, 'See rooms') as HTMLButtonElement;
    return h(
      'form',
      {
        class: 'card search',
        novalidate: true,
        'aria-label': 'Find a room',
        onsubmit: (event) => {
          event.preventDefault();
          if (!arrival.input.value || !departure.input.value) {
            results.replaceChildren(alert('Choose your arrival and departure dates.'));
            return;
          }
          if (departure.input.value <= arrival.input.value) {
            results.replaceChildren(alert('Departure must be after arrival.'));
            return;
          }
          const search = {
            slug: p.slug,
            arrival: arrival.input.value,
            departure: departure.input.value,
            adults: Number(adults.input.value),
            children: Number(children.input.value),
            ...(promo.input.value.trim() ? { promo: promo.input.value.trim().toUpperCase() } : {}),
          };
          submit.disabled = true;
          results.replaceChildren(plain('Looking for rooms…'));
          env.api
            .availability(search)
            .then((a) => {
              results.replaceChildren(...roomList(p, a, search));
            })
            .catch((err: unknown) => {
              results.replaceChildren(alert(messageOf(err)));
            })
            .finally(() => {
              submit.disabled = false;
            });
        },
      },
      h('div', { class: 'row' }, arrival.row, departure.row),
      h('div', { class: 'row' }, adults.row, children.row),
      promo.row,
      submit,
    );
  }

  type Search = Parameters<Api['availability']>[0];

  function roomList(p: Property, a: Availability, search: Search): Node[] {
    if (a.roomTypes.length === 0) {
      return [plain('No rooms are available for those dates. Try different dates.')];
    }
    const nodes: Node[] = [];
    if (search.promo) {
      nodes.push(
        plain(
          a.promoApplied
            ? 'Your promo code is applied.'
            : 'That promo code can’t be used for these dates.',
        ),
      );
    }
    for (const room of a.roomTypes) {
      const info = p.roomTypes.find((t) => t.id === room.roomTypeId);
      const [photo] = info?.photoUrls ?? [];
      nodes.push(
        h(
          'article',
          { class: 'card room' },
          photo && h('img', { src: photo, alt: '', loading: 'lazy' }),
          h('h2', {}, room.name),
          info?.description && h('p', {}, info.description),
          info &&
            info.amenities.length > 0 &&
            h('p', { class: 'muted' }, info.amenities.join(' · ')),
          h('p', { class: 'muted' }, `Sleeps ${room.maxOccupancy}`),
          ...room.plans.map((plan) =>
            h(
              'div',
              { class: 'plan' },
              h('div', {}, h('strong', {}, plan.name), h('br', {}), MEALS[plan.mealPlan] ?? ''),
              h(
                'div',
                { class: 'price' },
                h('strong', {}, money(plan.totalMinor, a.currency)),
                h('small', {}, `${a.nights} night${a.nights === 1 ? '' : 's'}, with taxes`),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': `Book ${room.name}, ${plan.name}`,
                    onclick: () => {
                      showDetails(p, a, search, room, plan);
                    },
                  },
                  'Book',
                ),
              ),
            ),
          ),
        ),
      );
    }
    return nodes;
  }

  // ── Guest details and paying ──────────────────────────────────────────────────────────

  type Room = Availability['roomTypes'][number];
  type Plan = Room['plans'][number];

  function showDetails(p: Property, a: Availability, search: Search, room: Room, plan: Plan) {
    // Made once for this form: a double-click or a retry can't book twice.
    const bookingKey = crypto.randomUUID();
    const first = field('First name', {
      name: 'firstName',
      autocomplete: 'given-name',
      required: true,
    });
    const last = field('Last name', {
      name: 'lastName',
      autocomplete: 'family-name',
      required: true,
    });
    const email = field('Email', {
      name: 'email',
      type: 'email',
      autocomplete: 'email',
      required: true,
    });
    const phone = field(
      'Phone',
      { name: 'phone', type: 'tel', autocomplete: 'tel', required: true },
      'With your country code, for example +2348031234567.',
    );
    const total = BigInt(plan.totalMinor);
    const choices: { value: 'FULL' | 'DEPOSIT' | 'AT_HOTEL'; label: string }[] = [
      ...(p.payment.full
        ? [
            {
              value: 'FULL' as const,
              label: `Pay in full now: ${money(plan.totalMinor, a.currency)}`,
            },
          ]
        : []),
      ...(p.payment.deposit && p.payment.depositBps > 0
        ? [
            {
              value: 'DEPOSIT' as const,
              label: `Pay a deposit now: ${money(
                ((total * BigInt(p.payment.depositBps)) / 10_000n).toString(),
                a.currency,
              )}`,
            },
          ]
        : []),
      ...(p.payment.atHotel ? [{ value: 'AT_HOTEL' as const, label: 'Pay at the hotel' }] : []),
    ];
    const radios = choices.map((c, i) => {
      const id = `pay-${c.value}`;
      const input = h('input', {
        id,
        type: 'radio',
        name: 'payment',
        value: c.value,
        checked: i === 0,
      }) as HTMLInputElement;
      return { input, row: h('label', { for: id, class: 'choice' }, input, c.label) };
    });
    const marketing = h('input', { id: 'marketing', type: 'checkbox' }) as HTMLInputElement;
    const problem = h('div', {});
    const submit = h('button', { type: 'submit' }, 'Confirm booking') as HTMLButtonElement;

    show(
      h('h1', {}, p.name),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, `${room.name}, ${plan.name}`),
        h('p', {}, `${longDate(a.arrival)} to ${longDate(a.departure)}`),
        h('p', {}, h('strong', {}, `Total ${money(plan.totalMinor, a.currency)}`), ' with taxes'),
      ),
      h(
        'form',
        {
          class: 'card',
          novalidate: true,
          'aria-label': 'Your details',
          onsubmit: (event) => {
            event.preventDefault();
            const payment = radios.find((r) => r.input.checked)?.input.value as
              'FULL' | 'DEPOSIT' | 'AT_HOTEL' | undefined;
            if (!payment) return;
            if (![first, last, email, phone].every((f) => f.input.value.trim())) {
              problem.replaceChildren(alert('Please fill in your name, email and phone.'));
              return;
            }
            submit.disabled = true;
            problem.replaceChildren();
            env.api
              .book({
                slug: p.slug,
                bookingKey,
                roomTypeId: room.roomTypeId,
                ratePlanId: plan.ratePlanId,
                arrival: search.arrival,
                departure: search.departure,
                adults: search.adults,
                children: search.children,
                firstName: first.input.value.trim(),
                lastName: last.input.value.trim(),
                email: email.input.value.trim(),
                phone: phone.input.value.trim(),
                payment,
                marketingConsent: marketing.checked,
                returnUrl: `${env.origin}/${p.slug}/manage`,
                ...(search.promo && a.promoApplied ? { promo: search.promo } : {}),
              })
              .then((b) => {
                saveToken(p.slug, b.token);
                if (b.paymentUrl === null) {
                  env.navigate(`/${p.slug}/manage?token=${encodeURIComponent(b.token)}`);
                } else if (env.framed) {
                  // A payment page won't open inside the hotel's own website.
                  show(
                    h(
                      'section',
                      { class: 'card' },
                      h('h2', {}, `Booking ${b.confirmationNo}`),
                      h('p', {}, 'Your room is held for 30 minutes.'),
                      h('a', { class: 'button', href: b.paymentUrl, target: '_top' }, 'Pay now'),
                    ),
                  );
                } else {
                  env.navigate(b.paymentUrl);
                }
              })
              .catch((err: unknown) => {
                problem.replaceChildren(alert(messageOf(err)));
                submit.disabled = false;
              });
          },
        },
        h('h2', {}, 'Your details'),
        h('div', { class: 'row' }, first.row, last.row),
        email.row,
        phone.row,
        h(
          'fieldset',
          {},
          h('legend', {}, 'How would you like to pay?'),
          ...radios.map((r) => r.row),
        ),
        h(
          'label',
          { for: 'marketing', class: 'choice' },
          marketing,
          'Send me offers from this hotel',
        ),
        p.policies && h('p', { class: 'prose muted' }, p.policies),
        problem,
        submit,
      ),
    );
  }

  // ── A guest's booking (M11-02) ────────────────────────────────────────────────────────

  async function showManage(token: string) {
    let b: Booking;
    try {
      b = await env.api.booking(token);
    } catch (err) {
      show(
        err instanceof ApiError && err.status === 404
          ? alert('This link is not valid. Please use the link in your email.')
          : alert(messageOf(err)),
      );
      return;
    }
    document.title = `Your booking ${b.confirmationNo}`;
    const area = h('div', {});
    const due = BigInt(b.totalMinor) - BigInt(b.paidMinor);
    show(
      h('h1', {}, b.hotel.name),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, `Booking ${b.confirmationNo}`),
        h('p', { class: `status status-${b.status.toLowerCase()}` }, STATUS[b.status] ?? b.status),
        b.status === 'TENTATIVE' &&
          h(
            'p',
            {},
            'We’re waiting to hear that your payment went through. This usually takes a moment.',
          ),
        b.status === 'TENTATIVE' &&
          h(
            'button',
            { type: 'button', class: 'quiet', onclick: () => void showManage(token) },
            'Check again',
          ),
        h('p', {}, b.guestName),
        h('p', {}, `${longDate(b.arrival)} to ${longDate(b.departure)}`),
        h('p', {}, `${b.roomType}, ${b.ratePlan}`),
        h('p', {}, `Total ${money(b.totalMinor, b.currency)}`),
        BigInt(b.paidMinor) > 0n && h('p', {}, `Paid ${money(b.paidMinor, b.currency)}`),
        b.status === 'CONFIRMED' &&
          due > 0n &&
          h('p', {}, `To pay at the hotel ${money(due.toString(), b.currency)}`),
        h(
          'p',
          { class: 'muted' },
          ['Need help?', b.hotel.phone, b.hotel.email].filter(Boolean).join(' '),
        ),
        area,
      ),
    );
    if (b.cancellation.allowed) offerCancel(area, token, b);
  }

  function offerCancel(area: HTMLElement, token: string, b: Booking) {
    const fee = BigInt(b.cancellation.feeMinor);
    area.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'quiet',
          onclick: () => {
            const problem = h('div', {});
            const yes = h(
              'button',
              {
                type: 'button',
                class: 'danger',
                onclick: () => {
                  (yes as HTMLButtonElement).disabled = true;
                  env.api
                    .cancel(token, b.cancellation.feeMinor)
                    .then(() => showManage(token))
                    .catch((err: unknown) => {
                      problem.replaceChildren(alert(messageOf(err)));
                      (yes as HTMLButtonElement).disabled = false;
                    });
                },
              },
              fee > 0n
                ? `Cancel and pay ${money(b.cancellation.feeMinor, b.currency)}`
                : 'Yes, cancel',
            );
            area.replaceChildren(
              h(
                'p',
                { role: 'status' },
                fee > 0n
                  ? `Cancelling now costs ${money(b.cancellation.feeMinor, b.currency)} under this booking’s policy.`
                  : 'You can cancel this booking free of charge.',
              ),
              problem,
              yes,
              h(
                'button',
                {
                  type: 'button',
                  class: 'quiet',
                  onclick: () => {
                    offerCancel(area, token, b);
                  },
                },
                'Keep my booking',
              ),
            );
          },
        },
        'Cancel booking',
      ),
    );
  }
}
