import { describe, expect, it } from 'vitest';
import type { CapResult } from './pipeline/types';
import { confusableVariants, searchResults } from './search';

const cap = (code: string | null, status: CapResult['status'], conf = 95): CapResult => ({ cx: 0, cy: 0, r: 10, code, rawText: code ?? '', conf, status, angle: 0 });

const results = [cap('BG3', 'confirmed'), cap('BG31', 'confirmed'), cap('Y131', 'uncertain', 70), cap('R43', 'confirmed'), cap('E59', 'failed', 20), cap('BG3', 'confirmed', 99)];

describe('searchResults', () => {
  it('is case-insensitive and ignores spaces', () => {
    expect(searchResults(results, ' bg3 ').confirmed).toHaveLength(2);
  });
  it('matches complete codes only', () => {
    const r = searchResults(results, 'BG3');
    expect(r.confirmed.every((c) => c.code === 'BG3')).toBe(true);
  });
  it('orders multiple matches by confidence', () => {
    expect(searchResults(results, 'BG3').confirmed[0].conf).toBe(99);
  });
  it('keeps uncertain readings separate from confirmed ones', () => {
    const r = searchResults(results, 'Y131');
    expect(r.confirmed).toHaveLength(0);
    expect(r.uncertain).toHaveLength(1);
  });
  it('never returns failed readings', () => {
    const r = searchResults(results, 'E59');
    expect(r.confirmed.length + r.uncertain.length + r.similar.length).toBe(0);
  });
  it('offers commonly confused codes as similar', () => {
    const r = searchResults(results, 'R48');
    expect(r.confirmed).toHaveLength(0);
    expect(r.similar.map((c) => c.code)).toEqual(['R43']);
  });
  it('omits look-alikes when a confirmed match exists', () => {
    const r = searchResults([...results, cap('R48', 'confirmed')], 'R48');
    expect(r.confirmed).toHaveLength(1);
    expect(r.similar).toHaveLength(0);
  });
  it('flags invalid queries', () => {
    expect(searchResults(results, 'hello').validQuery).toBe(false);
  });
});

describe('confusableVariants', () => {
  it('only produces valid codes', () => {
    expect(confusableVariants('R48')).toEqual(expect.arrayContaining(['R43', 'R46']));
    expect(confusableVariants('R48')).not.toContain('R48');
  });
});
