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
