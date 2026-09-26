// Tool registration that keeps a callable record of every tool, so `batch` can run them itself.
//
// Registering straight on the McpServer would leave the handlers reachable only through the
// protocol. Going through a registry costs nothing at call time and gives batch a supported way to
// dispatch, instead of reaching into the SDK's private tool table.
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { ToolResult } from './shared.ts';

type AnyHandler = (args: never) => ToolResult | Promise<ToolResult>;

interface ToolConfig<T extends z.ZodType> {
  title?: string;
  description?: string;
  inputSchema?: T;
  outputSchema?: z.ZodType;
  annotations?: Record<string, unknown>;
}

/**
 * Write tools that delete or overwrite existing content, or files outside the document. Clients
 * treat `destructiveHint` as a cue to confirm with the user first; every other write tool only
 * adds to or restyles the open document.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'save_document_as',
  'set_text',
  'find_and_replace',
  'insert_special_characters',
  'thread_text_frames',
  'edit_table_structure',
  'merge_table_cells',
  'delete_text_variable',
  'relink_image',
  'unembed_images',
  'package_document',
  'export_document',
  'edit_item',
  'edit_pages',
  'edit_masters',
  'edit_layers',
  'batch',
]);

/** Tools that reach a service outside this computer. */
const OPEN_WORLD_TOOLS = new Set(['generate_image', 'edit_image', 'wait_for_image']);

/**
 * Every tool declares whether it only reads; a write tool that does not say otherwise gets its
 * `destructiveHint` from DESTRUCTIVE_TOOLS.
 */
function withDefaultAnnotations(name: string, annotations: Record<string, unknown> | undefined) {
  if (annotations?.readOnlyHint === true) return annotations;
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    ...(OPEN_WORLD_TOOLS.has(name) ? { openWorldHint: true } : {}),
    ...annotations,
  };
}

export interface RegisteredOperation {
  name: string;
  schema: z.ZodType | undefined;
  run: AnyHandler;
  /** Read-only operations are allowed in a batch, but the pending writes are flushed first. */
  readOnly: boolean;
}

export interface RegisteredVariant {
  family: string;
  key: string;
  description: string;
  schema: z.ZodType | undefined;
  run: AnyHandler;
}

export class ToolRegistry {
  private operations = new Map<string, RegisteredOperation>();
  private families = new Map<string, Map<string, RegisteredVariant>>();

  /** The underlying server, for the few registrations that are not tools (resources). */
  constructor(readonly server: McpServer) {}

  tool<T extends z.ZodType>(
    name: string,
    config: ToolConfig<T>,
    handler: (args: z.infer<T>) => ToolResult | Promise<ToolResult>,
  ): void {
    const annotations = withDefaultAnnotations(name, config.annotations);
    this.server.registerTool(name, { ...config, annotations } as never, handler as never);
    this.operations.set(name, {
      name,
      schema: config.inputSchema,
      run: handler as AnyHandler,
      readOnly: config.annotations?.readOnlyHint === true,
    });
  }

  /**
   * One variant of a merged tool: it is not registered on its own, but collected so
   * `registerFamilyTool` can expose the whole family under a single name.
   */
  variant<T extends z.ZodType>(
    family: string,
    key: string,
    config: ToolConfig<T>,
    handler: (args: z.infer<T>) => ToolResult | Promise<ToolResult>,
  ): void {
    let group = this.families.get(family);
    if (!group) {
      group = new Map();
      this.families.set(family, group);
    }
    group.set(key, {
      family,
      key,
      description: config.description ?? config.title ?? key,
      schema: config.inputSchema,
      run: handler as AnyHandler,
    });
  }

  /** Shorthand for the read-only `list` family. */
  listing<T extends z.ZodType>(
    key: string,
    config: ToolConfig<T>,
    handler: (args: z.infer<T>) => ToolResult | Promise<ToolResult>,
  ): void {
    this.variant('list', key, config, handler);
  }

  variants(family: string): RegisteredVariant[] {
    return [...(this.families.get(family)?.values() ?? [])];
  }

  variantFor(family: string, key: string): RegisteredVariant | undefined {
    return this.families.get(family)?.get(key);
  }

  operation(name: string): RegisteredOperation | undefined {
    return this.operations.get(name);
  }

  /** Names that may appear in a batch, in registration order. */
  batchableNames(): string[] {
    return [...this.operations.values()].map((o) => o.name);
  }
}
