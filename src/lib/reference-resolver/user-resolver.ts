// src/lib/reference-resolver/user-resolver.ts
import type { PipedriveUser } from '../../types.js';

export class UserResolver {
  private users: PipedriveUser[];
  private nameToId: Map<string, number>; // lowercase name -> id
  private idToName: Map<number, string>;

  constructor(users: PipedriveUser[]) {
    this.users = users;
    this.nameToId = new Map();
    this.idToName = new Map();

    for (const user of users) {
      this.nameToId.set(user.name.toLowerCase(), user.id);
      this.idToName.set(user.id, user.name);
    }
  }

  resolveNameToId(name: string): number {
    const id = this.nameToId.get(name.toLowerCase());
    if (id !== undefined) return id;

    const available = this.users.map(u => u.name).join(', ');
    throw new Error(`No user found matching '${name}'. Available users: ${available}`);
  }

  resolveIdToName(id: number): string {
    return this.idToName.get(id) ?? `User ${id}`;
  }

  getUsers(): PipedriveUser[] {
    return this.users;
  }
}
