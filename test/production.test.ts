import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { unzlibSync } from 'fflate';
import { loadConfig } from '../src/config.ts';
import { exportDocument } from '../src/export/index.ts';
import { pathDataToPdf } from '../src/export/pdf.ts';
import {
  listMergeFields,
  mergeRecords,
  mergeToDocuments,
  parseCsv,
  readDataSource,
} from '../src/idml/datamerge.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { placeImage } from '../src/idml/images.ts';
import { createRectangle, createTextFrame, findItem, listItems } from '../src/idml/items.ts';
import { embedGraphic, findGraphic, listLinks, relinkGraphic, unembedGraphic } from '../src/idml/links.ts';
import { packageDocument } from '../src/idml/packaging.ts';
import { listPages } from '../src/idml/pages.ts';
import { preflight, preflightToMarkdown } from '../src/idml/preflight.ts';
import { validateAgainstSchema } from '../src/idml/schema.ts';
import { readStoryPlainText, setStoryText, textToParagraphs } from '../src/idml/stories.ts';
import { createDocument } from '../src/idml/template.ts';
import { validateDocument } from '../src/idml/validate.ts';
import { encodePng } from '../src/images/thumbnail.ts';
import { createServer } from '../src/server.ts';

const MEDIA = join(import.meta.dir, 'fixtures', 'idml', 'media');

function errorsOf(doc: IdmlDocument): string[] {
  const again = IdmlDocument.fromBytes(doc.toBytes());
  return [
    ...validateDocument(again)
      .filter((i) => i.level === 'error')
      .map((i) => `${i.part}: ${i.message}`),
    ...validateAgainstSchema(again)
      .issues.filter((i) => i.level === 'error')
      .map((i) => `${i.part} ${i.path}: ${i.message}`),
  ];
}

/** Decompresses every Flate stream in a PDF (the page content streams among them). */
function pdfStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  const text = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('\nendstream', start);
    if (end < 0) continue;
    try {
      out.push(Buffer.from(unzlibSync(pdf.subarray(start, end))).toString('latin1'));
    } catch {
      // not a deflate stream (an embedded JPEG, for instance)
    }
  }
  return out;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `indesign-mcp-${prefix}-`));
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return encodePng({ width, height, data });
}

function docWithImage(dir: string): { doc: IdmlDocument; path: string } {
  const doc = createDocument({ pageSize: 'A4' });
  placeImage(
    doc,
    { page: 1 },
    { rect: { x: 20, y: 20, width: 120, height: 90 }, name: 'Picture' },
    { path: join(MEDIA, 'default.jpg') },
  );
  const path = join(dir, 'linked.idml');
  doc.save(path);
  return { doc, path };
}

describe('links', () => {
  test('lists placed pictures with their state', () => {
    const dir = tempDir('links');
    const { doc } = docWithImage(dir);
    const links = listLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0]!.fileName).toBe('default.jpg');
    expect(links[0]!.status).toBe('ok');
    expect(links[0]!.page).toBe(1);
    expect(links[0]!.widthPx).toBeGreaterThan(0);
    expect(links[0]!.effectivePpi).toBeGreaterThan(0);
  });

  test('a link pointing at nothing is reported as missing', () => {
    const dir = tempDir('links-missing');
    const { doc } = docWithImage(dir);
    const hit = findGraphic(doc, 'Picture');
    hit.link!.setAttribute('LinkResourceURI', 'file:/nowhere/gone.jpg');
    expect(listLinks(doc)[0]!.status).toBe('missing');
  });

  test('relinks to another file and keeps the frame', () => {
    const dir = tempDir('relink');
    const { doc } = docWithImage(dir);
    const other = join(dir, 'other.png');
    writeFileSync(other, solidPng(400, 200, [10, 20, 30, 255]));
    const before = findItem(doc, 'Picture').info.bounds!;
    const r = relinkGraphic(doc, findGraphic(doc, 'Picture'), other);
    expect(basename(r.to)).toBe('other.png');
    expect(r.widthPx).toBe(400);
    const links = listLinks(doc);
    expect(links[0]!.fileName).toBe('other.png');
    expect(links[0]!.status).toBe('ok');
    const after = findItem(doc, 'Picture').info.bounds!;
    expect(after.width).toBeCloseTo(before.width, 3);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('embeds a picture and writes it back out again', () => {
    const dir = tempDir('embed');
    const { doc } = docWithImage(dir);
    const embedded = embedGraphic(doc, findGraphic(doc, 'Picture'));
    expect(embedded.bytes).toBeGreaterThan(0);
    expect(listLinks(doc)[0]!.embedded).toBe(true);
    expect(errorsOf(doc)).toEqual([]);

    const out = join(dir, 'Links');
    const written = unembedGraphic(doc, findGraphic(doc, 'Picture'), out);
    expect(existsSync(written.path)).toBe(true);
    expect(readFileSync(written.path).length).toBe(readFileSync(join(MEDIA, 'default.jpg')).length);
    expect(listLinks(doc)[0]!.embedded).toBe(false);
    expect(listLinks(doc)[0]!.status).toBe('ok');
  });
});

