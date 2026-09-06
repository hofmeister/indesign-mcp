// Builds an eight-slide presentation through the MCP tools — the same calls Claude makes — and
// renders every slide to PNG. Run it with:
//
//   bun run examples/presentation.ts [output folder]
//
// It is also a broad smoke test of the tool surface: masters and page numbers, styles, lists,
// tables, shapes, gradients, transparency, preflight and the preview renderer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

const OUT = process.argv[2] ?? join(tmpdir(), 'indesign-mcp-presentation');
mkdirSync(OUT, { recursive: true });

const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer(
  loadConfig({
    INDESIGN_MCP_DOCUMENTS: OUT,
    INDESIGN_MCP_DEFAULT_UNIT: 'pt',
    INDESIGN_MCP_DISABLE_INDESIGN: '1',
  }),
).connect(st);
const client = new Client({ name: 'deck', version: '0' });
await client.connect(ct);

let failures = 0;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type?: string; text?: string }[])
    .filter((c) => c.type !== 'image')
    .map((c) => c.text ?? '')
    .join('\n');
  if (r.isError) {
    failures++;
    console.error(`✗ ${name}: ${text}`);
  } else if (text.includes('Note:')) {
    console.warn(`⚠ ${name}: ${text.split('\n').filter((l) => l.startsWith('Note:')).join(' ')}`);
  }
  return { ...(r.structuredContent as Record<string, unknown>), _text: text };
}

// ---- canvas ------------------------------------------------------------------------------------
const W = 960;
const H = 540;
const M = 64; // side margin
const TOP = 62;
const CONTENT = W - 2 * M;

const doc = ((await call('new_document', {
  path: 'northwind-review.idml',
  width: W,
  height: H,
  pages: 8,
  margins: M,
  overwrite: true,
})) as { path: string }).path;
const d = { document: doc };

// ---- palette -----------------------------------------------------------------------------------
await call('create_swatch', { ...d, name: 'Ink', cmyk: [92, 78, 42, 38] }); // deep navy
await call('create_swatch', { ...d, name: 'Ink Light', cmyk: [80, 62, 34, 14] });
await call('create_swatch', { ...d, name: 'Accent', cmyk: [0, 62, 92, 0] }); // warm orange
await call('create_swatch', { ...d, name: 'Teal', cmyk: [72, 12, 38, 0] });
await call('create_swatch', { ...d, name: 'Grey', cmyk: [0, 0, 0, 58] });
await call('create_swatch', { ...d, name: 'Rule', cmyk: [0, 0, 0, 16] });
await call('create_swatch', { ...d, name: 'Wash', cmyk: [4, 2, 0, 4] });
await call('create_gradient', {
  ...d,
  name: 'Ink Fade',
  type: 'linear',
  stops: [
    { color: 'Ink', location: 0 },
    { color: 'Ink Light', location: 100 },
  ],
});

