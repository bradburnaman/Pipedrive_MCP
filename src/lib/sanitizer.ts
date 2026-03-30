import striptags from 'striptags';

export function trimString(value: string, fieldName?: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Field '${fieldName ?? 'value'}' cannot be empty.`);
  }
  return trimmed;
}

export function validateStringLength(value: string, fieldName: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new Error(
      `Field '${fieldName}' exceeds maximum length of ${maxLength} characters (got ${value.length}).`
    );
  }
}

export function sanitizeNoteContent(html: string): string {
  let text = html;
  text = text.replace(/<\/p>\s*/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  const blockTags = ['div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr'];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`</${tag}>`, 'gi'), '\n');
  }
  text = striptags(text);
  text = decodeHtmlEntities(text);
  text = text.replace(/\n{3,}/g, '\n\n');
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
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  return result;
}
