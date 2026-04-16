/**
 * `RedactedText` is a compile-time marker that a string has passed
 * through the PII redactor. Production callers acquire a `RedactedText`
 * in exactly two ways:
 *
 *   1. As the output of `createPiiRedactor` — the redactor itself
 *      brands the value after running the regex + Comprehend pass.
 *   2. By rehydrating a value from the `feedback_items.redacted_text`
 *      column via `rehydrateRedacted` — the DB contract is that rows
 *      were written only via the redactor, so the brand is recovered
 *      at the repository boundary.
 *
 * Tests construct fixtures via `asRedactedForTests`. Do not call that
 * from production code; the name is the guardrail.
 */
export type RedactedText = string & { readonly __brand: 'RedactedText' };

/**
 * Recover the `RedactedText` brand for a value read out of the
 * `redacted_text` column. The repository is the only legitimate
 * caller.
 */
export function rehydrateRedacted(s: string): RedactedText {
  return s as RedactedText;
}

/**
 * Test-only fixture constructor. Production code must not call this.
 */
export function asRedactedForTests(s: string): RedactedText {
  return s as RedactedText;
}
