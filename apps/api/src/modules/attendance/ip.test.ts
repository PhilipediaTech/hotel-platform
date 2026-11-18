import { describe, expect, it } from 'vitest';
import { addressMatches, isAddressEntry } from './ip.ts';

describe('hotel network addresses', () => {
  it('matches IPv4 addresses and ranges', () => {
    expect(addressMatches('102.89.4.10', '102.89.4.10')).toBe(true);
    expect(addressMatches('102.89.4.11', '102.89.4.10')).toBe(false);
    expect(addressMatches('102.89.4.200', '102.89.4.0/24')).toBe(true);
    expect(addressMatches('102.89.5.1', '102.89.4.0/24')).toBe(false);
    expect(addressMatches('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(addressMatches('::ffff:127.0.0.1', '127.0.0.1')).toBe(true);
    expect(addressMatches('::ffff:127.0.0.1', '127.0.0.0/8')).toBe(true);
  });

  it('matches IPv6 addresses and ranges', () => {
    expect(addressMatches('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(addressMatches('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(addressMatches('::1', '::1')).toBe(true);
    expect(addressMatches('2001:db8::1', '102.89.4.0/24')).toBe(false);
  });

  it('accepts only real addresses and prefixes', () => {
    expect(isAddressEntry('102.89.4.0/24')).toBe(true);
    expect(isAddressEntry('2001:db8::/48')).toBe(true);
    expect(isAddressEntry('102.89.4.0/33')).toBe(false);
    expect(isAddressEntry('999.1.1.1')).toBe(false);
    expect(isAddressEntry('1.2.3')).toBe(false);
  });
});
