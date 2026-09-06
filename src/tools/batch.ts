// One call that runs many edits. Building a page is a dozen small operations, and a dozen
// round-trips is the difference between finishing a document and running out of turns.
import * as z from 'zod';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { ok, run, type ToolResult, toolInput } from './shared.ts';

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
        'Runs a list of edits in order, as if each tool had been called on its own. Use it whenever you know several steps up front — laying out a page, filling a table, styling a set of frames — instead of one call per edit. The document is written once at the end rather than after every step. Each step reports its own result; by default the first failure stops the batch and the document keeps the edits made before it.',
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
        const results: { step: number; tool: string; ok: boolean; message: string }[] = [];
        let failed = 0;

        // Saving after every step would write the file dozens of times; hold the writes and flush
        // once at the end, whether the batch finishes or stops early.
        ctx.deferSaves();
        try {
          for (const [i, step] of args.steps.entries()) {
            const operation = reg.operation(step.tool);
            let message: string;
            let succeeded = false;

            if (!operation) {
              message = `There is no tool called "${step.tool}".`;
            } else if (operation.readOnly) {
              message = `"${step.tool}" only reads the document; call it on its own, not in a batch.`;
            } else {
              const parsed = operation.schema
                ? operation.schema.safeParse(step.arguments)
                : { success: true as const, data: step.arguments };
              if (!parsed.success) {
                message = `Invalid arguments: ${parsed.error.issues
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ')}`;
              } else {
                const r = await operation.run(parsed.data as never);
                succeeded = !r.isError;
                message = resultText(r);
              }
            }

            results.push({ step: i + 1, tool: step.tool, ok: succeeded, message });
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
        return ok(lines.join('\n'), { steps: results, failed });
      }),
  );
}
