// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type Api,
  type Availability,
  type Booking,
  type CheckInInfo,
  type Property,
} from './api.ts';
import { mount } from './app.ts';

// The guest booking site (PRD M11-01, M11-02; S39; T-113).

const ROOM = '11111111-0000-4000-8000-000000000001';
const PLAN = '11111111-0000-4000-8000-000000000002';

const PROPERTY: Property = {
  slug: 'demo-lagos',
  name: 'Demo Lagos Hotel',
  headline: 'Stay in Lagos',
  description: null,
  policies: 'No smoking.',
  phone: '+2348030000000',
  email: null,
  address: {},
  currency: 'NGN',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  photoUrls: [],
  payment: { full: true, deposit: true, depositBps: 3000, atHotel: true },
  roomTypes: [
    { id: ROOM, name: 'Deluxe', description: null, maxOccupancy: 2, amenities: [], photoUrls: [] },
  ],
};
const AVAILABILITY: Availability = {
  arrival: '2026-12-14',
  departure: '2026-12-16',
  nights: 2,
  currency: 'NGN',
  promoApplied: false,
  roomTypes: [
    {
      roomTypeId: ROOM,
      name: 'Deluxe',
      maxOccupancy: 2,
      available: 3,
      plans: [
        { ratePlanId: PLAN, name: 'Best rate', mealPlan: 'BREAKFAST', totalMinor: '10000000' },
      ],
    },
  ],
};
const BOOKING: Booking = {
  confirmationNo: 'LAG-00042',
  status: 'CONFIRMED',
  hotel: { name: 'Demo Lagos Hotel', slug: 'demo-lagos', phone: null, email: null },
  guestName: 'Bisi Adeyemi',
  arrival: '2026-12-14',
  departure: '2026-12-16',
  roomType: 'Deluxe',
  ratePlan: 'Best rate',
  adults: 1,
  children: 0,
  totalMinor: '10000000',
  paidMinor: '3000000',
  currency: 'NGN',
  cancellation: { allowed: true, feeMinor: '0' },
};

const CHECK_IN: CheckInInfo = {
  closedReason: null,
  requiredFields: ['nationality', 'idType', 'idNumber'],
  idTypes: ['PASSPORT', 'NATIONAL_ID'],
  dataProtectionNotice: 'ID details are held under the Act.',
  submittedAt: null,
  dueMinor: '7000000',
  currency: 'NGN',
};

const created = (over: object = {}) => ({
  token: 'secret-token',
  confirmationNo: 'LAG-00042',
  status: 'CONFIRMED' as const,
  paymentUrl: null,
  amountDueNowMinor: '0',
  totalMinor: '10000000',
  currency: 'NGN',
  ...over,
});

let root: HTMLElement;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
let api: { [K in keyof Api]: ReturnType<typeof vi.fn<Api[K]>> };

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.getElementById('app') as HTMLElement;
  sessionStorage.clear();
  navigate = vi.fn<(url: string) => void>();
  api = {
    property: vi.fn<Api['property']>().mockResolvedValue(PROPERTY),
    availability: vi.fn<Api['availability']>().mockResolvedValue(AVAILABILITY),
    book: vi.fn<Api['book']>().mockResolvedValue(created()),
    booking: vi.fn<Api['booking']>().mockResolvedValue(BOOKING),
    cancel: vi.fn<Api['cancel']>().mockResolvedValue({ ...BOOKING, status: 'CANCELLED' }),
    checkInInfo: vi.fn<Api['checkInInfo']>().mockResolvedValue(CHECK_IN),
    submitCheckIn: vi
      .fn<Api['submitCheckIn']>()
      .mockResolvedValue({ ...CHECK_IN, submittedAt: '2026-12-01T09:00:00Z' }),
    uploadId: vi.fn<Api['uploadId']>().mockResolvedValue('file-1'),
    payBalance: vi
      .fn<Api['payBalance']>()
      .mockResolvedValue({ paymentUrl: 'https://pay.test/bal' }),
  };
});

const start = (path: string, search = '', framed = false) => {
  mount(root, { path, search, origin: 'https://book.test', framed, api, navigate });
};

const settle = async () => {
  await vi.waitFor(() => {
    expect(root.textContent).not.toBe('');
  });
  await new Promise((r) => setTimeout(r, 0));
};

