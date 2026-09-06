// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${user_config.*} placeholders are substituted by Claude Desktop at install time
// Builds Claude Desktop extension bundles (.mcpb), one per platform, from the compiled binaries.
//   bun run scripts/build-mcpb.ts --dist dist --out dist/bundles
// Requires network access for `npx @anthropic-ai/mcpb` (or a locally installed mcpb CLI).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const distDir = opt('dist', 'dist');
const outDir = opt('out', 'dist/bundles');
mkdirSync(outDir, { recursive: true });

interface Target {
  key: string;
  platform: 'darwin' | 'win32';
  binaryPattern: RegExp;
  binaryName: string;
}

const TARGETS: Target[] = [
  { key: 'macos-arm64', platform: 'darwin', binaryPattern: /-macos-arm64$/, binaryName: 'indesign-mcp' },
  { key: 'macos-x64', platform: 'darwin', binaryPattern: /-macos-x64$/, binaryName: 'indesign-mcp' },
  {
    key: 'windows-x64',
    platform: 'win32',
    binaryPattern: /-windows-x64\.exe$/,
    binaryName: 'indesign-mcp.exe',
  },
];

const files = readdirSync(distDir);
let built = 0;
for (const t of TARGETS) {
  const bin = files.find((f) => t.binaryPattern.test(f));
  if (!bin) {
    console.warn(`skip ${t.key}: no binary matching ${t.binaryPattern} in ${distDir}`);
    continue;
  }
  const stage = join(outDir, `stage-${t.key}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'server'), { recursive: true });
  copyFileSync(join(distDir, bin), join(stage, 'server', t.binaryName));
  chmodSync(join(stage, 'server', t.binaryName), 0o755);
  const manifest = {
    manifest_version: '0.3',
    name: 'indesign-mcp',
    display_name: 'InDesign (IDML) for Claude',
    version: pkg.version,
    description:
      'Create and edit Adobe InDesign documents (IDML), generate images with OpenAI and preview pages, directly from Claude.',
    long_description:
      "Lets Claude create InDesign documents from scratch or from your reference files: pages and master pages, text frames with paragraph and character styles, swatches, layers, placed and AI-generated pictures. Every change is validated against Adobe's IDML schema and can be previewed as an image. Open the resulting .idml files in InDesign.",
    author: { name: 'New Dawn', url: 'https://github.com/hofmeister/indesign-mcp' },
    repository: { type: 'git', url: 'https://github.com/hofmeister/indesign-mcp' },
    homepage: 'https://github.com/hofmeister/indesign-mcp',
    license: 'MIT',
    keywords: ['indesign', 'idml', 'layout', 'design', 'print', 'openai', 'images'],
    server: {
      type: 'binary',
      entry_point: `server/${t.binaryName}`,
      mcp_config: {
        command: `\${__dirname}/server/${t.binaryName}`,
        args: [],
        env: {
          OPENAI_API_KEY: '${user_config.openai_api_key}',
          INDESIGN_MCP_DOCUMENTS: '${user_config.documents_folder}',
          INDESIGN_MCP_REFERENCES: '${user_config.references_folder}',
          INDESIGN_MCP_IMAGE_MODEL: '${user_config.image_model}',
        },
      },
    },
    user_config: {
      openai_api_key: {
        type: 'string',
        title: 'OpenAI API key',
        description:
          'Needed only for generating and editing pictures with AI (generate_image / edit_image). Leave empty to disable.',
        sensitive: true,
        required: false,
      },
      documents_folder: {
        type: 'directory',
        title: 'Documents folder',
        description: 'Where new InDesign documents are saved when you only give a file name.',
        required: false,
        default: '${DOCUMENTS}/InDesign MCP',
      },
      references_folder: {
        type: 'directory',
        title: 'Reference documents folder',
        description:
          'A folder with your own .idml files that Claude may use as references (styles, masters, pages).',
        required: false,
      },
      image_model: {
        type: 'string',
        title: 'OpenAI image model',
        description: 'gpt-image-2 (default), gpt-image-1.5 or gpt-image-1-mini.',
        required: false,
        default: 'gpt-image-2',
      },
    },
    compatibility: {
      claude_desktop: '>=0.10.0',
      platforms: [t.platform],
    },
  };
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const out = join(outDir, `indesign-mcp-${pkg.version}-${t.key}.mcpb`);
  rmSync(out, { force: true });
  const proc = Bun.spawnSync(['npx', '--yes', '@anthropic-ai/mcpb', 'pack', stage, out], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0 || !existsSync(out)) {
    // fallback: a plain zip with the same layout (an .mcpb is a zip archive)
    console.warn(`mcpb pack failed for ${t.key} (exit ${proc.exitCode}); falling back to zip`);
    const zip = Bun.spawnSync(['zip', '-r', '-q', out, '.'], {
      cwd: stage,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (zip.exitCode !== 0) throw new Error(`could not build bundle for ${t.key}`);
  }
  rmSync(stage, { recursive: true, force: true });
  console.log(`built ${out}`);
  built++;
}
if (!built) {
  console.error('no bundles built');
  process.exit(1);
}
