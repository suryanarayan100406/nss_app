import { describe, expect, it } from 'vitest';
import { isEligibleEmail } from '../src/security.js';
import { roleRank } from '../src/types.js';
import { assignAcademicYear, canReview, isPublicEvent } from '../src/policy.js';

describe('institutional email policy', () => {
  it('accepts the exact institutional domain case-insensitively', () => {
    expect(isEligibleEmail('Student@IIITNR.EDU.IN')).toBe(true);
  });

  it('rejects lookalike domains and missing local parts', () => {
    expect(isEligibleEmail('student@iiitnr.edu.in.example.com')).toBe(false);
    expect(isEligibleEmail('student@example.com')).toBe(false);
    expect(isEligibleEmail('@iiitnr.edu.in')).toBe(false);
  });
});

describe('role policy', () => {
  it('orders user, approver, and admin privileges', () => {
    expect(roleRank.USER).toBeLessThan(roleRank.APPROVER);
    expect(roleRank.APPROVER).toBeLessThan(roleRank.ADMIN);
  });
});

describe('publication and archive policy', () => {
  it('assigns dates to the configured academic-year range', () => {
    const years = [{ id: '2025-26', startsOn: new Date('2025-07-01T00:00:00Z'), endsOn: new Date('2026-06-30T23:59:59Z') }];
    expect(assignAcademicYear(new Date('2025-08-01T00:00:00Z'), years)).toBe('2025-26');
    expect(assignAcademicYear(new Date('2027-08-01T00:00:00Z'), years)).toBeNull();
  });

  it('keeps drafts private and permits published archives', () => {
    expect(isPublicEvent({ status: 'DRAFT', visibility: 'PUBLIC' })).toBe(false);
    expect(isPublicEvent({ status: 'PUBLISHED', visibility: 'PUBLIC' })).toBe(true);
    expect(isPublicEvent({ status: 'ARCHIVED', visibility: 'PRIVATE' })).toBe(false);
  });

  it('prevents self-review while allowing an approver to review another contributor', () => {
    expect(canReview({ id: 'a', role: 'APPROVER' }, 'a')).toBe(false);
    expect(canReview({ id: 'a', role: 'APPROVER' }, 'b')).toBe(true);
    expect(canReview({ id: 'a', role: 'USER' }, 'b')).toBe(false);
  });
});
