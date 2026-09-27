/**
 * Tiny subsequence scorer — fast enough for a few thousand commands and
 * predictable enough that the top hit is almost always the one you meant.
 */
interface Scored {
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, text: string): Scored | null {
  if (!query) return { score: 1, indices: [] };

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    const wordStart = direct === 0 || /[\s/_.:-]/.test(haystack[direct - 1] ?? "");
    const score = 100 - direct * 0.5 + (wordStart ? 20 : 0) - (text.length - needle.length) * 0.1;
    const indices = Array.from({ length: needle.length }, (_, i) => direct + i);
    return { score, indices };
  }

  let score = 0;
  let textIndex = 0;
  let previousIndex = -2;
  const indices: number[] = [];

  for (const char of needle) {
    const found = haystack.indexOf(char, textIndex);
    if (found === -1) return null;
    score += found === previousIndex + 1 ? 6 : 2;
    if (found === 0 || /[\s/_.:-]/.test(haystack[found - 1] ?? "")) score += 4;
    indices.push(found);
    previousIndex = found;
    textIndex = found + 1;
  }

  return { score: score - text.length * 0.05, indices };
}

/** Highlights the matched characters of a label. */
export function highlightParts(
  label: string,
  indices: number[],
): Array<{ text: string; match: boolean }> {
  if (indices.length === 0) return [{ text: label, match: false }];
  const set = new Set(indices);
  const parts: Array<{ text: string; match: boolean }> = [];
  let buffer = "";
  let bufferMatch = set.has(0);

  for (let i = 0; i < label.length; i += 1) {
    const isMatch = set.has(i);
    if (isMatch !== bufferMatch && buffer) {
      parts.push({ text: buffer, match: bufferMatch });
      buffer = "";
    }
    bufferMatch = isMatch;
    buffer += label[i];
  }
  if (buffer) parts.push({ text: buffer, match: bufferMatch });
  return parts;
}