// ---- type styles -------------------------------------------------------------------------------
const SANS = 'Arimo';
await call('create_paragraph_style', {
  ...d,
  name: 'Kicker',
  font: SANS,
  fontStyle: 'Bold',
  size: 10,
  leading: 12,
  tracking: 180,
  capitalization: 'all-caps',
  color: 'Accent',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Kicker Light',
  basedOn: 'Kicker',
  color: 'Accent',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Slide Title',
  font: SANS,
  fontStyle: 'Bold',
  size: 34,
  leading: 40,
  color: 'Ink',
  spaceBefore: 0,
});
await call('create_paragraph_style', {
  ...d,
  name: 'Hero Title',
  font: SANS,
  fontStyle: 'Bold',
  size: 54,
  leading: 60,
  color: 'Paper',
  tracking: -15,
});
await call('create_paragraph_style', {
  ...d,
  name: 'Hero Sub',
  font: SANS,
  fontStyle: 'Regular',
  size: 18,
  leading: 26,
  color: 'Paper',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Lead',
  font: SANS,
  fontStyle: 'Regular',
  size: 16,
  leading: 24,
  color: 'Grey',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Body',
  font: SANS,
  fontStyle: 'Regular',
  size: 13.5,
  leading: 20,
  color: 'Ink',
  spaceAfter: 6,
});
await call('create_paragraph_style', { ...d, name: 'Bullet', basedOn: 'Body', spaceAfter: 10 });
await call('set_list_options', {
  ...d,
  style: 'Bullet',
  kind: 'bullet',
  bulletCharacter: '—',
  indent: 18,
  bulletIndent: 18,
  characterStyle: undefined,
});
await call('create_paragraph_style', { ...d, name: 'Numbered', basedOn: 'Body', spaceAfter: 14 });
await call('set_list_options', {
  ...d,
  style: 'Numbered',
  kind: 'number',
  numberStyle: 'arabic',
  numberFormat: '^#',
  indent: 26,
  bulletIndent: 26,
});
await call('create_paragraph_style', {
  ...d,
  name: 'Section Number',
  font: SANS,
  fontStyle: 'Bold',
  size: 120,
  leading: 120,
  color: 'Accent',
  tracking: -40,
});
await call('create_paragraph_style', {
  ...d,
  name: 'Section Title',
  font: SANS,
  fontStyle: 'Bold',
  size: 40,
  leading: 46,
  color: 'Paper',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Quote',
  font: SANS,
  fontStyle: 'Bold',
  size: 30,
  leading: 40,
  color: 'Ink',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Attribution',
  font: SANS,
  fontStyle: 'Regular',
  size: 13,
  leading: 18,
  color: 'Grey',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Table Head',
  font: SANS,
  fontStyle: 'Bold',
  size: 11,
  leading: 15,
  color: 'Paper',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Table Cell',
  font: SANS,
  fontStyle: 'Regular',
  size: 11,
  leading: 15,
  color: 'Ink',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Table Number',
  basedOn: 'Table Cell',
  alignment: 'right',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Footer',
  font: SANS,
  fontStyle: 'Regular',
  size: 8,
  leading: 10,
  tracking: 40,
  color: 'Grey',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Page Number',
  basedOn: 'Footer',
  alignment: 'right',
  color: 'Ink',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Chart Label',
  font: SANS,
  fontStyle: 'Regular',
  size: 10,
  leading: 12,
  color: 'Grey',
  alignment: 'center',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Chart Value',
  font: SANS,
  fontStyle: 'Bold',
  size: 11,
  leading: 13,
  color: 'Ink',
  alignment: 'center',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Stat',
  font: SANS,
  fontStyle: 'Bold',
  size: 46,
  leading: 50,
  color: 'Ink',
  tracking: -20,
});
await call('create_paragraph_style', {
  ...d,
  name: 'Stat Label',
  font: SANS,
  fontStyle: 'Regular',
  size: 11,
  leading: 15,
  color: 'Grey',
});
await call('create_character_style', { ...d, name: 'Accent Text', color: 'Accent' });

// ---- master page -------------------------------------------------------------------------------
await call('add_line', {
  ...d,
  master: 'A-Master',
  x1: M,
  y1: H - 46,
  x2: W - M,
  y2: H - 46,
  stroke: 'Rule',
  strokeWeight: 0.75,
  name: 'Footer rule',
});
await call('add_text_frame', {
  ...d,
  master: 'A-Master',
  x: M,
  y: H - 38,
  width: 420,
  height: 14,
  text: 'Northwind Studio  ·  Quarterly Design Review  ·  Q3 2026',
  paragraphStyle: 'Footer',
  name: 'Footer text',
});
await call('add_text_frame', {
  ...d,
  master: 'A-Master',
  x: W - M - 60,
  y: H - 38,
  width: 60,
  height: 14,
  paragraphStyle: 'Page Number',
  name: 'Folio',
});
await call('insert_page_number', { ...d, item: 'Folio' });

// full-bleed dark slides do not use the master
await call('apply_master', { ...d, master: 'none', pages: [1, 3, 7, 8] });

