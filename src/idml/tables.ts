// Tables live inside a story: <Table> sits in a CharacterStyleRange and holds Column, Row and Cell
// elements. Cells are addressed by their Name ("column:row"), the convention InDesign uses.
import type { IdmlDocument } from './document.ts';
import { anchorBounds, readPaths } from './geometry.ts';
import { escapeAttr } from './layers.ts';
import { BASIC_PARAGRAPH_STYLE, NO_CHARACTER_STYLE, parseInlineMarkup, type Run } from './stories.ts';
import { resolveSwatch, styleSelf } from './styles.ts';
import {
  attr,
  children,
  type Element,
  formatNumber,
  fragment,
  numAttr,
  removeElement,
  setAttrs,
} from './xml.ts';

export interface CellSpec {
  text?: string;
  paragraphStyle?: string;
  fill?: string;
  fillTint?: number;
  alignment?: 'top' | 'center' | 'bottom';
  rowSpan?: number;
  columnSpan?: number;
}

export interface TableSpec {
  rows: number;
  columns: number;
  headerRows?: number;
  footerRows?: number;
  /** Cell text as data[row][column]; missing entries stay empty. */
  data?: string[][];
  /** Column widths in points; a single value applies to all columns. */
  columnWidths?: number[];
  rowHeights?: number[];
  /** Total width to distribute over the columns when no widths are given. */
  totalWidth?: number;
  paragraphStyle?: string;
  headerParagraphStyle?: string;
  cellInset?: number;
  borderWeight?: number;
  borderColor?: string;
  /** Weight of the lines between cells. */
  strokeWeight?: number;
  strokeColor?: string;
  headerFill?: string;
  alternatingFill?: string;
}

export interface TableInfo {
  id: string;
  rows: number;
  columns: number;
  headerRows: number;
  footerRows: number;
  columnWidths: number[];
  rowHeights: number[];
  /** cells[row][column]; merged-away cells are undefined. */
  cells: (CellInfo | undefined)[][];
}

export interface CellInfo {
  id: string;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  fill: string | undefined;
}

const CELL_DEFAULTS =
  'AppliedCellStyle="CellStyle/$ID/[None]" AppliedCellStylePriority="0" CellType="TextTypeCell" ClipContentToCell="false" VerticalJustification="TopAlign"';

function cellName(column: number, row: number): string {
  return `${column}:${row}`;
}

export function parseCellName(name: string | undefined): { column: number; row: number } | undefined {
  const m = /^(\d+):(\d+)$/.exec(name ?? '');
  return m ? { column: Number(m[1]), row: Number(m[2]) } : undefined;
}

function runsToXml(runs: Run[], paragraphStyle: string): string {
  const parts = runs.map((r) => {
    const attrs = Object.entries(r.attrs ?? {})
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join('');
    const content = r.text ? `<Content>${escapeAttr(r.text).replace(/</g, '&lt;')}</Content>` : '';
    return `<CharacterStyleRange AppliedCharacterStyle="${NO_CHARACTER_STYLE}"${attrs}>${content}</CharacterStyleRange>`;
  });
  return `<ParagraphStyleRange AppliedParagraphStyle="${escapeAttr(paragraphStyle)}">${parts.join('')}</ParagraphStyleRange>`;
}

function cellContentXml(text: string, paragraphStyle: string): string {
  const paragraphs = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return paragraphs.map((line) => runsToXml(parseInlineMarkup(line), paragraphStyle)).join('');
}

/** The <Table> elements inside a story, in document order. */
export function tablesIn(story: Element): Element[] {
  return Array.from(story.getElementsByTagName('Table')) as Element[];
}