describe('preflight', () => {
  test('finds overset text, missing links and low resolution', () => {
    const dir = tempDir('preflight');
    const doc = createDocument({ pageSize: 'A4' });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 40, height: 12 }, text: '', name: 'Tiny' },
    );
    const story = doc.story(frame.getAttribute('ParentStory')!)!;
    setStoryText(
      doc,
      story,
      textToParagraphs(
        'This paragraph is far too long to fit into such a small frame, which is exactly the point of the test.',
      ),
    );
    // a picture scaled up hugely, so its effective resolution collapses
    placeImage(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 60, width: 400, height: 300 }, name: 'Big' },
      { path: join(MEDIA, 'default.jpg'), fit: 'stretch' },
    );
    doc.save(join(dir, 'preflight.idml'));
    const report = preflight(doc, { intent: 'print' });
    const checks = report.issues.map((i) => i.check);
    expect(checks).toContain('overset-text');
    expect(checks).toContain('low-resolution');
    expect(report.errors).toBeGreaterThan(0);
    expect(preflightToMarkdown(report)).toContain('Must fix');

    findGraphic(doc, 'Big').link!.setAttribute('LinkResourceURI', 'file:/nowhere/x.jpg');
    expect(preflight(doc).issues.map((i) => i.check)).toContain('missing-link');
  });

  test('a clean document passes', () => {
    const doc = createDocument({ pageSize: 'A4' });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 120, height: 60 }, text: 'Short and sweet.', name: 'Copy' },
    );
    expect(frame).toBeDefined();
    const report = preflight(doc);
    expect(report.errors).toBe(0);
    expect(report.ok).toBe(true);
  });
});

describe('package', () => {
  test('collects the document, its pictures and a report', () => {
    const dir = tempDir('package');
    const { doc } = docWithImage(dir);
    const folder = join(dir, 'For printer');
    const r = packageDocument(doc, { folder });
    expect(existsSync(r.document)).toBe(true);
    expect(existsSync(join(folder, 'Links', 'default.jpg'))).toBe(true);
    expect(existsSync(r.reportPath!)).toBe(true);
    expect(r.missingLinks).toBe(0);
    const report = readFileSync(r.reportPath!, 'utf8');
    expect(report).toContain('Linked images');
    expect(report).toContain('default.jpg');
    // the packaged copy points at the copied picture, the original is untouched
    const packaged = IdmlDocument.load(r.document);
    expect(listLinks(packaged)[0]!.path).toBe(join(folder, 'Links', 'default.jpg'));
    expect(listLinks(doc)[0]!.path).toBe(join(MEDIA, 'default.jpg'));
  });
});

