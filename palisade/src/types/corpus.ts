export type AttackTaxonomy =
  | "role-reassignment"
  | "delimiter-injection"
  | "encoded-payload"
  | "jailbreak-personas"
  | "indirect-injection"
  | "data-exfiltration";

/**
 * A labeled + approved attack in the known-attack corpus. Written via the
 * label-approval gate and nowhere else — see src/gate/label-approval-gate.ts.
 */
export interface ApprovedSample {
  readonly corpusId: string;
  readonly bodySha256: string;
  readonly promptText: string;
  readonly embedding: Float32Array;
  readonly taxonomy: AttackTaxonomy;
  readonly label: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly sourceAttemptId: string;
}

export interface CorpusMatch {
  readonly corpusId: string;
  readonly taxonomy: AttackTaxonomy;
  readonly label: string;
  readonly similarity: number;
}