export function tableInfo(table: Element): TableInfo {
  const rows =
    numAttr(table, 'BodyRowCount', 0) +
    numAttr(table, 'HeaderRowCount', 0) +
    numAttr(table, 'FooterRowCount', 0);
  const columns = numAttr(table, 'ColumnCount', 0);
  const cells: (CellInfo | undefined)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => undefined),
  );
  for (const cell of children(table, 'Cell')) {
    const pos = parseCellName(attr(cell, 'Name'));
    if (!pos) continue;
    const info: CellInfo = {
      id: attr(cell, 'Self') ?? '',
      row: pos.row,
      column: pos.column,
      rowSpan: numAttr(cell, 'RowSpan', 1),
      columnSpan: numAttr(cell, 'ColumnSpan', 1),
      text: Array.from(cell.getElementsByTagName('Content'))
        .map((c) => c.textContent ?? '')
        .join('\n'),
      fill: attr(cell, 'FillColor'),
    };
    if (cells[pos.row]) cells[pos.row]![pos.column] = info;
  }
  return {
    id: attr(table, 'Self') ?? '',
    rows,
    columns,
    headerRows: numAttr(table, 'HeaderRowCount', 0),
    footerRows: numAttr(table, 'FooterRowCount', 0),
    columnWidths: children(table, 'Column').map((c) => numAttr(c, 'SingleColumnWidth', 0)),
    rowHeights: children(table, 'Row').map((r) => numAttr(r, 'SingleRowHeight', 0)),
    cells,
  };
}

/** Creates a table inside a text frame's story, replacing any text already there. */
export function createTable(doc: IdmlDocument, frame: Element, spec: TableSpec): Element {
  if (frame.tagName !== 'TextFrame') throw new Error('Tables can only be placed in a text frame');
  const storyId = attr(frame, 'ParentStory');
  const story = storyId ? doc.story(storyId) : undefined;
  if (!story) throw new Error('The text frame has no story');
  const rows = Math.max(1, Math.floor(spec.rows));
  const columns = Math.max(1, Math.floor(spec.columns));
  if (rows * columns > 5000) throw new Error('Tables are limited to 5000 cells');
  const headerRows = Math.max(0, Math.min(rows, Math.floor(spec.headerRows ?? 0)));
  const footerRows = Math.max(0, Math.min(rows - headerRows, Math.floor(spec.footerRows ?? 0)));
  const frameWidth = anchorBounds(readPaths(frame)).width;
  const total = spec.totalWidth ?? frameWidth - 2 * (spec.cellInset ?? 4);
  const widths = Array.from(
    { length: columns },
    (_, c) => spec.columnWidths?.[c] ?? spec.columnWidths?.[0] ?? total / columns,
  );
  const heights = Array.from({ length: rows }, (_, r) => spec.rowHeights?.[r] ?? spec.rowHeights?.[0] ?? 20);
  const bodyStyle = spec.paragraphStyle
    ? styleSelf(doc, 'ParagraphStyle', spec.paragraphStyle)
    : BASIC_PARAGRAPH_STYLE;
  const headerStyle = spec.headerParagraphStyle
    ? styleSelf(doc, 'ParagraphStyle', spec.headerParagraphStyle)
    : bodyStyle;
  const inset = spec.cellInset ?? 4;
  const stroke = spec.strokeWeight ?? 0.5;
  const strokeColor = resolveSwatch(doc, spec.strokeColor ?? 'Black');
  const headerFill = spec.headerFill ? resolveSwatch(doc, spec.headerFill) : undefined;
  const altFill = spec.alternatingFill ? resolveSwatch(doc, spec.alternatingFill) : undefined;

  const id = doc.newId();
  const columnsXml = widths
    .map((w, c) => `<Column Self="${doc.newId()}" Name="${c}" SingleColumnWidth="${formatNumber(w)}"/>`)
    .join('');
  const rowsXml = heights
    .map(
      (h, r) =>
        `<Row Self="${doc.newId()}" Name="${r}" SingleRowHeight="${formatNumber(h)}" AutoGrow="true"/>`,
    )
    .join('');
  const cellsXml: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const isHeader = r < headerRows;
      const text = spec.data?.[r]?.[c] ?? '';
      const fill = isHeader ? headerFill : altFill && (r - headerRows) % 2 === 1 ? altFill : undefined;
      cellsXml.push(
        `<Cell Self="${doc.newId()}" Name="${cellName(c, r)}" ${CELL_DEFAULTS} RowSpan="1" ColumnSpan="1" LeftInset="${inset}" TopInset="${inset}" RightInset="${inset}" BottomInset="${inset}"${fill ? ` FillColor="${escapeAttr(fill)}"` : ''} LeftEdgeStrokeWeight="${stroke}" LeftEdgeStrokeColor="${escapeAttr(strokeColor)}" RightEdgeStrokeWeight="${stroke}" RightEdgeStrokeColor="${escapeAttr(strokeColor)}" TopEdgeStrokeWeight="${stroke}" TopEdgeStrokeColor="${escapeAttr(strokeColor)}" BottomEdgeStrokeWeight="${stroke}" BottomEdgeStrokeColor="${escapeAttr(strokeColor)}">${cellContentXml(text, isHeader ? headerStyle : bodyStyle)}</Cell>`,
      );
    }
  }
  const border = spec.borderWeight ?? stroke;
  const borderColor = resolveSwatch(doc, spec.borderColor ?? spec.strokeColor ?? 'Black');
  const borders = ['Top', 'Left', 'Bottom', 'Right']
    .map(
      (side) => `${side}BorderStrokeWeight="${border}" ${side}BorderStrokeColor="${escapeAttr(borderColor)}"`,
    )
    .join(' ');
  const table = fragment(
    story.ownerDocument!,
    `<Table Self="${id}" AppliedTableStyle="TableStyle/$ID/[Basic Table]" TableDirection="LeftToRightDirection" HeaderRowCount="${headerRows}" FooterRowCount="${footerRows}" BodyRowCount="${rows - headerRows - footerRows}" ColumnCount="${columns}" ${borders}>${columnsXml}${rowsXml}${cellsXml.join('')}</Table>`,
  );

  // replace the story's content with a single range holding the table
  for (const c of children(story))
    if (c.tagName === 'ParagraphStyleRange' || c.tagName === 'XMLElement') removeElement(c);
  const psr = fragment(
    story.ownerDocument!,
    `<ParagraphStyleRange AppliedParagraphStyle="${escapeAttr(bodyStyle)}"><CharacterStyleRange AppliedCharacterStyle="${NO_CHARACTER_STYLE}"></CharacterStyleRange></ParagraphStyleRange>`,
  );
  const csr = children(psr, 'CharacterStyleRange')[0]!;
  csr.appendChild(table);
  story.appendChild(psr);
  return table;
}

