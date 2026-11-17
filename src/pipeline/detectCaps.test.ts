import { describe, expect, it } from 'vitest';
import { mergeCircles } from './detectCaps';

describe('mergeCircles', () => {
  it('drops near-duplicate circles and keeps the first', () => {
    const a = [{ x: 0, y: 0, r: 10 }];
    const b = [{ x: 2, y: 1, r: 11 }, { x: 40, y: 0, r: 10 }];
    expect(mergeCircles([a, b])).toEqual([{ x: 0, y: 0, r: 10 }, { x: 40, y: 0, r: 10 }]);
  });
});