describe('data merge', () => {
  const csv = 'Name;City;@Photo\nAda;London;photo-1.png\nGrace;New York;photo-2.png\n';

  function templateDoc(dir: string): IdmlDocument {
    const doc = createDocument({ pageSize: 'A4' });
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 20, y: 20, width: 150, height: 40 },
        text: 'Hello <<Name>> from <<City>>!',
        name: 'Badge',
      },
    );
    createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 80, width: 60, height: 60 }, name: '<<Photo>>', graphicFrame: true },
    );
    writeFileSync(join(dir, 'photo-1.png'), solidPng(120, 120, [255, 0, 0, 255]));
    writeFileSync(join(dir, 'photo-2.png'), solidPng(120, 120, [0, 0, 255, 255]));
    writeFileSync(join(dir, 'people.csv'), csv);
    return doc;
  }

  test('parses CSV with quotes and a chosen separator', () => {
    const rows = parseCsv('a,b\n"x, y",2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', '2'],
    ]);
    expect(parseCsv('a;b\n1;2\n')[1]).toEqual(['1', '2']);
  });

  test('reads a data source and lists the placeholders', () => {
    const dir = tempDir('merge-fields');
    const doc = templateDoc(dir);
    const data = readDataSource(join(dir, 'people.csv'));
    expect(data.fields).toEqual(['Name', 'City', 'Photo']);
    expect(data.imageFields).toEqual(['Photo']);
    expect(data.records[1]!.City).toBe('New York');
    const fields = listMergeFields(doc);
    expect(fields.text.sort()).toEqual(['City', 'Name']);
    expect(fields.images).toEqual(['Photo']);
  });

  test('fills one page per record, with pictures', () => {
    const dir = tempDir('merge-pages');
    const doc = templateDoc(dir);
    const data = readDataSource(join(dir, 'people.csv'));
    const r = mergeRecords(doc, data, { imageBase: dir });
    expect(r.records).toBe(2);
    expect(listPages(doc)).toHaveLength(2);
    expect(r.imagesPlaced).toBe(2);
    expect(r.missingFields).toEqual([]);
    const texts = listItems(doc)
      .filter((i) => i.type === 'text')
      .map((i) => i.text ?? '');
    expect(texts.join(' ')).toContain('Hello Ada from London!');
    expect(texts.join(' ')).toContain('Hello Grace from New York!');
    expect(
      listLinks(doc)
        .map((l) => l.fileName)
        .sort(),
    ).toEqual(['photo-1.png', 'photo-2.png']);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('writes one document per record', () => {
    const dir = tempDir('merge-docs');
    const doc = templateDoc(dir);
    const data = readDataSource(join(dir, 'people.csv'));
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    const { paths } = mergeToDocuments(doc, data, out, (rec) => rec.Name!, { imageBase: dir });
    expect(paths.map((p) => basename(p))).toEqual(['Ada.idml', 'Grace.idml']);
    const ada = IdmlDocument.load(paths[0]!);
    expect(listPages(ada)).toHaveLength(1);
    const story = ada.story(findItem(ada, 'Badge').element.getAttribute('ParentStory')!)!;
    expect(readStoryPlainText(story)).toBe('Hello Ada from London!');
    // the source document is untouched
    expect(listPages(doc)).toHaveLength(1);
  });

  test('reports fields the data does not have', () => {
    const dir = tempDir('merge-missing');
    const doc = templateDoc(dir);
    const r = mergeRecords(doc, { fields: ['Name'], imageFields: [], records: [{ Name: 'Ada' }] }, {});
    expect(r.missingFields).toEqual(['City']);
    expect(r.missingImages).toEqual(['Photo']);
  });
});

describe('export', () => {
  test('svg path data becomes PDF operators', () => {
    expect(pathDataToPdf('M10 20L30 40Z')).toBe('10 20 m\n30 40 l\nh');
    expect(pathDataToPdf('M0 0 h10 v10 z')).toBe('0 0 m\n10 0 l\n10 10 l\nh');
    expect(pathDataToPdf('M0 0Q5 5 10 0')).toContain('c');
    expect(pathDataToPdf('M0 0A5 5 0 0 1 10 0').split('\n').length).toBeGreaterThan(2);
  });

  test('writes a vector PDF of every page', async () => {
    const dir = tempDir('export-pdf');
    const doc = createDocument({ pageSize: 'A4', pages: 2 });
    createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 120, height: 40 }, text: 'Exported', name: 'Copy' },
    );
    placeImage(
      doc,
      { page: 2 },
      { rect: { x: 20, y: 20, width: 80, height: 60 }, name: 'Pic' },
      { path: join(MEDIA, 'default.jpg') },
    );
    doc.save(join(dir, 'export.idml'));
    const r = await exportDocument(doc, { format: 'pdf', path: join(dir, 'out'), renderer: 'builtin' });
    expect(r.files).toHaveLength(1);
    const pdf = readFileSync(r.files[0]!);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Type /Page');
    expect(pdf.toString('latin1').match(/\/Type \/Page[^s]/g)).toHaveLength(2);
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  test('the PDF content streams are well formed and images are stored once', async () => {
    const dir = tempDir('export-pdf-structure');
    const doc = createDocument({ pageSize: 'A5', pages: 2 });
    for (const page of [1, 2]) {
      placeImage(
        doc,
        { page },
        { rect: { x: 10, y: 10, width: 60, height: 45 }, name: `Pic ${page}` },
        { path: join(MEDIA, 'default.jpg') },
      );
    }
    doc.save(join(dir, 'twice.idml'));
    const r = await exportDocument(doc, { format: 'pdf', path: join(dir, 'twice'), renderer: 'builtin' });
    const pdf = readFileSync(r.files[0]!);
    // the same picture on both pages is embedded once
    expect(pdf.toString('latin1').match(/\/Subtype \/Image/g)).toHaveLength(1);
    const streams = pdfStreams(pdf).filter((s) => s.includes(' cm'));
    expect(streams.length).toBe(2);
    for (const stream of streams) {
      let depth = 0;
      for (const token of stream.split(/\s+/)) {
        if (token === 'q') depth++;
        else if (token === 'Q') depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
      expect(stream).toContain('Do');
    }
  });

  test('writes PNG and JPEG images', async () => {
    const dir = tempDir('export-img');
    const doc = createDocument({ pageSize: 'A5', pages: 2 });
    doc.save(join(dir, 'img.idml'));
    const png = await exportDocument(doc, {
      format: 'png',
      path: join(dir, 'page'),
      renderer: 'builtin',
      dpi: 72,
    });
    expect(png.files).toHaveLength(2);
    expect(png.files[0]!.endsWith('page-1.png')).toBe(true);
    expect(readFileSync(png.files[0]!).subarray(1, 4).toString('latin1')).toBe('PNG');

    const jpeg = await exportDocument(doc, {
      format: 'jpeg',
      path: join(dir, 'sheet'),
      pages: [1],
      renderer: 'builtin',
      dpi: 72,
    });
    expect(jpeg.files).toHaveLength(1);
    const bytes = readFileSync(jpeg.files[0]!);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });
});

