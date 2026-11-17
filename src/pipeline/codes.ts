/**
 * Ohuhu marker code normalization and validation.
 * Codes are a color-family prefix followed by 1–3 digits (e.g. BG3, Y131, YR313),
 * plus a few special codes (0 = Colorless Blender, 120 = Black).
 */
export const PREFIXES = ['FY', 'YGY', 'BGY', 'BG', 'BV', 'CG', 'GG', 'WG', 'YG', 'YR', 'RV', 'G', 'B', 'V', 'R', 'Y', 'E'];
const PREFIX_ALT = [...PREFIXES].sort((a, b) => b.length - a.length).join('|');
/** Codes without a letter prefix. Readings of these are never auto-confirmed. */
export const SPECIAL = new Set(['0', '120']);
export const CODE_RE = new RegExp(`^(?:(?:${PREFIX_ALT})\\d{1,3}|0|120)$`);

const DIGIT_FIX: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', A: '4', B: '8', G: '6' };
const LETTER_FIX: Record<string, string> = { '0': 'G', '8': 'B', '6': 'G', '5': 'S', '1': 'Y', '4': 'Y' };

/** Normalize a user query: trim, uppercase, drop inner whitespace. */
export function normalizeQuery(q: string): string {
  return q.trim().toUpperCase().replace(/\s+/g, '');
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Turn raw OCR text into a valid code, or null. Tries the text as-is, then
 * applies common OCR confusions in the digit part (O→0, I→1, S→5, B→8 …)
 * and in the prefix (0→G, 8→B). Returns the correction count as a penalty.
 */
export function parseCode(raw: string): { code: string; fixes: number } | null {
  // Case is meaningful to the recognizer but codes are uppercase; lowercase letters
  // count as a repair because the printed codes never contain them.
  const stripped = raw.replace(/[^A-Za-z0-9]/g, '');
  const t = stripped.toUpperCase();
  if (!t) return null;
  const caseFixes = stripped === t ? 0 : 1;
  // Special all-digit codes (0, 120) have no prefix to anchor on: accept exact reads only.
  if (SPECIAL.has(t)) return stripped === t ? { code: t, fixes: 0 } : null;
  if (isValidCode(t)) return { code: t, fixes: caseFixes };
  // Prefix repairs need at least one real letter to anchor on.
  const hasLetter = /[A-Z]/.test(t);
  let best: { code: string; fixes: number } | null = null;
  // Split into prefix (1–3 chars) + digits (1–3 chars) and repair each part.
  for (let p = 0; p <= 3 && p < t.length; p++) {
    const prefix = t.slice(0, p);
    const digits = t.slice(p);
    if (digits.length < 1 || digits.length > 3) continue;
    if (!hasLetter && p > 0) continue;
    let fixes = caseFixes;
    const fixedPrefix = [...prefix].map((ch) => (/[A-Z]/.test(ch) ? ch : (fixes++, LETTER_FIX[ch] ?? ch))).join('');
    const fixedDigits = [...digits].map((ch) => (/[0-9]/.test(ch) ? ch : (fixes++, DIGIT_FIX[ch] ?? ch))).join('');
    const cand = fixedPrefix + fixedDigits;
    if (SPECIAL.has(cand)) continue;
    if (isValidCode(cand) && (!best || fixes < best.fixes)) best = { code: cand, fixes };
  }
  return best && best.fixes <= 1 ? best : null;
}
