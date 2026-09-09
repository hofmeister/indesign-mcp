// `indesign-mcp setup` and `indesign-mcp doctor`: install for Claude and check the machine.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { createTextFrame } from './idml/items.ts';
import { validateAgainstSchema } from './idml/schema.ts';
import { createDocument } from './idml/template.ts';
import { validateDocument } from './idml/validate.ts';
import { VERSION } from './version.ts';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function claudeDesktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return join(
        process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json',
      );
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
        'Claude',
        'claude_desktop_config.json',
      );
  }
}

function binaryPath(): string {
  // In a compiled binary this is the executable; when run from source it is bun itself.
  const exe = process.execPath;
  if (/\/bun(\.exe)?$/.test(exe) || /\\bun\.exe$/i.test(exe)) {
    return `bun ${join(process.cwd(), 'src', 'cli.ts')}`;
  }
  return exe;
}

async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value ? new TextDecoder().decode(value).trim() : '';
}

export async function runSetup(argv: string[]): Promise<void> {
  const print = flag(argv, 'print');
  const onlyDesktop = flag(argv, 'claude-desktop');
  const onlyCode = flag(argv, 'claude-code');
  const documents = arg(argv, 'documents') ?? join(homedir(), 'Documents', 'InDesign MCP');
  const references = arg(argv, 'references');
  let openaiKey = arg(argv, 'openai-key') ?? process.env.OPENAI_API_KEY;
  const interactive = process.stdin.isTTY && !print;
  console.log(`indesign-mcp ${VERSION} setup\n`);
  if (!openaiKey && interactive) {
    openaiKey = (await ask('OpenAI API key for image generation (press Enter to skip): ')) || undefined;
  }
  const env: Record<string, string> = { INDESIGN_MCP_DOCUMENTS: documents };
  if (openaiKey) env.OPENAI_API_KEY = openaiKey;
  if (references) env.INDESIGN_MCP_REFERENCES = references;
  const command = binaryPath();
  const invocation = (extra: string[]) =>
    command.startsWith('bun ')
      ? { command: 'bun', args: [command.slice(4), ...extra] }
      : { command, args: extra };
  const entry = { ...invocation([]), env };

  // The image server is the same binary started with `images`: it needs only the key and a folder.
  const withImages = flag(argv, 'images');
  const imagesOutput = arg(argv, 'images-output');
  const imageEnv: Record<string, string> = {};
  if (openaiKey) imageEnv.OPENAI_API_KEY = openaiKey;
  if (imagesOutput) imageEnv.IMAGE_MCP_OUTPUT = imagesOutput;
  const imageEntry = { ...invocation(['images']), env: imageEnv };
  const servers: Record<string, typeof entry> = { indesign: entry };
  if (withImages) servers['openai-images'] = imageEntry;
  if (withImages && !openaiKey)
    console.log('Note: the image server needs an OpenAI key; pass --openai-key to make it work.\n');

  if (platform() === 'darwin' && !command.startsWith('bun ')) {
    // Downloaded binaries carry a quarantine flag that stops Claude Desktop from launching them.
    spawnSync('xattr', ['-d', 'com.apple.quarantine', command], { stdio: 'ignore' });
  }

  if (!onlyCode) {
    const path = claudeDesktopConfigPath();
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(path)) {
      try {
        config = JSON.parse(readFileSync(path, 'utf8'));
      } catch (e) {
        throw new Error(
          `${path} is not valid JSON: ${(e as Error).message}. Fix or remove it and run setup again.`,
        );
      }
    }
    config.mcpServers = { ...(config.mcpServers ?? {}), ...servers };
    const json = `${JSON.stringify(config, null, 2)}\n`;
    if (print) {
      console.log(`Claude Desktop (${path}):\n${json}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, json);
      console.log(
        `✔ Claude Desktop configured: ${path}\n  Restart Claude Desktop, then ask Claude e.g. "Create an A4 flyer called summer-sale".`,
      );
    }
  }
  if (!onlyDesktop) {
    const hasClaude =
      print ||
      spawnSync(platform() === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' }).status === 0;
    for (const [name, server] of Object.entries(servers)) {
      const envArgs = Object.entries(server.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const cmd = ['claude', 'mcp', 'add', name, ...envArgs, '--', server.command, ...server.args];
      const shown = cmd.map((c) => (/[\s"]/.test(c) ? JSON.stringify(c) : c)).join(' ');
      if (print) {
        console.log(`Claude Code:\n  ${shown}`);
      } else if (hasClaude) {
        const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'inherit' });
        console.log(
          r.status === 0
            ? `✔ Claude Code configured (claude mcp add ${name}).`
            : `Claude Code registration failed; run manually:\n  ${shown}`,
        );
      } else {
        console.log(`Claude Code CLI not found. If you use Claude Code, run:\n  ${shown}`);
      }
    }
  }
  if (!openaiKey)
    console.log(
      '\nNote: no OpenAI key given, so generate_image / edit_image are disabled. Re-run setup with --openai-key to enable them.',
    );
}

export async function runDoctor(): Promise<void> {
  const config = loadConfig();
  const lines: string[] = [
    `indesign-mcp ${VERSION}`,
    `Executable: ${binaryPath()}`,
    `Platform: ${platform()} (${process.arch}), Bun ${typeof Bun !== 'undefined' ? Bun.version : '?'}`,
    `Default unit: ${config.unit}`,
    `Documents folder: ${config.documentsDir}${existsSync(config.documentsDir) ? '' : ' (will be created on first use)'}`,
    `Reference folders: ${config.referenceDirs.length ? config.referenceDirs.join(', ') : 'none (bundled references only)'}`,
    `OpenAI image generation: ${config.openaiApiKey ? `enabled (${config.imageModel})` : 'disabled — set OPENAI_API_KEY to enable'}`,
  ];
  try {
    // Detection only says the application is on disk; ask it to run a script so the report reflects
    // whether exact previews can actually be made right now.
    const { probeInDesignScripting } = await import('./preview/indesign.ts');
    const probe = await probeInDesignScripting();
    if (probe.ok) lines.push(`Adobe InDesign: ${probe.app} (exact previews available)`);
    else if (probe.reason === 'not-installed')
      lines.push('Adobe InDesign: not found (built-in preview renderer will be used)');
    else
      lines.push(
        `Adobe InDesign: ${probe.app} found, but it will not run scripts — the built-in renderer will be used.\n  ${probe.message}`,
      );
  } catch (e) {
    lines.push(`Adobe InDesign: detection failed (${(e as Error).message})`);
  }
  try {
    const { fontCatalog } = await import('./preview/fonts.ts');
    const t0 = performance.now();
    const fams = fontCatalog().families();
    lines.push(
      `Fonts for previews: ${fams.length} families found in ${Math.round(performance.now() - t0)} ms`,
    );
  } catch (e) {
    lines.push(`Fonts: scan failed (${(e as Error).message})`);
  }
  const claudePath = claudeDesktopConfigPath();
  if (existsSync(claudePath)) {
    try {
      const cfg = JSON.parse(readFileSync(claudePath, 'utf8')) as { mcpServers?: Record<string, unknown> };
      lines.push(
        `Claude Desktop config: ${cfg.mcpServers?.indesign ? 'indesign server registered' : 'found, but indesign is not registered (run: indesign-mcp setup)'}`,
      );
    } catch {
      lines.push(`Claude Desktop config: ${claudePath} is not valid JSON`);
    }
  } else
    lines.push(
      'Claude Desktop config: not found (fine if you installed the .mcpb bundle or use Claude Code)',
    );
  // self-test: create, validate, preview
  const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-doctor-'));
  try {
    const doc = createDocument({ pageSize: 'A4' });
    createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 40, y: 40, width: 300, height: 80 }, text: 'Doctor test' },
    );
    const path = join(dir, 'doctor.idml');
    doc.save(path);
    const errors = validateDocument(doc).filter((i) => i.level === 'error').length;
    const schema = validateAgainstSchema(doc).issues.filter((i) => i.level === 'error').length;
    const { previewPage } = await import('./preview/index.ts');
    const t0 = performance.now();
    const r = await previewPage(doc, 1, { save: false, width: 400, renderer: 'builtin' });
    lines.push(
      `Self-test: document created, ${errors} structural error(s), ${schema} schema error(s), preview ${r.width}×${r.height} px in ${Math.round(performance.now() - t0)} ms — ${errors + schema === 0 ? 'OK' : 'PROBLEMS'}`,
    );
  } catch (e) {
    lines.push(`Self-test FAILED: ${(e as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
}
