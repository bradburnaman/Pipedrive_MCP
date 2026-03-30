import type { CursorPayload } from '../types.js';

const CURSOR_ERROR = 'Invalid cursor \u2014 start a new list request without a cursor.';

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodeCursor(encoded: string): CursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error(CURSOR_ERROR);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(CURSOR_ERROR);
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.v !== 'v1' && obj.v !== 'v2') {
    throw new Error(CURSOR_ERROR);
  }

  if (obj.v === 'v1') {
    if (typeof obj.offset !== 'number' || !Number.isInteger(obj.offset) || obj.offset < 0) {
      throw new Error(CURSOR_ERROR);
    }
    return { v: 'v1', offset: obj.offset };
  }

  if (typeof obj.cursor !== 'string' || obj.cursor.length === 0) {
    throw new Error(CURSOR_ERROR);
  }

  return { v: 'v2', cursor: obj.cursor };
}
