import { isIP } from 'node:net';

// IP addresses and ranges for the hotel-network check on phone clock-in (M7-04; T-138).

/** The address as a number and its bit length; IPv4-mapped IPv6 (::ffff:a.b.c.d) is IPv4. */
function parse(address: string): { value: bigint; bits: 32 | 128 } | null {
  let a = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped?.[1]) a = mapped[1];
  const version = isIP(a);
  if (version === 4) {
    const value = a.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
    return { value, bits: 32 };
  }
  if (version === 6) {
    const [head = '', tail = ''] = a.split('::');
    const groups = (s: string) => (s ? s.split(':') : []);
    let left = groups(head);
    let right = groups(tail);
    // An IPv4 tail (e.g. 64:ff9b::1.2.3.4) is two groups.
    const last = (a.includes('::') ? right : left).at(-1);
    if (last?.includes('.')) {
      const v4 = parse(last);
      if (!v4) return null;
      const pair = [(v4.value >> 16n).toString(16), (v4.value & 0xffffn).toString(16)];
      if (a.includes('::')) right = [...right.slice(0, -1), ...pair];
      else left = [...left.slice(0, -1), ...pair];
    }
    const missing = 8 - left.length - right.length;
    const all = a.includes('::') ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
    if (all.length !== 8) return null;
    const value = all.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
    return { value, bits: 128 };
  }
  return null;
}

/** True when `entry` is a valid address or range (a.b.c.d, a.b.c.d/n, IPv6, IPv6/n). */
export function isAddressEntry(entry: string): boolean {
  const [address = '', prefix] = entry.split('/');
  const parsed = parse(address);
  if (!parsed) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return Number.isInteger(n) && n >= 0 && n <= parsed.bits;
}

/** True when `ip` is the address `entry`, or inside the range `entry`. */
export function addressMatches(ip: string, entry: string): boolean {
  const target = parse(ip);
  const [address = '', prefix] = entry.split('/');
  const base = parse(address);
  if (!target || !base || target.bits !== base.bits) return false;
  const n = prefix === undefined ? base.bits : Number(prefix);
  if (!Number.isInteger(n) || n < 0 || n > base.bits) return false;
  const shift = BigInt(base.bits - n);
  return target.value >> shift === base.value >> shift;
}
