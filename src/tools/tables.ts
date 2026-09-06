import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { IdmlDocument } from '../idml/document.ts';
import { createTextFrame, findItem } from '../idml/items.ts';
import {
  createTable,
  deleteTableColumns,
  deleteTableRows,
  findTable,
  insertTableColumns,
  insertTableRows,
  mergeCells,
  setCellText,
  setColumnWidths,
  setRowHeights,
  styleCells,
  tableInfo,
  tableToText,
} from '../idml/tables.ts';
import type { Element } from '../idml/xml.ts';
import { checkPlacement, withNotes } from './checks.ts';
import type { ToolContext } from './context.ts';
import { colorParam, documentParam, itemParam, lengthParam, ok, pageParam, run } from './shared.ts';

function tableOf(ctx: ToolContext, doc: IdmlDocument, frameRef: string, page?: number | string): Element {
  const found = findItem(doc, frameRef, page);
  if (found.element.tagName !== 'TextFrame')
    throw new Error(`"${frameRef}" is a ${found.info.type}; tables live in text frames`);
  void ctx;
  return findTable(doc, found.element);
}

export function registerTableTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'add_table',
    {
      title: 'Add table',
      description:
        'Puts a table in a text frame (creating the frame when x/y/width/height are given). Fill it with `data` row by row; the first rows can be header rows that repeat when the table flows.',
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam.optional().describe('Existing text frame to put the table in.'),
        page: pageParam.optional(),
        x: lengthParam.optional(),
        y: lengthParam.optional(),
        width: lengthParam.optional(),
        height: lengthParam.optional(),
        name: z.string().optional().describe('Name for the new frame.'),
        rows: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Number of rows (default: the number of data rows).'),
        columns: z.number().int().min(1).max(50).optional(),
        data: z
          .array(z.array(z.string()))
          .optional()
          .describe('Cell text, row by row. **bold** and *italic* work.'),
        headerRows: z.number().int().min(0).max(10).optional(),
        footerRows: z.number().int().min(0).max(10).optional(),
        columnWidths: z.array(lengthParam).optional().describe('Column widths; one value applies to all.'),
        rowHeights: z.array(lengthParam).optional(),
        paragraphStyle: z.string().optional(),
        headerParagraphStyle: z.string().optional(),
        cellInset: lengthParam.optional(),
        strokeWeight: z.number().min(0).optional().describe('Weight of the lines between cells, in points.'),
        strokeColor: colorParam.optional(),
        borderWeight: z.number().min(0).optional(),
        borderColor: colorParam.optional(),
        headerFill: colorParam.optional(),
        alternatingFill: colorParam.optional().describe('Fill for every other body row (banding).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const notes: string[] = [];
        let frame: Element;
        if (args.frame) {
          const found = findItem(doc, args.frame, args.page);
          if (found.element.tagName !== 'TextFrame') throw new Error(`"${args.frame}" is not a text frame`);
          frame = found.element;
        } else {
          if (args.x === undefined || args.y === undefined || args.width === undefined) {
            throw new Error('Give an existing frame, or x, y and width for a new one');
          }
          const rows = args.rows ?? args.data?.length ?? 1;
          const height = args.height !== undefined ? ctx.pt(args.height) : rows * 20 + 8;
          const rect = { x: ctx.pt(args.x), y: ctx.pt(args.y), width: ctx.pt(args.width), height };
          notes.push(...checkPlacement(ctx, doc, rect, args, 'table frame'));
          frame = createTextFrame(
            doc,
            { page: args.page ?? 1 },
            {
              rect,
              name: args.name,
              text: '',
            },
          );
        }
        const rows = args.rows ?? args.data?.length ?? 1;
        const columns = args.columns ?? Math.max(1, ...(args.data ?? [[]]).map((r) => r.length));
        const table = createTable(doc, frame, {
          rows,
          columns,
          headerRows: args.headerRows,
          footerRows: args.footerRows,
          data: args.data,
          columnWidths: args.columnWidths?.map((w) => ctx.pt(w)),
          rowHeights: args.rowHeights?.map((h) => ctx.pt(h)),
          paragraphStyle: args.paragraphStyle,
          headerParagraphStyle: args.headerParagraphStyle,
          cellInset: ctx.ptOpt(args.cellInset),
          strokeWeight: args.strokeWeight,
          strokeColor: args.strokeColor,
          borderWeight: args.borderWeight,
          borderColor: args.borderColor,
          headerFill: args.headerFill,
          alternatingFill: args.alternatingFill,
        });
        ctx.save(doc);
        const info = tableInfo(table);
        return ok(
          withNotes(
            `Added a ${info.rows} × ${info.columns} table${args.headerRows ? ` with ${args.headerRows} header row(s)` : ''} in frame "${frame.getAttribute('Name')}".`,
            notes,
          ),
          {
            rows: info.rows,
            columns: info.columns,
            frame: frame.getAttribute('Name'),
            notes,
          },
        );
      }),
  );

  server.registerTool(
    'get_table',
    {
      title: 'Read table',
      description: 'Returns the contents of a table as rows of text, with its size and header rows.',
      inputSchema: z.object({ document: documentParam, frame: itemParam, page: pageParam.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, frame, page }) =>
      run(() => {
        const doc = ctx.open(document);
        const table = tableOf(ctx, doc, frame, page);
        const info = tableInfo(table);
        return ok(
          `${info.rows} × ${info.columns}${info.headerRows ? `, ${info.headerRows} header row(s)` : ''}\n${tableToText(table)}`,
          {
            rows: info.rows,
            columns: info.columns,
            headerRows: info.headerRows,
            cells: info.cells.map((row) => row.map((c) => c?.text ?? null)),
          },
        );
      }),
  );

  server.registerTool(
    'set_table_cells',
    {
      title: 'Fill table cells',
      description: 'Writes text into table cells: one cell, or a block of cells starting at a position.',
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam,
        page: pageParam.optional(),
        row: z.number().int().min(1).describe('Row number, 1 = first row (header rows count).'),
        column: z.number().int().min(1),
        text: z.string().optional().describe('Text for a single cell.'),
        data: z.array(z.array(z.string())).optional().describe('A block of cells starting at row/column.'),
        paragraphStyle: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const table = tableOf(ctx, doc, args.frame, args.page);
        let count = 0;
        if (args.data) {
          args.data.forEach((row, r) => {
            row.forEach((text, c) => {
              setCellText(doc, table, args.row - 1 + r, args.column - 1 + c, text, {
                paragraphStyle: args.paragraphStyle,
              });
              count++;
            });
          });
        } else if (args.text !== undefined) {
          setCellText(doc, table, args.row - 1, args.column - 1, args.text, {
            paragraphStyle: args.paragraphStyle,
          });
          count = 1;
        } else throw new Error('Give text or data');
        ctx.save(doc);
        return ok(`Updated ${count} cell(s).`, { cells: count });
      }),
  );

  server.registerTool(
    'style_table',
    {
      title: 'Style table cells',
      description:
        'Colours cells, changes their strokes, insets, vertical alignment or paragraph style — the whole table, whole rows/columns, or a block.',
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam,
        page: pageParam.optional(),
        rows: z.array(z.number().int().min(1)).optional().describe('Row numbers to style (1 = first).'),
        columns: z.array(z.number().int().min(1)).optional(),
        fromRow: z.number().int().min(1).optional(),
        fromColumn: z.number().int().min(1).optional(),
        rowSpan: z.number().int().min(1).optional(),
        columnSpan: z.number().int().min(1).optional(),
        fill: colorParam.optional(),
        fillTint: z.number().min(0).max(100).optional(),
        strokeWeight: z.number().min(0).optional(),
        strokeColor: colorParam.optional(),
        inset: lengthParam.optional(),
        verticalAlignment: z.enum(['top', 'center', 'bottom']).optional(),
        paragraphStyle: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const table = tableOf(ctx, doc, args.frame, args.page);
        const range =
          args.rows || args.columns || args.fromRow || args.fromColumn
            ? {
                rows: args.rows?.map((r) => r - 1),
                columns: args.columns?.map((c) => c - 1),
                row: args.fromRow !== undefined ? args.fromRow - 1 : undefined,
                column: args.fromColumn !== undefined ? args.fromColumn - 1 : undefined,
                rowSpan: args.rowSpan,
                columnSpan: args.columnSpan,
              }
            : undefined;
        const n = styleCells(doc, table, range, {
          fill: args.fill,
          fillTint: args.fillTint,
          strokeWeight: args.strokeWeight,
          strokeColor: args.strokeColor,
          inset: ctx.ptOpt(args.inset),
          verticalJustification: args.verticalAlignment,
          paragraphStyle: args.paragraphStyle,
        });
        ctx.save(doc);
        return ok(`Styled ${n} cell(s).`, { cells: n });
      }),
  );

  server.registerTool(
    'edit_table_structure',
    {
      title: 'Add or remove table rows and columns',
      description:
        'Inserts or deletes rows and columns, sets column widths and row heights, or merges a block of cells.',
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam,
        page: pageParam.optional(),
        action: z.enum([
          'insert-rows',
          'delete-rows',
          'insert-columns',
          'delete-columns',
          'merge',
          'column-widths',
          'row-heights',
        ]),
        at: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Row/column number to insert before or delete (1 = first).'),
        count: z.number().int().min(1).optional().describe('How many rows/columns (default 1).'),
        rowSpan: z.number().int().min(1).optional().describe('For merge: how many rows to join.'),
        columnSpan: z.number().int().min(1).optional(),
        widths: z.array(lengthParam).optional(),
        heights: z.array(lengthParam).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const table = tableOf(ctx, doc, args.frame, args.page);
        const at = (args.at ?? 1) - 1;
        switch (args.action) {
          case 'insert-rows':
            insertTableRows(doc, table, at, args.count ?? 1);
            break;
          case 'delete-rows':
            deleteTableRows(table, at, args.count ?? 1);
            break;
          case 'insert-columns':
            insertTableColumns(doc, table, at, args.count ?? 1);
            break;
          case 'delete-columns':
            deleteTableColumns(table, at, args.count ?? 1);
            break;
          case 'merge':
            mergeCells(
              table,
              at,
              (args.at !== undefined ? args.at : 1) - 1,
              args.rowSpan ?? 1,
              args.columnSpan ?? 1,
            );
            break;
          case 'column-widths':
            if (!args.widths?.length) throw new Error('Give widths');
            setColumnWidths(
              table,
              args.widths.map((w) => ctx.pt(w)),
            );
            break;
          case 'row-heights':
            if (!args.heights?.length) throw new Error('Give heights');
            setRowHeights(
              table,
              args.heights.map((h) => ctx.pt(h)),
            );
            break;
        }
        ctx.save(doc);
        const info = tableInfo(table);
        return ok(`Table is now ${info.rows} × ${info.columns}.`, { rows: info.rows, columns: info.columns });
      }),
  );

  server.registerTool(
    'merge_table_cells',
    {
      title: 'Merge table cells',
      description: "Joins a rectangular block of cells into one, keeping the top-left cell's text.",
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam,
        page: pageParam.optional(),
        row: z.number().int().min(1),
        column: z.number().int().min(1),
        rowSpan: z.number().int().min(1).default(1),
        columnSpan: z.number().int().min(1).default(1),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const table = tableOf(ctx, doc, args.frame, args.page);
        mergeCells(table, args.row - 1, args.column - 1, args.rowSpan, args.columnSpan);
        ctx.save(doc);
        return ok(
          `Merged ${args.rowSpan} × ${args.columnSpan} cells at row ${args.row}, column ${args.column}.`,
        );
      }),
  );
}
