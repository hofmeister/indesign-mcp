import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Unit } from './idml/units.ts';

export interface Config {
  /** Default unit for lengths given as bare numbers and used in output. */
  unit: Unit;
  /** Folder that bare file names resolve against. */
  documentsDir: string;
  /** Extra folders with reference IDML files. */
  referenceDirs: string[];
  openaiApiKey: string | undefined;
  imageModel: string;
  /** Folder with RELAX NG schemas for strict validation (optional). */
  schemaDir: string | undefined;
}

/**
 * A setting from the environment, trimmed, or undefined when it is empty. Claude Desktop passes an
 * optional extension setting the user left empty as its unsubstituted placeholder
 * (`${user_config.openai_api_key}`), so those count as empty too.
 */
export function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

/** Splits a folder list. `;` always separates; `:` only off Windows, where it follows a drive letter. */
export function splitPathList(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!value) return [];
  return value
    .split(platform === 'win32' ? /;/ : /[;:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const unit = (setting(env, 'INDESIGN_MCP_DEFAULT_UNIT') ?? 'mm').toLowerCase();
  const validUnits: Unit[] = ['mm', 'cm', 'in', 'pt', 'px', 'p'];
  const schemaDir = setting(env, 'INDESIGN_MCP_SCHEMA_DIR');
  return {
    unit: (validUnits as string[]).includes(unit) ? (unit as Unit) : 'mm',
    documentsDir: expandHome(
      setting(env, 'INDESIGN_MCP_DOCUMENTS') ?? join(homedir(), 'Documents', 'InDesign MCP'),
    ),
    referenceDirs: splitPathList(setting(env, 'INDESIGN_MCP_REFERENCES')).map(expandHome),
    openaiApiKey: setting(env, 'OPENAI_API_KEY'),
    imageModel: setting(env, 'INDESIGN_MCP_IMAGE_MODEL') ?? 'gpt-image-2',
    schemaDir: schemaDir ? expandHome(schemaDir) : undefined,
  };
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