/** Finds the table in a text frame (or by id anywhere in the document). */
export function findTable(doc: IdmlDocument, frame: Element): Element {
  const storyId = attr(frame, 'ParentStory');
  const story = storyId ? doc.story(storyId) : undefined;
  const tables = story ? tablesIn(story) : [];
  if (!tables.length) throw new Error('That text frame has no table. Create one with add_table.');
  return tables[0]!;
}

export function cellAt(table: Element, row: number, column: number): Element {
  const wanted = cellName(column, row);
  const cell = children(table, 'Cell').find((c) => attr(c, 'Name') === wanted);
  if (!cell) {
    const info = tableInfo(table);
    throw new Error(
      `The table has no cell at row ${row + 1}, column ${column + 1} (it is ${info.rows} × ${info.columns}${info.cells.flat().some((c) => c && (c.rowSpan > 1 || c.columnSpan > 1)) ? '; the cell may be part of a merged block' : ''})`,
    );
  }
  return cell;
}

export interface CellRange {
  row: number;
  column: number;
  rowSpan?: number;
  columnSpan?: number;
}

export function setCellText(
  doc: IdmlDocument,
  table: Element,
  row: number,
  column: number,
  text: string,
  options: { paragraphStyle?: string } = {},
): void {
  const cell = cellAt(table, row, column);
  const style = options.paragraphStyle
    ? styleSelf(doc, 'ParagraphStyle', options.paragraphStyle)
    : BASIC_PARAGRAPH_STYLE;
  for (const c of children(cell)) if (c.tagName === 'ParagraphStyleRange') removeElement(c);
  const frag = fragment(cell.ownerDocument!, `<Wrapper>${cellContentXml(text, style)}</Wrapper>`);
  for (const c of children(frag)) cell.appendChild(c.cloneNode(true));
}