// ---- 1. title ----------------------------------------------------------------------------------
await call('add_rectangle', { ...d, page: 1, x: 0, y: 0, width: W, height: H, fill: 'Ink', name: 'Title bg' });
await call('add_rectangle', {
  ...d,
  page: 1,
  x: 0,
  y: 0,
  width: W,
  height: H,
  fill: 'Ink Fade',
  name: 'Title wash',
});
await call('set_appearance', { ...d, item: 'Title wash', opacity: 55 });
await call('add_rectangle', { ...d, page: 1, x: M, y: 150, width: 68, height: 5, fill: 'Accent', name: 'Rule' });
await call('add_text_frame', {
  ...d,
  page: 1,
  x: M,
  y: 118,
  width: 520,
  height: 20,
  text: 'Quarterly design review',
  paragraphStyle: 'Kicker',
  name: 'Title kicker',
});
await call('add_text_frame', {
  ...d,
  page: 1,
  x: M,
  y: 186,
  width: 660,
  height: 140,
  text: 'Designing at the\nspeed of conversation',
  paragraphStyle: 'Hero Title',
  name: 'Title',
});
await call('add_text_frame', {
  ...d,
  page: 1,
  x: M,
  y: 336,
  width: 520,
  height: 60,
  text: 'How the studio cut production time by 38% without\nhanding the layout over to a machine.',
  paragraphStyle: 'Hero Sub',
  name: 'Subtitle',
});
await call('create_paragraph_style', {
  ...d,
  name: 'Byline',
  basedOn: 'Footer',
  color: 'Paper',
});
await call('add_text_frame', {
  ...d,
  page: 1,
  x: M,
  y: 452,
  width: 520,
  height: 16,
  text: 'Ada Fjeldsted  ·  Head of Studio  ·  6 September 2026',
  paragraphStyle: 'Byline',
  name: 'Byline',
});
await call('set_appearance', { ...d, item: 'Byline', opacity: 70 });
// a quiet geometric mark, bottom right
await call('add_ellipse', {
  ...d,
  page: 1,
  x: W - 210,
  y: H - 210,
  width: 300,
  height: 300,
  fill: 'Teal',
  name: 'Mark 1',
});
await call('set_appearance', { ...d, item: 'Mark 1', opacity: 22 });
await call('add_ellipse', {
  ...d,
  page: 1,
  x: W - 140,
  y: H - 140,
  width: 300,
  height: 300,
  fill: 'Accent',
  name: 'Mark 2',
});
await call('set_appearance', { ...d, item: 'Mark 2', opacity: 26 });

// ---- 2. agenda ---------------------------------------------------------------------------------
await call('add_text_frame', {
  ...d,
  page: 2,
  x: M,
  y: TOP,
  width: CONTENT,
  height: 18,
  text: 'Agenda',
  paragraphStyle: 'Kicker',
  name: 'Agenda kicker',
});
await call('add_text_frame', {
  ...d,
  page: 2,
  x: M,
  y: TOP + 26,
  width: 560,
  height: 50,
  text: 'What we will cover',
  paragraphStyle: 'Slide Title',
  name: 'Agenda title',
});
await call('add_line', {
  ...d,
  page: 2,
  x1: M,
  y1: TOP + 88,
  x2: M + 68,
  y2: TOP + 88,
  stroke: 'Accent',
  strokeWeight: 3,
  name: 'Agenda rule',
});
await call('add_text_frame', {
  ...d,
  page: 2,
  x: M,
  y: TOP + 116,
  width: 470,
  height: 240,
  paragraphStyle: 'Numbered',
  paragraphs: [
    { text: 'Where the studio time actually goes' },
    { text: 'What we changed this quarter' },
    { text: 'Results: production, quality, morale' },
    { text: 'What we still do by hand — and why' },
    { text: 'Next quarter' },
  ],
  name: 'Agenda list',
});
// side panel with a stat
await call('add_rectangle', {
  ...d,
  page: 2,
  x: 590,
  y: TOP + 100,
  width: 306,
  height: 250,
  fill: 'Wash',
  name: 'Agenda panel',
});
await call('add_rectangle', { ...d, page: 2, x: 590, y: TOP + 100, width: 5, height: 250, fill: 'Accent', name: 'Panel edge' });
await call('add_text_frame', {
  ...d,
  page: 2,
  x: 620,
  y: TOP + 136,
  width: 250,
  height: 60,
  text: '38%',
  paragraphStyle: 'Stat',
  name: 'Panel stat',
});
await call('add_text_frame', {
  ...d,
  page: 2,
  x: 620,
  y: TOP + 196,
  width: 250,
  height: 120,
  text: 'less time from brief to first proof, measured across 42 jobs this quarter. The gain came almost entirely out of setup and versioning, not out of design time.',
  paragraphStyle: 'Stat Label',
  name: 'Panel label',
});

