/**
 * Tests for the route parser.
 */

import { describe, it, expect } from 'vitest';
import { parseServiceKey } from '../src/router.js';

describe('parseServiceKey', () => {
  it.each([
    ['/hubspot', 'hubspot'],
    ['/gdrive', 'gdrive'],
    ['/gcal', 'gcal'],
    ['/analytics', 'analytics'],
    ['/gcse', 'gcse'],
    ['/stripe', 'stripe'],
    ['/HUBSPOT', 'hubspot'],        // case-insensitive
    ['/HubSpot', 'hubspot'],
    ['/stripe/extra/path', 'stripe'], // sub-paths work
  ])('parseServiceKey("%s") → "%s"', (path, expected) => {
    expect(parseServiceKey(path)).toBe(expected);
  });

  it.each([
    '/unknown',
    '/health',
    '/',
    '',
    '/foo/bar',
  ])('throws for invalid path: %s', (path) => {
    expect(() => parseServiceKey(path)).toThrow();
  });
});