export interface CellAppearance {
  fill?: string;
  fillTint?: number;
  strokeWeight?: number;
  strokeColor?: string;
  inset?: number;
  verticalJustification?: 'top' | 'center' | 'bottom';
  paragraphStyle?: string;
}

/** Applies appearance to every cell in a rectangular range (or the whole table). */
export function styleCells(
  doc: IdmlDocument,
  table: Element,
  range: (Partial<CellRange> & { rows?: number[]; columns?: number[] }) | undefined,
  style: CellAppearance,
): number {
  const info = tableInfo(table);
  const rows =
    range?.rows ??
    (range?.row !== undefined
      ? Array.from({ length: range.rowSpan ?? 1 }, (_, i) => range.row! + i)
      : Array.from({ length: info.rows }, (_, i) => i));
  const cols =
    range?.columns ??
    (range?.column !== undefined
      ? Array.from({ length: range.columnSpan ?? 1 }, (_, i) => range.column! + i)
      : Array.from({ length: info.columns }, (_, i) => i));
  let count = 0;
  for (const r of rows) {
    for (const c of cols) {
      const cell = children(table, 'Cell').find((x) => attr(x, 'Name') === cellName(c, r));
      if (!cell) continue;
      const attrs: Record<string, string | number | null> = {};
      if (style.fill !== undefined) attrs.FillColor = resolveSwatch(doc, style.fill);
      if (style.fillTint !== undefined) attrs.FillTint = style.fillTint;
      if (style.inset !== undefined) {
        attrs.LeftInset = style.inset;
        attrs.RightInset = style.inset;
        attrs.TopInset = style.inset;
        attrs.BottomInset = style.inset;
      }
      if (style.verticalJustification) {
        attrs.VerticalJustification = { top: 'TopAlign', center: 'CenterAlign', bottom: 'BottomAlign' }[
          style.verticalJustification
        ];
      }
      if (style.strokeWeight !== undefined || style.strokeColor !== undefined) {
        for (const side of ['Left', 'Right', 'Top', 'Bottom']) {
          if (style.strokeWeight !== undefined) attrs[`${side}EdgeStrokeWeight`] = style.strokeWeight;
          if (style.strokeColor !== undefined)
            attrs[`${side}EdgeStrokeColor`] = resolveSwatch(doc, style.strokeColor);
        }
      }
      setAttrs(cell, attrs);
      if (style.paragraphStyle) {
        const self = styleSelf(doc, 'ParagraphStyle', style.paragraphStyle);
        for (const psr of Array.from(cell.getElementsByTagName('ParagraphStyleRange')) as Element[])
          psr.setAttribute('AppliedParagraphStyle', self);
      }
      count++;
    }
  }
  return count;
}

/** Renumbers cell names after rows or columns were inserted or removed. */
function renumber(
  table: Element,
  mapRow: (r: number) => number | undefined,
  mapColumn: (c: number) => number | undefined,
): void {
  for (const cell of children(table, 'Cell')) {
    const pos = parseCellName(attr(cell, 'Name'));
    if (!pos) continue;
    const r = mapRow(pos.row);
    const c = mapColumn(pos.column);
    if (r === undefined || c === undefined) removeElement(cell);
    else cell.setAttribute('Name', cellName(c, r));
  }
}

