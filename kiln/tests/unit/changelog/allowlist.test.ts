import { describe, expect, it } from "vitest";
import { isChangelogHostAllowed } from "../../../src/core/changelog/allowlist.js";

describe("changelog allowlist", () => {
  it.each([
    "https://github.com/facebook/react/releases/tag/v18.0.0",
    "https://raw.githubusercontent.com/facebook/react/HEAD/CHANGELOG.md",
    "https://registry.npmjs.org/react",
  ])("allows %s", (url) => {
    expect(isChangelogHostAllowed(url)).toBe(true);
  });

  it.each([
    "http://github.com/x/y", // no http
    "https://evil.example.com/exfil",
    "file:///etc/passwd",
    "https://169.254.169.254/", // link-local (EC2 metadata)
    "javascript:alert(1)",
  ])("rejects %s", (url) => {
    expect(isChangelogHostAllowed(url)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isChangelogHostAllowed("not a url")).toBe(false);
    expect(isChangelogHostAllowed("")).toBe(false);
  });
});
