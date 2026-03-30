// tests/lib/reference-resolver/field-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldResolver } from '../../../src/lib/reference-resolver/field-resolver.js';
import type { FieldDefinition } from '../../../src/types.js';

const MOCK_FIELDS: FieldDefinition[] = [
  { key: 'title', name: 'Title', field_type: 'varchar' },
  { key: 'status', name: 'Status', field_type: 'enum', options: [
    { id: 1, label: 'open' },
    { id: 2, label: 'won' },
    { id: 3, label: 'lost' },
  ]},
  { key: 'abc123_practice_area', name: 'Practice Area', field_type: 'enum', options: [
    { id: 10, label: 'Varicent' },
    { id: 11, label: 'Xactly' },
    { id: 12, label: 'CaptivateIQ' },
  ]},
  { key: 'def456_partner', name: 'Partner Assigned', field_type: 'varchar' },
];

// System fields that should not be overridden by custom field labels
const SYSTEM_FIELDS = new Set(['title', 'status', 'value', 'pipeline_id', 'stage_id', 'user_id']);

describe('FieldResolver', () => {
  let resolver: FieldResolver;

  beforeEach(() => {
    resolver = new FieldResolver(MOCK_FIELDS, SYSTEM_FIELDS);
  });

  describe('resolveInputField', () => {
    it('resolves a custom field label to its key', () => {
      expect(resolver.resolveInputField('Practice Area')).toBe('abc123_practice_area');
    });

    it('resolves a system field name to its key', () => {
      expect(resolver.resolveInputField('Title')).toBe('title');
    });

    it('passes through a known raw key', () => {
      expect(resolver.resolveInputField('abc123_practice_area')).toBe('abc123_practice_area');
    });

    it('throws on unknown field with fuzzy suggestion', () => {
      expect(() => resolver.resolveInputField('Pratice Area')).toThrow(
        "Unknown field 'Pratice Area' on this resource. Did you mean 'Practice Area'?"
      );
    });

    it('throws on unknown field with no close match', () => {
      expect(() => resolver.resolveInputField('xyzzy_nonsense')).toThrow(
        "Unknown field 'xyzzy_nonsense' on this resource."
      );
    });

    it('does not auto-correct — always throws', () => {
      expect(() => resolver.resolveInputField('Pratice Area')).toThrow();
    });
  });

  describe('resolveInputValue', () => {
    it('resolves enum label to ID', () => {
      expect(resolver.resolveInputValue('abc123_practice_area', 'Varicent')).toBe(10);
    });

    it('passes through non-enum values unchanged', () => {
      expect(resolver.resolveInputValue('def456_partner', 'Brad')).toBe('Brad');
    });

    it('throws on unknown enum option', () => {
      expect(() => resolver.resolveInputValue('abc123_practice_area', 'Unknown')).toThrow(
        "Invalid value 'Unknown' for field 'Practice Area'. Valid options: Varicent, Xactly, CaptivateIQ"
      );
    });
  });

  describe('resolveOutputField', () => {
    it('resolves a hash key to its label', () => {
      expect(resolver.resolveOutputField('abc123_practice_area')).toBe('Practice Area');
    });

    it('keeps system field names as-is', () => {
      expect(resolver.resolveOutputField('title')).toBe('Title');
    });
  });

  describe('resolveOutputValue', () => {
    it('resolves enum ID to label', () => {
      expect(resolver.resolveOutputValue('abc123_practice_area', 10)).toBe('Varicent');
    });

    it('passes through non-enum values', () => {
      expect(resolver.resolveOutputValue('def456_partner', 'Brad')).toBe('Brad');
    });

    it('passes through unknown enum IDs as-is', () => {
      expect(resolver.resolveOutputValue('abc123_practice_area', 999)).toBe(999);
    });
  });

  describe('collision handling', () => {
    it('namespaces colliding custom field on output', () => {
      const fields: FieldDefinition[] = [
        { key: 'status', name: 'Status', field_type: 'varchar' },
        { key: 'abc_status', name: 'status', field_type: 'varchar' }, // custom field named "status"
      ];
      const r = new FieldResolver(fields, SYSTEM_FIELDS);
      expect(r.getOutputKey('abc_status')).toBe('custom:status');
    });

    it('resolves custom: prefix on input', () => {
      const fields: FieldDefinition[] = [
        { key: 'status', name: 'Status', field_type: 'varchar' },
        { key: 'abc_status', name: 'status', field_type: 'varchar' },
      ];
      const r = new FieldResolver(fields, SYSTEM_FIELDS);
      expect(r.resolveInputField('custom:status')).toBe('abc_status');
    });
  });

  describe('getFieldDefinitions', () => {
    it('returns all field definitions', () => {
      expect(resolver.getFieldDefinitions()).toHaveLength(4);
    });
  });
});