function sortCells(table: Element): void {
  const cells = children(table, 'Cell');
  const sorted = [...cells].sort((a, b) => {
    const pa = parseCellName(attr(a, 'Name')) ?? { row: 0, column: 0 };
    const pb = parseCellName(attr(b, 'Name')) ?? { row: 0, column: 0 };
    return pa.row - pb.row || pa.column - pb.column;
  });
  for (const c of sorted) {
    removeElement(c);
    table.appendChild(c);
  }
}

export function insertTableRows(
  doc: IdmlDocument,
  table: Element,
  at: number,
  count = 1,
  options: { height?: number } = {},
): void {
  const info = tableInfo(table);
  const index = Math.max(0, Math.min(info.rows, at));
  const n = Math.max(1, Math.floor(count));
  renumber(
    table,
    (r) => (r >= index ? r + n : r),
    (c) => c,
  );
  const heights = children(table, 'Row');
  const height = options.height ?? (heights[0] ? numAttr(heights[0], 'SingleRowHeight', 20) : 20);
  const templateCell = children(table, 'Cell')[0];
  for (let i = 0; i < n; i++) {
    const row = fragment(
      table.ownerDocument!,
      `<Row Self="${doc.newId()}" Name="${index + i}" SingleRowHeight="${formatNumber(height)}" AutoGrow="true"/>`,
    );
    table.appendChild(row);
    for (let c = 0; c < info.columns; c++) {
      const cell = templateCell
        ? (templateCell.cloneNode(true) as Element)
        : fragment(
            table.ownerDocument!,
            `<Cell Self="x" Name="0:0" ${CELL_DEFAULTS} RowSpan="1" ColumnSpan="1"/>`,
          );
      cell.setAttribute('Self', doc.newId());
      cell.setAttribute('Name', cellName(c, index + i));
      cell.setAttribute('RowSpan', '1');
      cell.setAttribute('ColumnSpan', '1');
      cell.removeAttribute('FillColor');
      for (const psr of Array.from(cell.getElementsByTagName('Content')) as Element[]) {
        while (psr.firstChild) psr.removeChild(psr.firstChild);
      }
      table.appendChild(cell);
    }
  }
  // renumber the Row elements themselves
  children(table, 'Row').forEach((r, i) => r.setAttribute('Name', String(i)));
  table.setAttribute('BodyRowCount', String(info.rows - info.headerRows - info.footerRows + n));
  sortCells(table);
}

export function deleteTableRows(table: Element, at: number, count = 1): void {
  const info = tableInfo(table);
  const n = Math.max(1, Math.min(info.rows - 1, Math.floor(count)));
  const index = Math.max(0, Math.min(info.rows - 1, at));
  renumber(
    table,
    (r) => (r >= index && r < index + n ? undefined : r > index ? r - n : r),
    (c) => c,
  );
  const rows = children(table, 'Row');
  for (let i = index; i < index + n && i < rows.length; i++) removeElement(rows[i]!);
  children(table, 'Row').forEach((r, i) => r.setAttribute('Name', String(i)));
  const header = Math.max(0, info.headerRows - Math.max(0, Math.min(n, info.headerRows - index)));
  table.setAttribute('HeaderRowCount', String(header));
  table.setAttribute('BodyRowCount', String(Math.max(0, info.rows - n - header - info.footerRows)));
  sortCells(table);
}

