// tests/lib/reference-resolver/user-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { UserResolver } from '../../../src/lib/reference-resolver/user-resolver.js';
import type { PipedriveUser } from '../../../src/types.js';

const MOCK_USERS: PipedriveUser[] = [
  { id: 1, name: 'Brad', email: 'brad@bhg.com', active: true },
  { id: 2, name: 'Stacy', email: 'stacy@bhg.com', active: true },
  { id: 3, name: 'Inactive User', email: 'gone@bhg.com', active: false },
];

describe('UserResolver', () => {
  const resolver = new UserResolver(MOCK_USERS);

  it('resolves user name to ID (case-insensitive)', () => {
    expect(resolver.resolveNameToId('brad')).toBe(1);
    expect(resolver.resolveNameToId('Stacy')).toBe(2);
    expect(resolver.resolveNameToId('BRAD')).toBe(1);
  });

  it('throws on unknown user', () => {
    expect(() => resolver.resolveNameToId('Nobody')).toThrow(
      "No user found matching 'Nobody'. Available users: Brad, Stacy, Inactive User"
    );
  });

  it('resolves user ID to name', () => {
    expect(resolver.resolveIdToName(1)).toBe('Brad');
    expect(resolver.resolveIdToName(2)).toBe('Stacy');
  });

  it('returns ID as string for unknown user IDs', () => {
    expect(resolver.resolveIdToName(999)).toBe('User 999');
  });

  it('returns all users', () => {
    expect(resolver.getUsers()).toHaveLength(3);
  });
});
