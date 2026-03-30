// src/lib/reference-resolver/field-resolver.ts
import { closest } from 'fastest-levenshtein';
import { distance } from 'fastest-levenshtein';
import type { FieldDefinition, FieldOption } from '../../types.js';

const MAX_FUZZY_DISTANCE = 2;

export class FieldResolver {
  private fields: FieldDefinition[];
  private systemFields: Set<string>;
  private labelToKey: Map<string, string>;           // "Practice Area" -> "abc123_practice_area"
  private keyToLabel: Map<string, string>;            // "abc123_practice_area" -> "Practice Area"
  private keyToOptions: Map<string, FieldOption[]>;   // "abc123_practice_area" -> [{ id, label }]
  private optionLabelToId: Map<string, Map<string, number>>; // key -> (label -> id)
  private optionIdToLabel: Map<string, Map<number, string>>; // key -> (id -> label)
  private collidingLabels: Set<string>;               // custom field labels that collide with system keys
  private customPrefixMap: Map<string, string>;       // "custom:status" -> "abc_status"

  constructor(fields: FieldDefinition[], systemFields: Set<string>) {
    this.fields = fields;
    this.systemFields = systemFields;
    this.labelToKey = new Map();
    this.keyToLabel = new Map();
    this.keyToOptions = new Map();
    this.optionLabelToId = new Map();
    this.optionIdToLabel = new Map();
    this.collidingLabels = new Set();
    this.customPrefixMap = new Map();

    for (const field of fields) {
      // Map key -> label
      this.keyToLabel.set(field.key, field.name);

      // Check for collision: custom field whose label matches a system field key
      const labelLower = field.name.toLowerCase();
      if (systemFields.has(labelLower) && !systemFields.has(field.key)) {
        this.collidingLabels.add(field.name);
        this.customPrefixMap.set(`custom:${field.name}`, field.key);
      } else {
        // Map label -> key (no collision)
        this.labelToKey.set(field.name, field.key);
      }

      // Option maps for enum/set fields
      if (field.options && field.options.length > 0) {
        this.keyToOptions.set(field.key, field.options);
        const labelMap = new Map<string, number>();
        const idMap = new Map<number, string>();
        for (const opt of field.options) {
          labelMap.set(opt.label.toLowerCase(), opt.id);
          idMap.set(opt.id, opt.label);
        }
        this.optionLabelToId.set(field.key, labelMap);
        this.optionIdToLabel.set(field.key, idMap);
      }
    }
  }

  resolveInputField(name: string): string {
    // Check custom: prefix first
    const customKey = this.customPrefixMap.get(name);
    if (customKey) return customKey;

    // Check label map
    const keyFromLabel = this.labelToKey.get(name);
    if (keyFromLabel) return keyFromLabel;

    // Check if it's a known raw key
    if (this.keyToLabel.has(name)) return name;

    // Unknown — try fuzzy match
    const allLabels = [...this.labelToKey.keys()];
    for (const label of allLabels) {
      if (distance(name, label) <= MAX_FUZZY_DISTANCE) {
        throw new Error(
          `Unknown field '${name}' on this resource. Did you mean '${label}'?`
        );
      }
    }

    throw new Error(`Unknown field '${name}' on this resource.`);
  }

  resolveInputValue(key: string, value: unknown): unknown {
    const labelMap = this.optionLabelToId.get(key);
    if (!labelMap || typeof value !== 'string') return value;

    const id = labelMap.get(value.toLowerCase());
    if (id !== undefined) return id;

    // Unknown option
    const options = this.keyToOptions.get(key) ?? [];
    const validLabels = options.map(o => o.label).join(', ');
    const fieldName = this.keyToLabel.get(key) ?? key;
    throw new Error(
      `Invalid value '${value}' for field '${fieldName}'. Valid options: ${validLabels}`
    );
  }

  resolveOutputField(key: string): string {
    return this.keyToLabel.get(key) ?? key;
  }

  getOutputKey(key: string): string {
    const label = this.keyToLabel.get(key) ?? key;
    if (this.collidingLabels.has(label)) {
      return `custom:${label}`;
    }
    return label;
  }

  resolveOutputValue(key: string, value: unknown): unknown {
    const idMap = this.optionIdToLabel.get(key);
    if (!idMap || typeof value !== 'number') return value;
    return idMap.get(value) ?? value;
  }

  getFieldDefinitions(): FieldDefinition[] {
    return this.fields;
  }
}
