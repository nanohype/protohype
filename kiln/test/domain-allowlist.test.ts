import { validateChangelogUrl, getAllowedHostnames, DomainNotAllowed } from '../lambda/shared/domain-allowlist';

describe('validateChangelogUrl', () => {
  it('accepts github.com URLs', () => {
    const url = validateChangelogUrl('https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0');
    expect(url.hostname).toBe('github.com');
  });

  it('accepts raw.githubusercontent.com URLs', () => {
    const url = validateChangelogUrl('https://raw.githubusercontent.com/org/repo/main/CHANGELOG.md');
    expect(url.hostname).toBe('raw.githubusercontent.com');
  });

  it('accepts npmjs.com URLs', () => {
    const url = validateChangelogUrl('https://www.npmjs.com/package/react/v/18.0.0');
    expect(url.hostname).toBe('www.npmjs.com');
  });

  it('accepts docs.aws.amazon.com URLs', () => {
    const url = validateChangelogUrl('https://docs.aws.amazon.com/');
    expect(url.hostname).toBe('docs.aws.amazon.com');
  });

  it('accepts subdomains of allowed hosts', () => {
    const url = validateChangelogUrl('https://docs.github.com/en/rest');
    expect(url.hostname).toBe('docs.github.com');
  });

  it('rejects internal/private URLs', () => {
    expect(() => validateChangelogUrl('https://evil.com/steal-tokens')).toThrow(DomainNotAllowed);
  });

  it('rejects non-http protocols', () => {
    expect(() => validateChangelogUrl('ftp://github.com/file')).toThrow(DomainNotAllowed);
  });

  it('rejects malformed URLs', () => {
    expect(() => validateChangelogUrl('not-a-url')).toThrow();
  });

  it('rejects localhost', () => {
    expect(() => validateChangelogUrl('http://localhost:8080/changelog')).toThrow(DomainNotAllowed);
  });

  it('has a non-empty allowlist', () => {
    const allowlist = getAllowedHostnames();
    expect(allowlist.size).toBeGreaterThan(5);
  });
});
