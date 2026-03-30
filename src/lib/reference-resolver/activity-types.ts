// src/lib/reference-resolver/activity-types.ts

export interface ActivityType {
  key_string: string;
  name: string;
  active_flag: boolean;
}

export class ActivityTypeResolver {
  private types: ActivityType[];
  private keySet: Map<string, string>; // lowercase key -> actual key

  constructor(types: ActivityType[]) {
    this.types = types;
    this.keySet = new Map();
    for (const t of types) {
      this.keySet.set(t.key_string.toLowerCase(), t.key_string);
    }
  }

  isValidType(type: string): boolean {
    return this.keySet.has(type.toLowerCase());
  }

  normalizeType(type: string): string {
    return this.keySet.get(type.toLowerCase()) ?? type;
  }

  getTypes(): ActivityType[] {
    return this.types;
  }
}