// ---- 3. section divider ------------------------------------------------------------------------
await call('add_rectangle', { ...d, page: 3, x: 0, y: 0, width: W, height: H, fill: 'Ink', name: 'S1 bg' });
await call('add_rectangle', { ...d, page: 3, x: 0, y: 0, width: 300, height: H, fill: 'Ink Light', name: 'S1 band' });
await call('add_text_frame', {
  ...d,
  page: 3,
  x: 74,
  y: 190,
  width: 220,
  height: 140,
  text: '01',
  paragraphStyle: 'Section Number',
  name: 'S1 number',
});
await call('add_text_frame', {
  ...d,
  page: 3,
  x: 360,
  y: 214,
  width: 520,
  height: 120,
  text: 'Where the time\nactually goes',
  paragraphStyle: 'Section Title',
  name: 'S1 title',
});
await call('add_rectangle', { ...d, page: 3, x: 360, y: 348, width: 68, height: 4, fill: 'Accent', name: 'S1 rule' });

// ---- 4. content + diagram ----------------------------------------------------------------------
await call('add_text_frame', {
  ...d,
  page: 4,
  x: M,
  y: TOP,
  width: CONTENT,
  height: 18,
  text: 'Section 01',
  paragraphStyle: 'Kicker',
  name: 'S4 kicker',
});
await call('add_text_frame', {
  ...d,
  page: 4,
  x: M,
  y: TOP + 26,
  width: 560,
  height: 50,
  text: 'Setup, not design, ate the week',
  paragraphStyle: 'Slide Title',
  name: 'S4 title',
});
await call('add_text_frame', {
  ...d,
  page: 4,
  x: M,
  y: TOP + 100,
  width: 380,
  height: 220,
  paragraphStyle: 'Bullet',
  paragraphs: [
    { text: 'Building the same grid, styles and masters for every new job.' },
    { text: 'Versioning: eleven language variants of one brochure, by hand.' },
    { text: 'Chasing links and fonts before every hand-off to the printer.' },
    { text: 'Proofing rounds lost to typos that a preflight would have caught.' },
  ],
  name: 'S4 bullets',
});
// process diagram, right half
const steps = ['Brief', 'Layout', 'Proof', 'Print'];
const stepW = 96;
const stepH = 62;
const gap = 34;
const dx0 = 500;
const dy0 = TOP + 120;
for (let i = 0; i < steps.length; i++) {
  const x = dx0 + (i % 2) * (stepW + gap + 60);
  const y = dy0 + Math.floor(i / 2) * (stepH + 54);
  await call('add_rectangle', {
    ...d,
    page: 4,
    x,
    y,
    width: stepW,
    height: stepH,
    fill: i === 1 ? 'Accent' : 'Wash',
    stroke: i === 1 ? 'none' : 'Rule',
    strokeWeight: 1,
    cornerRadius: 8,
    name: `Step ${i + 1}`,
  });
  await call('add_text_frame', {
    ...d,
    page: 4,
    x: x + 8,
    y: y + 21,
    width: stepW - 16,
    height: 20,
    text: steps[i]!,
    paragraphStyle: 'Chart Value',
    name: `Step label ${i + 1}`,
  });
}
await call('add_line', {
  ...d,
  page: 4,
  x1: dx0 + stepW + 8,
  y1: dy0 + stepH / 2,
  x2: dx0 + stepW + gap + 52,
  y2: dy0 + stepH / 2,
  stroke: 'Grey',
  strokeWeight: 1,
  name: 'Arrow 1',
});
await call('add_line', {
  ...d,
  page: 4,
  x1: dx0 + stepW + 8,
  y1: dy0 + stepH + 54 + stepH / 2,
  x2: dx0 + stepW + gap + 52,
  y2: dy0 + stepH + 54 + stepH / 2,
  stroke: 'Grey',
  strokeWeight: 1,
  name: 'Arrow 2',
});
await call('add_text_frame', {
  ...d,
  page: 4,
  x: dx0,
  y: dy0 + 2 * stepH + 78,
  width: 340,
  height: 40,
  text: 'Highlighted: the step the studio spends most of its week on.',
  paragraphStyle: 'Stat Label',
  name: 'S4 caption',
});

