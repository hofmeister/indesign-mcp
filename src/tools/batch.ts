// One call that runs many edits. Building a page is a dozen small operations, and a dozen
// round-trips is the difference between finishing a document and running out of turns.
import * as z from 'zod';
import type { ToolContext } from './context.ts';
import type { RegisteredOperation, ToolRegistry } from './registry.ts';
import { fail, ok, run, type ToolResult, toolInput } from './shared.ts';

/** Text of a tool result, for the per-step report. */
function resultText(r: ToolResult): string {
  return r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ')
    .trim();
}

export function registerBatchTool(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'batch',
    {
      title: 'Run several edits in one call',
      description:
        'Runs a list of edits in order, as if each tool had been called on its own. Use it whenever you know several steps up front — laying out a page, filling a table, styling a set of frames — instead of one call per edit. The document is written once at the end rather than after every step. Each step reports its own result; by default the first failure stops the batch and the document keeps the edits made before it. Unknown tools and bad arguments are caught before anything runs, so the batch either starts clean or makes no edits at all. Read-only steps (list, describe_document, preflight_document, validate_document) may be mixed in; their output is included in the report.',
      inputSchema: toolInput({
        steps: z
          .array(
            z.strictObject({
              tool: z.string().describe('Name of the tool to run, e.g. "add_text_frame".'),
              arguments: z
                .record(z.string(), z.unknown())
                .describe("That tool's arguments, exactly as you would pass them on their own."),
            }),
          )
          .min(1)
          .max(200)
          .describe('The edits to run, in order.'),
        continueOnError: z
          .boolean()
          .optional()
          .describe('Carry on after a step fails instead of stopping (default false).'),
      }),
    },
    async (args) =>
      run(async () => {
        // Check every step before running any of them: a name or an argument the caller got wrong
        // is worth catching while the document is still untouched, not halfway through the edits.
        const prepared: { operation: RegisteredOperation; arguments: unknown }[] = [];
        const problems: string[] = [];
        for (const [i, step] of args.steps.entries()) {
          const operation = reg.operation(step.tool);
          if (!operation) {
            problems.push(`Step ${i + 1}: there is no tool called "${step.tool}".`);
            continue;
          }
          const parsed = operation.schema
            ? operation.schema.safeParse(step.arguments)
            : { success: true as const, data: step.arguments };
          if (!parsed.success) {
            problems.push(
              `Step ${i + 1} (${step.tool}): invalid arguments: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ')}`,
            );
            continue;
          }
          prepared.push({ operation, arguments: parsed.data });
        }
        if (problems.length)
          return fail(`Nothing was run — fix these steps and call batch again:\n${problems.join('\n')}`);

        const results: { step: number; tool: string; ok: boolean; message: string }[] = [];
        const extra: ToolResult['content'] = [];
        let failed = 0;

        // Saving after every step would write the file dozens of times; hold the writes and flush
        // once at the end, whether the batch finishes or stops early.
        ctx.deferSaves();
        try {
          for (const [i, { operation, arguments: input }] of prepared.entries()) {
            // A read-only step may look at the file on disk (preview through InDesign, preflight),
            // so let the held-back edits land before it runs.
            if (operation.readOnly) {
              ctx.flushSaves();
              ctx.deferSaves();
            }
            const r = await operation.run(input as never);
            const succeeded = !r.isError;
            results.push({ step: i + 1, tool: operation.name, ok: succeeded, message: resultText(r) });
            for (const block of r.content) if (block.type !== 'text') extra.push(block);
            if (!succeeded) {
              failed++;
              if (!args.continueOnError) break;
            }
          }
        } finally {
          ctx.flushSaves();
        }

        const ran = results.length;
        const lines = [
          failed
            ? `${ran - failed} of ${ran} step(s) succeeded, ${failed} failed${
                args.continueOnError ? '' : ' (stopped at the first failure)'
              }.`
            : `All ${ran} step(s) succeeded.`,
          ...results.map((r) => `${r.ok ? '✓' : '✗'} ${r.step}. ${r.tool}: ${r.message}`),
        ];
        if (failed && results.length < args.steps.length)
          lines.push(`${args.steps.length - results.length} step(s) were not run.`);
        const result = ok(lines.join('\n'), { steps: results, failed });
        result.content.push(...extra);
        return result;
      }),
  );
}
