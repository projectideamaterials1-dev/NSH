import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../lib/markdown';

describe('assistant markdown', () => {
  it('parses inline bold, italic and code', () => {
    expect(parseInline('pc **2.4e-21** for `CDM-00018`, *effectively zero*')).toEqual([
      { kind: 'text', text: 'pc ' }, { kind: 'bold', text: '2.4e-21' }, { kind: 'text', text: ' for ' },
      { kind: 'code', text: 'CDM-00018' }, { kind: 'text', text: ', ' }, { kind: 'italic', text: 'effectively zero' },
    ]);
  });

  it('splits headings, lists and paragraphs', () => {
    const blocks = parseMarkdown([
      '### Key findings', 'The riskiest is CDM-00018.', 'It is a debris pass.', '',
      '- **Miss:** 0.98 km', '- **Pc:** 8.7e-22', '  (effectively zero)', '1. First', '2. Second', 'Done.',
    ].join('\n'));
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'paragraph']);
    expect(blocks[1]).toEqual({ kind: 'paragraph', content: [{ kind: 'text', text: 'The riskiest is CDM-00018. It is a debris pass.' }] });
    const bullets = blocks[2] as Extract<typeof blocks[number], { kind: 'list' }>;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items[1]).toEqual([{ kind: 'bold', text: 'Pc:' }, { kind: 'text', text: ' 8.7e-22 (effectively zero)' }]);
    expect((blocks[3] as { ordered: boolean }).ordered).toBe(true);
  });

  it('keeps HTML as plain text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ]);
  });
});