// ---- 5. table ----------------------------------------------------------------------------------
await call('add_text_frame', {
  ...d,
  page: 5,
  x: M,
  y: TOP,
  width: CONTENT,
  height: 18,
  text: 'Results',
  paragraphStyle: 'Kicker',
  name: 'S5 kicker',
});
await call('add_text_frame', {
  ...d,
  page: 5,
  x: M,
  y: TOP + 26,
  width: 560,
  height: 50,
  text: 'Three quarters, same team',
  paragraphStyle: 'Slide Title',
  name: 'S5 title',
});
await call('add_table', {
  ...d,
  page: 5,
  x: M,
  y: TOP + 108,
  width: CONTENT,
  name: 'Metrics',
  headerRows: 1,
  data: [
    ['Measure', 'Q1', 'Q2', 'Q3', 'Change'],
    ['Jobs delivered', '31', '36', '42', '+35%'],
    ['Hours per job', '19.4', '15.1', '12.0', '−38%'],
    ['Proof rounds', '3.1', '2.4', '1.9', '−39%'],
    ['Errors found at press', '7', '3', '1', '−86%'],
    ['Studio overtime (hours)', '96', '54', '22', '−77%'],
  ],
  columnWidths: [332, 100, 100, 100, 200],
  rowHeights: [30, 30, 30, 30, 30, 30],
  headerParagraphStyle: 'Table Head',
  paragraphStyle: 'Table Cell',
  cellInset: 8,
  headerFill: 'Ink',
  alternatingFill: 'Wash',
  strokeWeight: 0.5,
  strokeColor: 'Rule',
  borderWeight: 0,
});
await call('add_text_frame', {
  ...d,
  page: 5,
  x: M,
  y: TOP + 320,
  width: 560,
  height: 40,
  text: 'Same five designers, same clients, no overtime budget.',
  paragraphStyle: 'Stat Label',
  name: 'S5 note',
});

// ---- 6. chart ----------------------------------------------------------------------------------
await call('add_text_frame', {
  ...d,
  page: 6,
  x: M,
  y: TOP,
  width: CONTENT,
  height: 18,
  text: 'Results',
  paragraphStyle: 'Kicker',
  name: 'S6 kicker',
});
await call('add_text_frame', {
  ...d,
  page: 6,
  x: M,
  y: TOP + 26,
  width: 620,
  height: 50,
  text: 'Hours from brief to first proof',
  paragraphStyle: 'Slide Title',
  name: 'S6 title',
});
const bars = [
  { label: 'Oct', value: 20.1 },
  { label: 'Nov', value: 19.0 },
  { label: 'Dec', value: 17.4 },
  { label: 'Jan', value: 15.1 },
  { label: 'Feb', value: 13.6 },
  { label: 'Mar', value: 12.0 },
];
const chartTop = TOP + 120;
const chartBottom = 400;
const chartHeight = chartBottom - chartTop;
const maxValue = 22;
const barW = 74;
const barGap = 34;
const chartLeft = M + 30;
for (let i = 0; i < bars.length; i++) {
  const bar = bars[i]!;
  const h = Math.round((bar.value / maxValue) * chartHeight);
  const x = chartLeft + i * (barW + barGap);
  const y = chartBottom - h;
  await call('add_rectangle', {
    ...d,
    page: 6,
    x,
    y,
    width: barW,
    height: h,
    fill: i === bars.length - 1 ? 'Accent' : 'Ink',
    name: `Bar ${bar.label}`,
  });
  await call('set_appearance', {
    ...d,
    item: `Bar ${bar.label}`,
    opacity: i === bars.length - 1 ? 100 : 22 + i * 12,
  });
  await call('add_text_frame', {
    ...d,
    page: 6,
    x: x - 6,
    y: y - 22,
    width: barW + 12,
    height: 16,
    text: bar.value.toFixed(1),
    paragraphStyle: 'Chart Value',
    name: `Value ${bar.label}`,
  });
  await call('add_text_frame', {
    ...d,
    page: 6,
    x: x - 6,
    y: chartBottom + 10,
    width: barW + 12,
    height: 16,
    text: bar.label,
    paragraphStyle: 'Chart Label',
    name: `Label ${bar.label}`,
  });
}
await call('add_line', {
  ...d,
  page: 6,
  x1: M,
  y1: chartBottom,
  x2: W - M,
  y2: chartBottom,
  stroke: 'Rule',
  strokeWeight: 1,
  name: 'Axis',
});
await call('add_text_frame', {
  ...d,
  page: 6,
  x: 700,
  y: TOP + 130,
  width: 196,
  height: 120,
  text: 'The drop starts in January, when the shared master pages went in — not when the new hires arrived.',
  paragraphStyle: 'Stat Label',
  name: 'S6 note',
});

