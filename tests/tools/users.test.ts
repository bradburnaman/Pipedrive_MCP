// tests/tools/users.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createUserTools } from '../../src/tools/users.js';

describe('user tools', () => {
  it('list-users returns all users', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [
          { id: 1, name: 'Brad', email: 'brad@bhg.com', active: true },
          { id: 2, name: 'Stacy', email: 'stacy@bhg.com', active: true },
        ],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Brad');
  });

  it('list-users returns user shape with id, name, email, active', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [
          { id: 5, name: 'Alice', email: 'alice@bhg.com', active: false },
        ],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result[0]).toEqual({
      id: 5,
      name: 'Alice',
      email: 'alice@bhg.com',
      active: false,
    });
  });

  it('list-users returns empty array when no users', async () => {
    const resolver = {
      getUserResolver: vi.fn().mockResolvedValue({
        getUsers: () => [],
      }),
    } as any;
    const tools = createUserTools(resolver);
    const result = await tools[0].handler({});
    expect(result).toEqual([]);
  });
});
