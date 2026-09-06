// The version arithmetic behind the release workflow's patch/minor/major input.
import { describe, expect, test } from 'bun:test';
import { isBump, latestReleaseTag, nextVersion, parseVersion, planRelease } from '../scripts/version.ts';

describe('version numbers', () => {
  test('bumps each part and resets the ones below it', () => {
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(nextVersion('v0.1.0', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.9.9', 'major')).toBe('1.0.0');
  });

  test('refuses anything that is not a version', () => {
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('1.2.3-beta.1')).toBeUndefined();
    expect(() => nextVersion('nightly', 'patch')).toThrow(/not a version/);
    expect(isBump('patch')).toBe(true);
    expect(isBump('Patch')).toBe(false);
  });

  test('the newest tag is the highest version, not the last one listed', () => {
    expect(latestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.2.0'])).toBe('v0.10.0');
    expect(latestReleaseTag(['v1.0.0', 'v1.0.0-rc.1', 'nightly'])).toBe('v1.0.0');
    expect(latestReleaseTag([])).toBeUndefined();
    expect(latestReleaseTag(['nightly'])).toBeUndefined();
  });

  test('the first release keeps the version the repository already declares', () => {
    expect(planRelease([], '0.1.0', 'patch')).toEqual({ version: '0.1.0', base: undefined, first: true });
    expect(planRelease([], '0.1.0', 'major')).toEqual({ version: '0.1.0', base: undefined, first: true });
  });

  test('later releases count up from the newest tag, whatever package.json says', () => {
    expect(planRelease(['v0.1.0'], '0.1.0', 'patch')).toEqual({
      version: '0.1.1',
      base: 'v0.1.0',
      first: false,
    });
    // a package.json left behind by a hand edit does not shift the next version
    expect(planRelease(['v1.4.2'], '0.0.1', 'minor')).toEqual({
      version: '1.5.0',
      base: 'v1.4.2',
      first: false,
    });
  });
});