// ---- 7. quote ----------------------------------------------------------------------------------
await call('add_rectangle', { ...d, page: 7, x: 0, y: 0, width: W, height: H, fill: 'Wash', name: 'S7 bg' });
await call('add_text_frame', {
  ...d,
  page: 7,
  x: M,
  y: 120,
  width: 90,
  height: 120,
  text: '“',
  paragraphStyle: 'Section Number',
  name: 'S7 mark',
});
await call('add_text_frame', {
  ...d,
  page: 7,
  x: 170,
  y: 150,
  width: 620,
  height: 200,
  text: 'The layout still comes out of a designer’s head. What changed is that nobody spends Thursday rebuilding the same grid for the eleventh time.',
  paragraphStyle: 'Quote',
  name: 'S7 quote',
});
await call('add_rectangle', { ...d, page: 7, x: 170, y: 340, width: 44, height: 3, fill: 'Accent', name: 'S7 rule' });
await call('add_text_frame', {
  ...d,
  page: 7,
  x: 170,
  y: 360,
  width: 420,
  height: 40,
  text: 'Grace Lindqvist, senior designer',
  paragraphStyle: 'Attribution',
  name: 'S7 attribution',
});

// ---- 8. closing --------------------------------------------------------------------------------
await call('add_rectangle', { ...d, page: 8, x: 0, y: 0, width: W, height: H, fill: 'Ink', name: 'S8 bg' });
await call('add_rectangle', { ...d, page: 8, x: M, y: 214, width: 68, height: 5, fill: 'Accent', name: 'S8 rule' });
await call('add_text_frame', {
  ...d,
  page: 8,
  x: M,
  y: 250,
  width: 620,
  height: 80,
  text: 'Questions, please.',
  paragraphStyle: 'Hero Title',
  name: 'S8 title',
});
await call('add_text_frame', {
  ...d,
  page: 8,
  x: M,
  y: 348,
  width: 520,
  height: 60,
  text: 'ada@northwind.studio  ·  northwind.studio/review\nDeck and working files in the shared drive.',
  paragraphStyle: 'Hero Sub',
  name: 'S8 contact',
});

// ---- check and render --------------------------------------------------------------------------
const validated = await call('validate_document', d);
console.log('validate:', validated._text);
const preflight = await call('preflight_document', { ...d, intent: 'screen' });
console.log('preflight:', String(preflight._text).split('\n').slice(0, 12).join('\n'));

for (let page = 1; page <= 8; page++) {
  const r = await client.callTool({
    name: 'preview_page',
    arguments: { document: doc, page, renderer: 'builtin', width: 1400, save: false },
  });
  const image = (r.content as { type?: string; data?: string }[]).find((c) => c.type === 'image');
  if (!image?.data) {
    console.error(`no image for page ${page}`);
    continue;
  }
  writeFileSync(join(OUT, `slide-${page}.png`), Buffer.from(image.data, 'base64'));
}
console.log(`rendered 8 slides to ${OUT}`);
console.log(failures ? `${failures} tool call(s) failed` : 'all tool calls succeeded');
if (failures) process.exit(1);
