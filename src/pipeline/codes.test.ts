import { describe, expect, it } from 'vitest';
import { isValidCode, normalizeQuery, parseCode } from './codes';

describe('isValidCode', () => {
  it.each(['BG3', 'Y131', 'YR313', 'BGY25', 'YGY17', 'RV212', 'E515', 'FY02', '0', '120'])('accepts %s', (c) => expect(isValidCode(c)).toBe(true));
  it.each(['', 'BG', 'Q12', 'BG3131', 'bg3', '121', 'YR', '5'])('rejects %s', (c) => expect(isValidCode(c)).toBe(false));
});

describe('normalizeQuery', () => {
  it('trims, uppercases and drops inner spaces', () => {
    expect(normalizeQuery('  bg 3 ')).toBe('BG3');
  });
});

describe('parseCode', () => {
  it('passes exact codes with no fixes', () => {
    expect(parseCode('YR313')).toEqual({ code: 'YR313', fixes: 0 });
  });
  it('repairs a single digit confusion', () => {
    expect(parseCode('YR2S')).toEqual({ code: 'YR25', fixes: 1 });
    expect(parseCode('YRO4')).toEqual({ code: 'YR04', fixes: 1 });
  });
  it('rejects two or more repairs', () => {
    expect(parseCode('YRSS')).toBeNull();
  });
  it('does not invent a prefix for all-digit text', () => {
    expect(parseCode('61')).toBeNull();
    expect(parseCode('683')).toBeNull();
  });
  it('accepts special codes only when read exactly', () => {
    expect(parseCode('120')).toEqual({ code: '120', fixes: 0 });
    expect(parseCode('O')).toBeNull();
    expect(parseCode('I20')).toBeNull();
  });
  it('strips punctuation', () => {
    expect(parseCode('[G210')).toEqual({ code: 'G210', fixes: 0 });
  });
});
