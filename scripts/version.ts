// Works out the version of the next release and, with --write, puts it in package.json.
//
//   bun run scripts/version.ts --bump minor            # prints the next version
//   bun run scripts/version.ts --bump patch --write    # and writes it to package.json
//
// The base is the newest release tag in the repository (v1.2.3); with no tags yet the version in
// package.json is released as it stands, so the first release is the one the repo already declares.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Bump = 'patch' | 'minor' | 'major';

export function isBump(value: string): value is Bump {
  return value === 'patch' || value === 'minor' || value === 'major';
}

/** Parses "v1.2.3" or "1.2.3"; anything else (pre-releases included) is not a release version. */
export function parseVersion(value: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function nextVersion(base: string, bump: Bump): string {
  const parsed = parseVersion(base);
  if (!parsed) throw new Error(`"${base}" is not a version like 1.2.3`);
  const [major, minor, patch] = parsed;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The newest release tag, by version order rather than by date. */
export function latestReleaseTag(tags: string[]): string | undefined {
  const versions = tags
    .map((t) => ({ tag: t, v: parseVersion(t) }))
    .filter((x): x is { tag: string; v: [number, number, number] } => x.v !== undefined)
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return versions.at(-1)?.tag;
}

export interface Release {
  version: string;
  base: string | undefined;
  /** True when there was no tag yet and package.json's version is released as it stands. */
  first: boolean;
}

export function planRelease(tags: string[], packageVersion: string, bump: Bump): Release {
  const latest = latestReleaseTag(tags);
  if (!latest) return { version: packageVersion, base: undefined, first: true };
  return { version: nextVersion(latest, bump), base: latest, first: false };
}

function gitTags(): string[] {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const bumpArg = args[args.indexOf('--bump') + 1] ?? 'patch';
  if (!isBump(bumpArg)) {
    console.error(`--bump must be patch, minor or major (got "${bumpArg}")`);
    process.exit(2);
  }
  const pkgPath = join(import.meta.dir, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  const plan = planRelease(gitTags(), pkg.version, bumpArg);
  if (args.includes('--write') && pkg.version !== plan.version) {
    // keep the file's formatting: only the version line changes
    const text = readFileSync(pkgPath, 'utf8');
    writeFileSync(pkgPath, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${plan.version}$2`));
  }
  if (args.includes('--github') && process.env.GITHUB_OUTPUT) {
    const out = [
      `version=${plan.version}`,
      `tag=v${plan.version}`,
      `base=${plan.base ?? ''}`,
      `first=${plan.first}`,
    ].join('\n');
    writeFileSync(process.env.GITHUB_OUTPUT, `${out}\n`, { flag: 'a' });
  }
  console.log(plan.version);
}