export function insertTableColumns(
  doc: IdmlDocument,
  table: Element,
  at: number,
  count = 1,
  options: { width?: number } = {},
): void {
  const info = tableInfo(table);
  const index = Math.max(0, Math.min(info.columns, at));
  const n = Math.max(1, Math.floor(count));
  renumber(
    table,
    (r) => r,
    (c) => (c >= index ? c + n : c),
  );
  const cols = children(table, 'Column');
  const width = options.width ?? (cols[0] ? numAttr(cols[0], 'SingleColumnWidth', 80) : 80);
  const templateCell = children(table, 'Cell')[0];
  for (let i = 0; i < n; i++) {
    table.appendChild(
      fragment(
        table.ownerDocument!,
        `<Column Self="${doc.newId()}" Name="${index + i}" SingleColumnWidth="${formatNumber(width)}"/>`,
      ),
    );
    for (let r = 0; r < info.rows; r++) {
      const cell = templateCell
        ? (templateCell.cloneNode(true) as Element)
        : fragment(
            table.ownerDocument!,
            `<Cell Self="x" Name="0:0" ${CELL_DEFAULTS} RowSpan="1" ColumnSpan="1"/>`,
          );
      cell.setAttribute('Self', doc.newId());
      cell.setAttribute('Name', cellName(index + i, r));
      cell.setAttribute('RowSpan', '1');
      cell.setAttribute('ColumnSpan', '1');
      cell.removeAttribute('FillColor');
      for (const content of Array.from(cell.getElementsByTagName('Content')) as Element[]) {
        while (content.firstChild) content.removeChild(content.firstChild);
      }
      table.appendChild(cell);
    }
  }
  children(table, 'Column').forEach((c, i) => c.setAttribute('Name', String(i)));
  table.setAttribute('ColumnCount', String(info.columns + n));
  sortCells(table);
}

export function deleteTableColumns(table: Element, at: number, count = 1): void {
  const info = tableInfo(table);
  const n = Math.max(1, Math.min(info.columns - 1, Math.floor(count)));
  const index = Math.max(0, Math.min(info.columns - 1, at));
  renumber(
    table,
    (r) => r,
    (c) => (c >= index && c < index + n ? undefined : c > index ? c - n : c),
  );
  const cols = children(table, 'Column');
  for (let i = index; i < index + n && i < cols.length; i++) removeElement(cols[i]!);
  children(table, 'Column').forEach((c, i) => c.setAttribute('Name', String(i)));
  table.setAttribute('ColumnCount', String(info.columns - n));
  sortCells(table);
}

/** Merges a rectangular block of cells into the top-left one. */
export function mergeCells(
  table: Element,
  row: number,
  column: number,
  rowSpan: number,
  columnSpan: number,
): void {
  const info = tableInfo(table);
  if (rowSpan < 1 || columnSpan < 1) throw new Error('A merge needs at least one row and column');
  if (row + rowSpan > info.rows || column + columnSpan > info.columns)
    throw new Error('The merge range is outside the table');
  const keep = cellAt(table, row, column);
  const texts: string[] = [];
  for (let r = row; r < row + rowSpan; r++) {
    for (let c = column; c < column + columnSpan; c++) {
      if (r === row && c === column) continue;
      const cell = children(table, 'Cell').find((x) => attr(x, 'Name') === cellName(c, r));
      if (!cell) continue;
      const t = Array.from(cell.getElementsByTagName('Content'))
        .map((x) => x.textContent ?? '')
        .join('');
      if (t.trim()) texts.push(t);
      removeElement(cell);
    }
  }
  keep.setAttribute('RowSpan', String(rowSpan));
  keep.setAttribute('ColumnSpan', String(columnSpan));
  void texts;
}

export function setColumnWidths(table: Element, widths: number[]): void {
  children(table, 'Column').forEach((c, i) => {
    const w = widths[i] ?? widths[widths.length - 1];
    if (w !== undefined) c.setAttribute('SingleColumnWidth', formatNumber(w));
  });
}

export function setRowHeights(table: Element, heights: number[]): void {
  children(table, 'Row').forEach((r, i) => {
    const h = heights[i] ?? heights[heights.length - 1];
    if (h !== undefined) r.setAttribute('SingleRowHeight', formatNumber(h));
  });
}

/** Plain-text rendering of a table, for describe_document and get_text. */
export function tableToText(table: Element): string {
  const info = tableInfo(table);
  const lines: string[] = [];
  for (let r = 0; r < info.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < info.columns; c++) {
      const cell = info.cells[r]?.[c];
      row.push(cell ? cell.text.replace(/\n/g, ' ') : '');
    }
    lines.push(row.join(' | '));
  }
  return lines.join('\n');
}
