# Part 2: Foundation Utilities

> Part 2 of 13 — Cursor encode/decode module and input sanitizer module
> **Depends on:** Part 01
> **Produces:** `src/lib/cursor.ts`, `tests/lib/cursor.test.ts`, `src/lib/sanitizer.ts`, `tests/lib/sanitizer.test.ts`

---

## Task 4: Cursor Module

**Files:**
- Create: `src/lib/cursor.ts`
- Create: `tests/lib/cursor.test.ts`

- [ ] **Step 1: Write cursor tests**

```typescript
// tests/lib/cursor.test.ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/cursor.js';

describe('encodeCursor', () => {
  it('encodes a v2 cursor', () => {
    const encoded = encodeCursor({ v: 'v2', cursor: 'abc123' });
    expect(typeof encoded).toBe('string');
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v2', cursor: 'abc123' });
  });

  it('encodes a v1 offset', () => {
    const encoded = encodeCursor({ v: 'v1', offset: 200 });
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: 'v1', offset: 200 });
  });
});

describe('decodeCursor', () => {
  it('decodes a valid v2 cursor', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2', cursor: 'xyz' })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v2', cursor: 'xyz' });
  });

  it('decodes a valid v1 offset', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 100 })).toString('base64');
    expect(decodeCursor(payload)).toEqual({ v: 'v1', offset: 100 });
  });

  it('throws on invalid base64', () => {
    expect(() => decodeCursor('not-valid-base64!!!')).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on invalid JSON', () => {
    const payload = Buffer.from('not json').toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on missing v field', () => {
    const payload = Buffer.from(JSON.stringify({ offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on unrecognized v value', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v3', offset: 100 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on negative offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: -5 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on non-integer offset for v1', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v1', offset: 3.14 })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });

  it('throws on missing cursor for v2', () => {
    const payload = Buffer.from(JSON.stringify({ v: 'v2' })).toString('base64');
    expect(() => decodeCursor(payload)).toThrow(
      'Invalid cursor — start a new list request without a cursor.'
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/cursor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write cursor implementation**

```typescript
// src/lib/cursor.ts
import type { CursorPayload } from '../types.js';

const CURSOR_ERROR = 'Invalid cursor — start a new list request without a cursor.';

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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/cursor.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cursor.ts tests/lib/cursor.test.ts
git commit -m "feat: cursor encode/decode with validation"
```

---

## Task 5: Sanitizer Module

**Files:**
- Create: `src/lib/sanitizer.ts`
- Create: `tests/lib/sanitizer.test.ts`

- [ ] **Step 1: Write sanitizer tests**

```typescript
// tests/lib/sanitizer.test.ts
import { describe, it, expect } from 'vitest';
import { trimString, sanitizeNoteContent, validateStringLength } from '../../src/lib/sanitizer.js';

describe('trimString', () => {
  it('trims whitespace', () => {
    expect(trimString('  hello  ')).toBe('hello');
  });

  it('throws on empty-after-trim', () => {
    expect(() => trimString('   ', 'title')).toThrow("Field 'title' cannot be empty.");
  });

  it('throws on empty string', () => {
    expect(() => trimString('', 'name')).toThrow("Field 'name' cannot be empty.");
  });

  it('returns trimmed value for valid input', () => {
    expect(trimString('  valid  ', 'field')).toBe('valid');
  });
});

describe('validateStringLength', () => {
  it('passes for string within limit', () => {
    expect(() => validateStringLength('hello', 'title', 255)).not.toThrow();
  });

  it('throws for string exceeding limit', () => {
    const long = 'a'.repeat(256);
    expect(() => validateStringLength(long, 'title', 255)).toThrow(
      "Field 'title' exceeds maximum length of 255 characters (got 256)."
    );
  });
});

describe('sanitizeNoteContent', () => {
  it('strips basic HTML tags', () => {
    expect(sanitizeNoteContent('<b>Important</b>: follow up')).toBe('Important: follow up');
  });

  it('converts <br> to newlines', () => {
    expect(sanitizeNoteContent('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  it('converts <br/> and <br /> to newlines', () => {
    expect(sanitizeNoteContent('A<br/>B<br />C')).toBe('A\nB\nC');
  });

  it('converts <p> tags to newlines', () => {
    expect(sanitizeNoteContent('<p>First paragraph</p><p>Second paragraph</p>')).toBe(
      'First paragraph\n\nSecond paragraph'
    );
  });

  it('converts block-level elements to newlines', () => {
    expect(sanitizeNoteContent('<div>First</div><div>Second</div>')).toBe('First\nSecond');
  });

  it('converts <li> to newlines', () => {
    expect(sanitizeNoteContent('<ul><li>Item 1</li><li>Item 2</li></ul>')).toBe('Item 1\nItem 2');
  });

  it('converts heading tags to newlines', () => {
    expect(sanitizeNoteContent('<h1>Title</h1><h2>Subtitle</h2>Text')).toBe('Title\nSubtitle\nText');
  });

  it('decodes HTML entities', () => {
    expect(sanitizeNoteContent('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
  });

  it('collapses 3+ newlines to 2', () => {
    expect(sanitizeNoteContent('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeNoteContent('  <p>Hello</p>  ')).toBe('Hello');
  });

  it('handles plain text without changes', () => {
    expect(sanitizeNoteContent('Just plain text')).toBe('Just plain text');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/sanitizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write sanitizer implementation**

```typescript
// src/lib/sanitizer.ts
import striptags from 'striptags';

export function trimString(value: string, fieldName?: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Field '${fieldName ?? 'value'}' cannot be empty.`);
  }
  return trimmed;
}

export function validateStringLength(
  value: string,
  fieldName: string,
  maxLength: number
): void {
  if (value.length > maxLength) {
    throw new Error(
      `Field '${fieldName}' exceeds maximum length of ${maxLength} characters (got ${value.length}).`
    );
  }
}

export function sanitizeNoteContent(html: string): string {
  let text = html;

  // Convert block-level elements to newlines BEFORE stripping tags
  // <p> gets double newline (paragraph break)
  text = text.replace(/<\/p>\s*/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');

  // <br> variants to newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Block-level elements: closing tags become newlines
  const blockTags = ['div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr'];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`</${tag}>`, 'gi'), '\n');
  }

  // Strip all remaining HTML tags
  text = striptags(text);

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim
  text = text.trim();

  return text;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), char);
  }
  // Numeric entities
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return result;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/sanitizer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sanitizer.ts tests/lib/sanitizer.test.ts
git commit -m "feat: input sanitizer with HTML stripping and length validation"
```
