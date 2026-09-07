/**
 * Shared response-budget assembler (bound-corpus-scale-workflows task 3.3):
 * response-producing surfaces (tool/resource result builders) whose output
 * scales with an array of stored records — search/recall matches, a large
 * `memory://list` page, and so on — call `assembleWithinCharBudget` while
 * building that array so the assembled response's serialized size never
 * exceeds `defaults.max_response_chars`, instead of the array growing
 * unboundedly with corpus size or match count.
 *
 * Truncation happens BEFORE serialization, one candidate item at a time —
 * never by slicing the final JSON string, which risks invalid or ambiguous
 * (truncated mid-value) output (see design.md Decision #6). A caller whose
 * items got cut receives `truncated: true` so the omission is visible
 * rather than silently indistinguishable from "there were no more
 * matches" — see `corpus-scale-work-bounds`'s "Tool and resource responses
 * SHALL honor a character budget" requirement.
 */
export interface BudgetedAssembly<T> {
  items: T[];
  /** True when one or more trailing candidate items were left out to stay within budget. */
  truncated: boolean;
}

/**
 * Includes items from `candidates`, in order, while their combined
 * `JSON.stringify` length (plus the `,` separators joining them in the
 * final array) stays within `maxChars - reservedChars`. `reservedChars`
 * accounts for whatever the caller wraps this array in — other response
 * fields, the array's own brackets, an enclosing object — so the *whole*
 * response this array ends up inside of stays within `maxChars`, not just
 * the array by itself.
 *
 * Always includes at least the first item, even if it alone exceeds the
 * remaining budget — a request for anything at all should get one useful
 * result rather than an unconditionally empty array; `truncated` is still
 * reported so the caller knows even that single item didn't leave room for
 * more, and can act on it (narrow the query, request less).
 */
export function assembleWithinCharBudget<T>(
  candidates: T[],
  maxChars: number,
  reservedChars = 0,
): BudgetedAssembly<T> {
  const budget = Math.max(0, maxChars - reservedChars);
  const kept: T[] = [];
  let used = 0;

  for (const candidate of candidates) {
    // Every kept item after the first costs one extra byte for the `,`
    // joining it to its predecessor in the serialized array.
    const separatorChars = kept.length > 0 ? 1 : 0;
    const itemChars = JSON.stringify(candidate).length + separatorChars;

    if (kept.length > 0 && used + itemChars > budget) {
      return { items: kept, truncated: true };
    }

    kept.push(candidate);
    used += itemChars;
  }

  return { items: kept, truncated: false };
}