const byId = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
const buttonNamed = (name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  ) as HTMLButtonElement;
const submit = (label: string) => {
  root
    .querySelector(`form[aria-label="${label}"]`)
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

async function chooseRoom() {
  start('/demo-lagos');
  await settle();
  byId('f-arrival').value = '2026-12-14';
  byId('f-departure').value = '2026-12-16';
  submit('Find a room');
  await settle();
  buttonNamed('Book Deluxe, Best rate').click();
}

function fillGuest() {
  byId('f-firstName').value = 'Bisi';
  byId('f-lastName').value = 'Adeyemi';
  byId('f-email').value = 'bisi@guest.test';
  byId('f-phone').value = '+2348031110000';
}

describe('finding a room', () => {
  it('says so when the address has no hotel, or the page is off', async () => {
    start('/');
    expect(root.textContent).toContain('booking link your hotel gave you');
    api.property.mockRejectedValue(new ApiError(404, 'Not found', 'NOT_FOUND', {}));
    start('/nowhere');
    await settle();
    expect(root.textContent).toContain('This booking page is not available');
  });

  it('stops departure on or before arrival without asking the server', async () => {
    start('/demo-lagos');
    await settle();
    byId('f-arrival').value = '2026-12-14';
    byId('f-departure').value = '2026-12-14';
    submit('Find a room');
    expect(root.textContent).toContain('Departure must be after arrival');
    expect(api.availability).not.toHaveBeenCalled();
  });

  it('lists rooms and prices with taxes', async () => {
    await chooseRoom();
    expect(api.availability).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'demo-lagos', arrival: '2026-12-14', adults: 1 }),
    );
    expect(root.textContent).toContain('Total');
    expect(root.textContent).toContain('100,000');
  });

  it('shows a hotel’s words as text, never as HTML', async () => {
    api.property.mockResolvedValue({ ...PROPERTY, name: '<img src=x onerror=alert(1)>' });
    start('/demo-lagos');
    await settle();
    expect(root.querySelector('h1 img')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toContain('<img');
  });
});

describe('booking', () => {
  it('pay at the hotel goes to the booking’s page', async () => {
    await chooseRoom();
    fillGuest();
    byId('pay-AT_HOTEL').checked = true;
    submit('Your details');
    await settle();
    expect(api.book.mock.calls[0]?.[0]).toMatchObject({
      slug: 'demo-lagos',
      roomTypeId: ROOM,
      ratePlanId: PLAN,
      firstName: 'Bisi',
      payment: 'AT_HOTEL',
      marketingConsent: false,
      returnUrl: 'https://book.test/demo-lagos/manage',
    });
    expect(navigate).toHaveBeenCalledWith('/demo-lagos/manage?token=secret-token');
  });

  it('offers only the hotel’s ways to pay, with the deposit worked out', async () => {
    api.property.mockResolvedValue({
      ...PROPERTY,
      payment: { full: false, deposit: true, depositBps: 3000, atHotel: false },
    });
    await chooseRoom();
    expect(byId('pay-FULL')).toBeNull();
    expect(byId('pay-AT_HOTEL')).toBeNull();
    expect(root.textContent).toContain('Pay a deposit now');
    expect(root.textContent).toContain('30,000');
  });

  it('paying online goes to the payment page and remembers the booking', async () => {
    api.book.mockResolvedValue(
      created({
        status: 'TENTATIVE',
        paymentUrl: 'https://pay.test/abc',
        amountDueNowMinor: '10000000',
      }),
    );
    await chooseRoom();
    fillGuest();
    submit('Your details');
    await settle();
    expect(navigate).toHaveBeenCalledWith('https://pay.test/abc');
    expect(sessionStorage.getItem('booking-token:demo-lagos')).toBe('secret-token');
  });

  it('inside a hotel’s website, payment opens from a link', async () => {
    api.book.mockResolvedValue(
      created({ status: 'TENTATIVE', paymentUrl: 'https://pay.test/abc' }),
    );
    start('/demo-lagos', '', true);
    await settle();
    byId('f-arrival').value = '2026-12-14';
    byId('f-departure').value = '2026-12-16';
    submit('Find a room');
    await settle();
    buttonNamed('Book Deluxe, Best rate').click();
    fillGuest();
    submit('Your details');
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    expect(root.querySelector('a[target="_top"]')?.getAttribute('href')).toBe(
      'https://pay.test/abc',
    );
  });

  it('after a failure, trying again sends the same key so it can’t book twice', async () => {
    api.book.mockRejectedValueOnce(new ApiError(0, 'We can’t reach the booking system.', null, {}));
    await chooseRoom();
    fillGuest();
    submit('Your details');
    await settle();
    expect(root.textContent).toContain('We can’t reach the booking system');
    expect(buttonNamed('Confirm booking').disabled).toBe(false);
    submit('Your details');
    await settle();
    const [one, two] = api.book.mock.calls;
    expect(one?.[0].bookingKey).toBeTruthy();
    expect(two?.[0].bookingKey).toBe(one?.[0].bookingKey);
  });

  it('asks for the guest’s details first', async () => {
    await chooseRoom();
    submit('Your details');
    expect(root.textContent).toContain('Please fill in your name');
    expect(api.book).not.toHaveBeenCalled();
  });
});

