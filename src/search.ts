import { isValidCode, normalizeQuery } from './pipeline/codes';
import type { CapResult } from './pipeline/types';

/** Digits the recognizer can confuse on blurry, bold caps. */
const CONFUSABLE: Record<string, string[]> = {
  '0': ['8', '6', '9'],
  '1': ['7'],
  '3': ['8', '5'],
  '5': ['6', '3'],
  '6': ['8', '5', '0'],
  '7': ['1'],
  '8': ['3', '6', '0', '9'],
  '9': ['8', '0'],
};

export interface SearchResult {
  query: string;
  /** False when the query is not a valid Ohuhu code format. */
  validQuery: boolean;
  /** Confirmed readings of exactly this code. */
  confirmed: CapResult[];
  /** Low-confidence readings of exactly this code. */
  uncertain: CapResult[];
  /** Caps read as a commonly confused code (e.g. R43 when searching R48). Only filled when nothing is confirmed. */
  similar: CapResult[];
}

/** Codes one confusable digit away from `code`. */
export function confusableVariants(code: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < code.length; i++) {
    for (const alt of CONFUSABLE[code[i]] ?? []) {
      const v = code.slice(0, i) + alt + code.slice(i + 1);
      if (v !== code && isValidCode(v)) out.add(v);
    }
  }
  return [...out];
}

/**
 * Search existing recognition results; never triggers recognition.
 * Matching is case-insensitive, ignores surrounding/inner spaces, and requires the
 * complete code (BG3 does not match BG31).
 */
export function searchResults(results: readonly CapResult[], rawQuery: string): SearchResult {
  const query = normalizeQuery(rawQuery);
  const validQuery = isValidCode(query);
  const exact = results.filter((r) => r.code === query);
  const variants = new Set(confusableVariants(query));
  const byConf = (a: CapResult, b: CapResult) => b.conf - a.conf;
  const confirmed = exact.filter((r) => r.status === 'confirmed').sort(byConf);
  return {
    query,
    validQuery,
    confirmed,
    uncertain: exact.filter((r) => r.status === 'uncertain').sort(byConf),
    // With a confirmed match, look-alike codes are noise; without one they are the best lead.
    similar: confirmed.length ? [] : results.filter((r) => r.code !== null && r.status !== 'failed' && variants.has(r.code)).sort(byConf),
  };
}
