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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const unit = (env.INDESIGN_MCP_DEFAULT_UNIT ?? 'mm').toLowerCase();
  const validUnits: Unit[] = ['mm', 'cm', 'in', 'pt', 'px', 'p'];
  return {
    unit: (validUnits as string[]).includes(unit) ? (unit as Unit) : 'mm',
    documentsDir: expandHome(env.INDESIGN_MCP_DOCUMENTS ?? join(homedir(), 'Documents', 'InDesign MCP')),
    referenceDirs: (env.INDESIGN_MCP_REFERENCES ?? '')
      .split(/[;:]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(expandHome),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    imageModel: env.INDESIGN_MCP_IMAGE_MODEL?.trim() || 'gpt-image-2',
    schemaDir: env.INDESIGN_MCP_SCHEMA_DIR ? expandHome(env.INDESIGN_MCP_SCHEMA_DIR) : undefined,
  };
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
