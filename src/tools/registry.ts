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

export interface RegisteredOperation {
  name: string;
  schema: z.ZodType | undefined;
  run: AnyHandler;
  /** Operations that only read are pointless in a batch, and are refused there. */
  readOnly: boolean;
}

export class ToolRegistry {
  private operations = new Map<string, RegisteredOperation>();

  /** The underlying server, for the few registrations that are not tools (resources). */
  constructor(readonly server: McpServer) {}

  tool<T extends z.ZodType>(
    name: string,
    config: ToolConfig<T>,
    handler: (args: z.infer<T>) => ToolResult | Promise<ToolResult>,
  ): void {
    this.server.registerTool(name, config as never, handler as never);
    this.operations.set(name, {
      name,
      schema: config.inputSchema,
      run: handler as AnyHandler,
      readOnly: config.annotations?.readOnlyHint === true,
    });
  }

  operation(name: string): RegisteredOperation | undefined {
    return this.operations.get(name);
  }

  /** Names that may appear in a batch, in registration order. */
  batchableNames(): string[] {
    return [...this.operations.values()].filter((o) => !o.readOnly).map((o) => o.name);
  }
}
