// tests/tools/fields.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createFieldTools } from '../../src/tools/fields.js';

describe('field tools', () => {
  it('get-fields returns field definitions with options', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'title', name: 'Title', field_type: 'varchar', options: undefined },
          { key: 'abc_area', name: 'Practice Area', field_type: 'enum', options: [
            { id: 1, label: 'Varicent' }, { id: 2, label: 'Xactly' },
          ]},
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'deal' });
    expect(result).toHaveLength(2);
    expect(result[1].options).toEqual(['Varicent', 'Xactly']);
  });

  it('get-fields returns null for options when field has no options', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'title', name: 'Title', field_type: 'varchar', options: undefined },
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'person' });
    expect(result[0].options).toBeNull();
  });

  it('get-fields rejects invalid resource type', async () => {
    const resolver = {} as any;
    const tools = createFieldTools(resolver);
    await expect(tools[0].handler({ resource_type: 'bogus' })).rejects.toThrow(/Invalid resource_type/);
  });

  it('get-fields returns correct shape per field', async () => {
    const resolver = {
      getFieldResolver: vi.fn().mockResolvedValue({
        getFieldDefinitions: () => [
          { key: 'abc_custom', name: 'My Custom', field_type: 'text', options: undefined, max_length: 500 },
        ],
      }),
    } as any;
    const tools = createFieldTools(resolver);
    const result = await tools[0].handler({ resource_type: 'organization' });
    expect(result[0]).toEqual({
      key: 'abc_custom',
      name: 'My Custom',
      type: 'text',
      options: null,
    });
  });

  it('get-fields passes correct resource type to resolver', async () => {
    const getFieldResolver = vi.fn().mockResolvedValue({
      getFieldDefinitions: () => [],
    });
    const resolver = { getFieldResolver } as any;
    const tools = createFieldTools(resolver);
    await tools[0].handler({ resource_type: 'activity' });
    expect(getFieldResolver).toHaveBeenCalledWith('activity');
  });
});
