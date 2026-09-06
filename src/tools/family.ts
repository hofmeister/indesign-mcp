// Builds one tool out of a family of closely related ones.
//
// Thirteen `list_*` tools or ten item operations differ only in a couple of arguments each, and a
// separate tool per variant is most of what makes the tool list long. A family keeps every handler
// where it lives and exposes them under a single name with one discriminating argument.
//
// The merged schema is derived from the variants rather than written out again, so a parameter
// cannot drift from the handler that reads it. Each variant still validates its own arguments, so
// errors stay as precise as they were when it was its own tool.
import * as z from 'zod';
import type { RegisteredVariant, ToolRegistry } from './registry.ts';
import { fail, run, toolInput } from './shared.ts';

/** The `.shape` of a Zod object schema, when it is one. */
function shapeOf(schema: z.ZodType | undefined): Record<string, z.ZodType> | undefined {
  const candidate = schema as unknown as { shape?: Record<string, z.ZodType> } | undefined;
  return candidate?.shape && typeof candidate.shape === 'object' ? candidate.shape : undefined;
}

function isOptional(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}

/**
 * Merges the variants' parameters into one schema. A parameter every variant requires stays
 * required; anything else becomes optional and says which variants it belongs to, since the merged
 * tool cannot enforce that structurally.
 */
function mergedShape(
  variants: RegisteredVariant[],
  discriminator: string,
  keyName: string,
): Record<string, z.ZodType> {
  const order: string[] = [];
  const byKey = new Map<string, { schema: z.ZodType; usedBy: string[] }>();

  for (const variant of variants) {
    const shape = shapeOf(variant.schema);
    if (!shape) continue;
    for (const [key, schema] of Object.entries(shape)) {
      const existing = byKey.get(key);
      if (existing) {
        existing.usedBy.push(variant.key);
        continue;
      }
      order.push(key);
      byKey.set(key, { schema, usedBy: [variant.key] });
    }
  }

  const shape: Record<string, z.ZodType> = {
    [discriminator]: z
      .enum(variants.map((v) => v.key) as [string, ...string[]])
      .describe(`Which ${keyName} this is.`),
  };
  for (const key of order) {
    const entry = byKey.get(key)!;
    const everywhere = entry.usedBy.length === variants.length;
    const required = everywhere && !isOptional(entry.schema);
    const base = entry.schema.description ?? '';
    const scope = everywhere ? '' : `Only for ${entry.usedBy.join(', ')}.`;
    const description = [base, scope].filter(Boolean).join(' ');
    // A parameter only some variants take cannot be required by the merged schema; the variant
    // that owns it still refuses the call when it is missing.
    shape[key] = (required ? entry.schema : entry.schema.optional()).describe(description);
  }
  return shape;
}

export interface FamilyOptions {
  /** Tool name, e.g. "list" or "edit_item". */
  name: string;
  /** Registry family key the variants were registered under. */
  family: string;
  title: string;
  /** Argument that chooses the variant, e.g. "what" or "op". */
  discriminator: string;
  /** Word for the discriminator in generated text, e.g. "subject" or "operation". */
  keyName: string;
  description: (keys: string[]) => string;
  readOnly?: boolean;
}

export function registerFamilyTool(reg: ToolRegistry, options: FamilyOptions): void {
  const variants = reg.variants(options.family);
  if (!variants.length) return;
  const keys = variants.map((v) => v.key);

  reg.tool(
    options.name,
    {
      title: options.title,
      description: options.description(keys),
      inputSchema: toolInput(mergedShape(variants, options.discriminator, options.keyName)),
      ...(options.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
    async (args: Record<string, unknown>) =>
      run(async () => {
        const key = String(args[options.discriminator]);
        const variant = reg.variantFor(options.family, key);
        if (!variant) return fail(new Error(`Unknown ${options.keyName} "${key}".`));

        const given: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args))
          if (k !== options.discriminator && v !== undefined) given[k] = v;

        const parsed = variant.schema
          ? variant.schema.safeParse(given)
          : { success: true as const, data: given };
        if (!parsed.success)
          return fail(
            new Error(
              `${options.name} ${key}: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ')}`,
            ),
          );
        return await variant.run(parsed.data as never);
      }),
  );
}
