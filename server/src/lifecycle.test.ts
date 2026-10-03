import { describe, expect, test } from 'vitest';
import { INITIAL_REVIEW_STATE, transition } from './lifecycle';

describe('report lifecycle', () => {
  test('a report starts pending', () => {
    expect(INITIAL_REVIEW_STATE).toBe('pending');
  });

  test('pending moves to released or rejected, and only on an explicit action', () => {
    expect(transition('pending', 'release')).toEqual({ ok: true, next: 'released' });
    expect(transition('pending', 'reject')).toEqual({ ok: true, next: 'rejected' });
  });

  test.each(['released', 'rejected'] as const)('%s is final', (state) => {
    for (const action of ['release', 'reject'] as const) {
      expect(transition(state, action)).toEqual({
        ok: false,
        reason: 'already_decided',
        current: state,
      });
    }
  });
});
