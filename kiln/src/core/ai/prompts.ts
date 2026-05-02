// Prompt authoring. Pure text — no Bedrock SDK, no HTTP.
// Adapters/bedrock invokes these prompts and parses the responses.

export interface ClassifierPromptInput {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  changelogBody: string;
}

export interface SynthesizerPromptInput {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  breakingChangeDescription: string;
  affectedSymbols: string[];
  callSites: Array<{ path: string; line: number; snippet: string }>;
}

export interface Prompt {
  system: string;
  user: string;
}

export function classifierPrompt(input: ClassifierPromptInput): Prompt {
  return {
    system: [
      "You classify breaking changes in JavaScript/TypeScript package changelogs.",
      "Return strict JSON matching the provided schema. No prose, no markdown fences.",
      "A 'breaking change' is anything requiring code changes in consumers: removed APIs, renamed exports, changed signatures, changed runtime behavior, removed or changed type definitions. Version bumps of peer deps only count if they change consumer signatures.",
      "Deprecations are warnings; behavior-changes alter runtime output for same input.",
    ].join("\n"),
    user: [
      `Package: ${input.pkg}`,
      `Version range: ${input.fromVersion} → ${input.toVersion}`,
      "",
      "Changelog excerpt:",
      "```",
      input.changelogBody.slice(0, 20_000), // hard cap — Haiku budget
      "```",
      "",
      "Output JSON:",
      '{"breakingChanges":[{"id":"stable-slug","title":"short","severity":"breaking|deprecation|behavior-change","description":"what changed and what consumer code must do","affectedSymbols":["fooBar","Baz"],"changelogUrl":"https://..."}],"summary":"one-paragraph overview","confidence":0.0-1.0}',
    ].join("\n"),
  };
}

export function synthesizerPrompt(input: SynthesizerPromptInput): Prompt {
  const callSitesRendered = input.callSites
    .map((c) => `// ${c.path}:${c.line}\n${c.snippet}`)
    .join("\n\n---\n\n");

  return {
    system: [
      "You rewrite call sites to adapt to a breaking package change.",
      "Output strict JSON: an array of { path, before, after, citations }.",
      "Preserve surrounding code exactly. Do not invent APIs. If a call site cannot be safely rewritten without context you don't have, emit a warning instead of guessing.",
      "Never rewrite symbols outside the affected list.",
    ].join("\n"),
    user: [
      `Package: ${input.pkg}  ${input.fromVersion} → ${input.toVersion}`,
      "Breaking change:",
      input.breakingChangeDescription,
      `Affected symbols: ${input.affectedSymbols.join(", ")}`,
      "",
      "Call sites:",
      callSitesRendered,
      "",
      "Return JSON:",
      '{"patches":[{"path":"src/x.ts","before":"...","after":"...","citations":["https://changelog-url#..."]}],"notes":"reviewer guidance","warnings":["unsafe site: src/y.ts:42 — ambiguous type"]}',
    ].join("\n"),
  };
}