describe('production tools over MCP', () => {
  let client: Client;
  let dir: string;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };
  beforeAll(async () => {
    dir = tempDir('production-tools');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('place, list, preflight, package and export a document', async () => {
    const created = await call('new_document', { path: 'catalogue', pageSize: 'A4' });
    const document = created.data!.path as string;
    await call('place_image', {
      document,
      image: join(MEDIA, 'default.jpg'),
      page: 1,
      x: 20,
      y: 20,
      width: 80,
      height: 60,
      name: 'Cover',
    });

    const links = await call('list_links', { document });
    expect(links.isError).toBe(false);
    expect(links.text).toContain('default.jpg');

    const other = join(dir, 'replacement.png');
    writeFileSync(other, solidPng(600, 400, [0, 200, 100, 255]));
    const relinked = await call('relink_image', { document, image: 'Cover', newFile: other });
    expect(relinked.text).toContain('replacement.png');

    const embedded = await call('embed_images', { document });
    expect(embedded.text).toContain('Embedded 1 picture');
    const unembedded = await call('unembed_images', { document });
    expect(unembedded.text).toContain('relinked');

    const check = await call('preflight_document', { document });
    expect(check.isError).toBe(false);
    expect(check.data!.errors).toBe(0);

    const packaged = await call('package_document', { document, folder: join(dir, 'handover') });
    expect(existsSync(packaged.data!.document as string)).toBe(true);

    const exported = await call('export_document', {
      document,
      format: 'pdf',
      outputFile: join(dir, 'catalogue-print'),
      renderer: 'builtin',
    });
    expect(exported.isError).toBe(false);
    const files = exported.data!.files as string[];
    expect(existsSync(files[0]!)).toBe(true);
  });

  test('data merge from a CSV file', async () => {
    const created = await call('new_document', { path: 'badges', pageSize: 'A6' });
    const document = created.data!.path as string;
    await call('add_text_frame', {
      document,
      page: 1,
      x: 10,
      y: 10,
      width: 80,
      height: 20,
      text: '<<Name>> — <<Role>>',
      name: 'Badge',
    });
    const csv = join(dir, 'team.csv');
    writeFileSync(csv, 'Name,Role\nAda,Engineer\nGrace,Admiral\nAlan,Cryptanalyst\n');

    const fields = await call('list_merge_fields', { document });
    expect(fields.text).toContain('<<Name>>');

    const merged = await call('data_merge', { document, dataFile: csv });
    expect(merged.isError).toBe(false);
    expect(merged.data!.records).toBe(3);

    const pages = await call('list_pages', { document });
    expect((pages.data!.pages as unknown[]).length).toBe(3);
    const described = await call('describe_document', { document });
    expect(described.text).toContain('Grace');
    expect(described.text).toContain('Cryptanalyst');
  });
});
