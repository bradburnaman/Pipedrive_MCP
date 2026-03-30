// tests/lib/reference-resolver/activity-types.test.ts
import { describe, it, expect } from 'vitest';
import { ActivityTypeResolver } from '../../../src/lib/reference-resolver/activity-types.js';

const MOCK_TYPES = [
  { key_string: 'call', name: 'Call', active_flag: true },
  { key_string: 'meeting', name: 'Meeting', active_flag: true },
  { key_string: 'task', name: 'Task', active_flag: true },
  { key_string: 'email', name: 'Email', active_flag: true },
  { key_string: 'deadline', name: 'Deadline', active_flag: true },
  { key_string: 'lunch', name: 'Lunch', active_flag: false },
];

describe('ActivityTypeResolver', () => {
  const resolver = new ActivityTypeResolver(MOCK_TYPES);

  it('validates a known active type', () => {
    expect(resolver.isValidType('call')).toBe(true);
    expect(resolver.isValidType('meeting')).toBe(true);
  });

  it('validates case-insensitively', () => {
    expect(resolver.isValidType('Call')).toBe(true);
    expect(resolver.isValidType('MEETING')).toBe(true);
  });

  it('normalizes type to key_string', () => {
    expect(resolver.normalizeType('Call')).toBe('call');
    expect(resolver.normalizeType('MEETING')).toBe('meeting');
  });

  it('includes inactive types as valid', () => {
    expect(resolver.isValidType('lunch')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(resolver.isValidType('yoga')).toBe(false);
  });

  it('returns all types', () => {
    expect(resolver.getTypes()).toHaveLength(6);
  });
});
