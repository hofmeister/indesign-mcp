// Cross-compiles the server into standalone executables with `bun build --compile`.
//   bun run scripts/build.ts            -> current platform only, dist/indesign-mcp[.exe]
//   bun run scripts/build.ts --all      -> every release target into dist/
//   bun run scripts/build.ts --target bun-darwin-arm64
import { mkdirSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };

export const RELEASE_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-windows-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
] as const;

export type Target = (typeof RELEASE_TARGETS)[number];

export function artifactName(target: string, version = pkg.version): string {
  const [, os, arch] = target.split('-');
  const osName = os === 'darwin' ? 'macos' : os;
  const ext = os === 'windows' ? '.exe' : '';
  return `indesign-mcp-${version}-${osName}-${arch}${ext}`;
}

async function compile(target: string | undefined): Promise<string> {
  mkdirSync('dist', { recursive: true });
  const outfile = target
    ? `dist/${artifactName(target)}`
    : `dist/indesign-mcp${process.platform === 'win32' ? '.exe' : ''}`;
  const args = [
    'build',
    '--compile',
    '--minify',
    '--sourcemap',
    `--define=APP_VERSION="${pkg.version}"`,
    ...(target ? [`--target=${target}`] : []),
    'src/cli.ts',
    '--outfile',
    outfile,
  ];
  const proc = Bun.spawn(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bun build failed for ${target ?? 'host'} (exit ${code})`);
  return outfile;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const targetIdx = argv.indexOf('--target');
  const targets: (string | undefined)[] = all
    ? [...RELEASE_TARGETS]
    : targetIdx >= 0
      ? [argv[targetIdx + 1]]
      : [undefined];
  for (const t of targets) {
    const out = await compile(t);
    console.log(`built ${out}`);
  }
}