describe('managing a booking (M11-02)', () => {
  it('shows the booking from the link, and from this browser after paying', async () => {
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    expect(api.booking).toHaveBeenCalledWith('secret-token');
    expect(root.textContent).toContain('LAG-00042');
    expect(root.textContent).toContain('To pay at the hotel');

    api.booking.mockClear();
    sessionStorage.setItem('booking-token:demo-lagos', 'from-this-browser');
    start('/demo-lagos/manage');
    await settle();
    expect(api.booking).toHaveBeenCalledWith('from-this-browser');
  });

  it('without a token, or with a wrong one, says to use the email', async () => {
    start('/demo-lagos/manage');
    await settle();
    expect(root.textContent).toContain('link in your email');
    api.booking.mockRejectedValue(new ApiError(404, 'Not found', 'NOT_FOUND', {}));
    start('/demo-lagos/manage', '?token=wrong');
    await settle();
    expect(root.textContent).toContain('This link is not valid');
  });

  it('a held booking offers to check the payment again', async () => {
    api.booking.mockResolvedValue({ ...BOOKING, status: 'TENTATIVE' });
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    expect(root.textContent).toContain('Waiting for payment');
    api.booking.mockResolvedValue(BOOKING);
    buttonNamed('Check again').click();
    await settle();
    expect(root.textContent).toContain('Confirmed');
  });

  it('shows the fee before cancelling and sends the fee the guest saw', async () => {
    api.booking.mockResolvedValue({
      ...BOOKING,
      cancellation: { allowed: true, feeMinor: '5000000' },
    });
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    buttonNamed('Cancel booking').click();
    expect(root.textContent).toContain('Cancelling now costs');
    root.querySelector<HTMLButtonElement>('button.danger')?.click();
    await settle();
    expect(api.cancel).toHaveBeenCalledWith('secret-token', '5000000');
  });

  it('no cancel button once it can’t be cancelled', async () => {
    api.booking.mockResolvedValue({
      ...BOOKING,
      status: 'CANCELLED',
      cancellation: { allowed: false, feeMinor: '0' },
    });
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    expect(buttonNamed('Cancel booking')).toBeUndefined();
  });
});

describe('online check-in (M3-20, M11-06)', () => {
  const open = async () => {
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Pay before you arrive');
    });
  };

  it('asks only for what the hotel requires, and offers only its IDs', async () => {
    await open();
    expect(byId('f-nationality')).not.toBeNull();
    expect(byId('f-address')).toBeNull();
    const options = [...root.querySelectorAll('#f-idType option')].map((o) => o.textContent);
    expect(options).toEqual(['Choose', 'Passport', 'National ID']);
    expect(root.textContent).toContain('held under the Act');
  });

  it('needs consent, then sends the details and says it’s done', async () => {
    await open();
    byId('f-nationality').value = 'NG';
    byId('f-idType').value = 'PASSPORT';
    byId('f-idNumber').value = 'A1234567';
    submit('Check in online');
    expect(root.textContent).toContain('Please confirm');
    expect(api.submitCheckIn).not.toHaveBeenCalled();

    byId('consent').checked = true;
    submit('Check in online');
    await vi.waitFor(() => {
      expect(root.textContent).toContain('You’ve checked in online');
    });
    expect(api.submitCheckIn).toHaveBeenCalledWith('secret-token', {
      consent: true,
      nationality: 'NG',
      idType: 'PASSPORT',
      idNumber: 'A1234567',
    });
    expect(api.uploadId).not.toHaveBeenCalled();
  });

  it('shows a server problem and lets the guest try again', async () => {
    api.submitCheckIn.mockRejectedValueOnce(new ApiError(400, 'Enter your ID number', null, {}));
    await open();
    byId('consent').checked = true;
    submit('Check in online');
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Enter your ID number');
    });
    expect(buttonNamed('Check in online').disabled).toBe(false);
  });

  it('pays the balance from the link', async () => {
    await open();
    buttonNamed('Pay ₦70,000.00 now').click();
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('https://pay.test/bal');
    });
    expect(api.payBalance).toHaveBeenCalledWith(
      'secret-token',
      'https://book.test/demo-lagos/manage',
    );
  });

  it('offers nothing while the booking is not confirmed', async () => {
    api.booking.mockResolvedValue({ ...BOOKING, status: 'TENTATIVE' });
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    expect(api.checkInInfo).not.toHaveBeenCalled();
  });

  it('already done: says so, and the details can be changed', async () => {
    api.checkInInfo.mockResolvedValue({
      ...CHECK_IN,
      dueMinor: '0',
      submittedAt: '2026-12-01T09:00:00Z',
    });
    start('/demo-lagos/manage', '?token=secret-token');
    await settle();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('You’ve checked in online');
    });
    buttonNamed('Change my details').click();
    expect(byId('f-nationality')).not.toBeNull();
  });
});
