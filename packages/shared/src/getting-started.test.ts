import { describe, expect, it } from 'vitest';
import { GETTING_STARTED_STEPS, gettingStartedSteps } from './getting-started.ts';
import { PERMISSIONS } from './permissions.ts';

// Getting started (T-172): steps chosen by permission, managers' first, six at most.

describe('gettingStartedSteps', () => {
  it('gives someone who holds everything the managers’ steps first, six at most', () => {
    const all = PERMISSIONS.map((p) => p.code);
    expect(gettingStartedSteps(all).map((s) => s.id)).toEqual([
      'invite',
      'rates',
      'approve',
      'booking',
      'checkIn',
      'payment',
    ]);
  });

  it('gives a housekeeper only their own step', () => {
    expect(gettingStartedSteps(['hk.read', 'hk.work']).map((s) => s.id)).toEqual(['roomStatus']);
  });

  it('only names permissions that exist', () => {
    const codes = new Set(PERMISSIONS.map((p) => p.code));
    expect(GETTING_STARTED_STEPS.filter((s) => !codes.has(s.permission))).toEqual([]);
  });
});
