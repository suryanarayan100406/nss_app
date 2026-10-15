import { describe, expect, it } from 'vitest';
import { extractHomepage } from '../scripts/import-static.js';
import { mergeHomepageContent, parseHomepageContent } from '../src/content-schema.js';

describe('homepage revision contract', () => {
  it('merges partial editor patches into a complete validated revision', async () => {
    const current = await extractHomepage();
    const merged = mergeHomepageContent(current, { values: { 'hero.body': 'Updated safely.' } });
    const parsed = parseHomepageContent(merged);
    expect(parsed.values['hero.body']).toBe('Updated safely.');
    expect(parsed.values['hero.title']).toBe(current.values['hero.title']);
  });

  it('rejects a revision with a missing required public field', async () => {
    const current = await extractHomepage();
    expect(() => parseHomepageContent(mergeHomepageContent(current, { values: { 'hero.title': '' } }))).toThrow();
  });
});
