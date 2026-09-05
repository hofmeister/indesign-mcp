// Generates docs/tools.md from the live tool registry (names, descriptions, parameters).

import { mkdirSync, writeFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer(
  loadConfig({ INDESIGN_MCP_DOCUMENTS: '/tmp', INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
).connect(st);
const client = new Client({ name: 'docs', version: '0' });
await client.connect(ct);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();

const groups: [string, RegExp][] = [
  [
    'Documents',
    /^(new_document|open_document|describe_document|validate_document|save_document_as|set_document_options|server_info)$/,
  ],
  [
    'Pages, masters and layers',
    /^(list_pages|add_pages|remove_pages|set_page_size|set_margins_and_columns|list_masters|apply_master|create_master|list_layers|create_layer|set_layer_options|set_item_layer)$/,
  ],
  [
    'Frames and shapes',
    /^(list_items|add_text_frame|add_rectangle|add_ellipse|add_line|move_item|resize_item|rotate_item|set_appearance|delete_item|duplicate_item|rename_item|arrange_item|align_items|set_text_frame_options|set_text_wrap|fit_frame_to_content)$/,
  ],
  [
    'Text',
    /^(get_text|set_text|append_text|find_and_replace|apply_paragraph_style|format_text|insert_page_number|thread_text_frames)$/,
  ],
  [
    'Styles, swatches and fonts',
    /^(list_styles|create_paragraph_style|create_character_style|update_style|delete_style|list_swatches|create_swatch|list_fonts)$/,
  ],
  ['Pictures', /^(place_image|set_image_fit|generate_image|edit_image|list_images)$/],
  [
    'Reference documents',
    /^(list_reference_documents|describe_reference|add_reference_folder|new_document_from_reference|import_styles_from_reference|copy_master_from_reference|copy_page_from_reference)$/,
  ],
  ['Previews', /^preview_/],
];

function params(schema: unknown): string {
  const s = schema as {
    properties?: Record<
      string,
      { type?: string; description?: string; enum?: string[]; anyOf?: { type?: string }[] }
    >;
    required?: string[];
  };
  if (!s?.properties) return '';
  const req = new Set(s.required ?? []);
  const rows = Object.entries(s.properties).map(([name, p]) => {
    const type = p.enum
      ? p.enum.map((e) => `\`${e}\``).join(' \\| ')
      : (p.type ??
        (p.anyOf
          ? p.anyOf
              .map((a) => a.type)
              .filter(Boolean)
              .join(' \\| ')
          : 'any'));
    return `| \`${name}\`${req.has(name) ? ' *' : ''} | ${type} | ${(p.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`;
  });
  return `\n| Parameter | Type | Description |\n|---|---|---|\n${rows.join('\n')}\n`;
}

const seen = new Set<string>();
const out: string[] = [
  '# Tools',
  '',
  `${tools.length} tools. Parameters marked with * are required. Lengths accept a number in millimetres or a string with a unit ("10mm", "0.5in", "12pt").`,
  '',
];
for (const [title, re] of groups) {
  const group = tools.filter((t) => re.test(t.name));
  if (!group.length) continue;
  out.push(`## ${title}`, '');
  for (const t of group) {
    seen.add(t.name);
    out.push(`### \`${t.name}\``, '', t.description ?? '', params(t.inputSchema));
  }
}
const rest = tools.filter((t) => !seen.has(t.name));
if (rest.length) {
  out.push('## Other', '');
  for (const t of rest) out.push(`### \`${t.name}\``, '', t.description ?? '', params(t.inputSchema));
}
out.push('# Prompts', '', 'Prompts appear as slash commands in Claude Desktop.', '');
for (const p of prompts)
  out.push(
    `- **${p.name}** — ${p.description ?? ''}${p.arguments?.length ? ` Arguments: ${p.arguments.map((a) => `\`${a.name}\`${a.required ? '*' : ''}`).join(', ')}.` : ''}`,
  );
out.push('');
mkdirSync('docs', { recursive: true });
writeFileSync('docs/tools.md', out.join('\n'));
console.log(`wrote docs/tools.md (${tools.length} tools, ${prompts.length} prompts)`);
process.exit(0);
