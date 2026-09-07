# InDesign MCP

Create and edit **Adobe InDesign documents from Claude** — pages, master pages, text frames with paragraph and character styles, swatches, layers, placed pictures and AI-generated images — and look at the result as a picture before you open it in InDesign.

It is a single program with nothing else to install. It works on the open **IDML** format that InDesign opens with *File › Open* (and exports with *File › Export › Adobe InDesign Markup*).

```
You:     Make an A5 flyer called "summer-sale" for our bakery: a big headline, a short
         paragraph, a photo of croissants and our address at the bottom. Warm colours.
Claude:  (creates the document, styles and swatches, lays out the frames, generates the
          photo with OpenAI, shows you a preview image, and tells you where the file is)
```

## Install

### Claude Desktop (recommended, one click)

1. Go to the [latest release](../../releases/latest).
2. Download the `.mcpb` file for your computer:
   `…-macos-arm64.mcpb` (Mac with Apple Silicon), `…-macos-x64.mcpb` (Intel Mac) or `…-windows-x64.mcpb`.
3. Double-click it. Claude Desktop installs it and asks for two optional settings:
   - **OpenAI API key** — only needed if you want Claude to *generate or edit pictures* (get one at platform.openai.com; image generation is billed by OpenAI per picture).
   - **Reference documents folder** — a folder with your own `.idml` exports that Claude may borrow styles, colours and master pages from.
4. Start a new chat and ask for a document. Claude will show previews as it works.

### Claude Code or other MCP clients

1. Download the plain executable for your platform from the [latest release](../../releases/latest) (`indesign-mcp-<version>-macos-arm64`, `…-windows-x64.exe`, …).
2. Open a terminal in the download folder and run:

   ```sh
   chmod +x indesign-mcp-*            # macOS / Linux only
   ./indesign-mcp-* setup             # registers the server with Claude Desktop and Claude Code
   ./indesign-mcp-* doctor            # checks fonts, InDesign, the API key and renders a test page
   ```

   `setup` asks for your OpenAI key (optional) and writes the configuration for you. On macOS it also removes the download quarantine flag so Claude can start the program. You can also run it non-interactively:
   `indesign-mcp setup --openai-key sk-… --references ~/Documents/InDesign-References`.

## What Claude can do with it

| Area | Tools |
|---|---|
| Documents | new document (page size presets, orientation, pages, margins, columns, bleed), open, describe, validate (structure **and** Adobe's IDML schema), save as |
| Pages | add / remove / move / duplicate pages, reflow spreads, page size, margins & columns, master pages (list, apply, create, override items), layers (create, reorder, delete) |
| Frames | text frames, rectangles, ellipses, lines, polygons & stars, free-form paths; move, resize, rotate, duplicate, step-and-repeat, group / ungroup, align, arrange (z-order), fill, stroke, corner radius, opacity & blend mode, text wrap, auto-size |
| Text | set / append text (with `**bold**` / `*italic*` markup), per-paragraph styles, find & replace (regex), format matches, page-number markers, threaded frames, hyperlinks, special characters, anchored objects |
| Typography | bullets and numbering, tab stops with leaders, sections and page-number style (1, i, I, a, A), prefixes, text variables (running headers, dates, file name, chapter number), nested / line / GREP styles |
| Tables | create tables, set cell text, style cells (fill, strokes, insets, alignment), insert / delete rows and columns, merge cells, column widths and row heights |
| Styles | paragraph, character and object styles (font, size, leading, alignment, spacing, indents, hyphenation, case, colour…), update, delete, swatches (CMYK/RGB/hex, spot), gradients, fonts |
| Pictures | place existing files (PNG/JPEG/TIFF/PSD/PDF…), fit options, relink, embed / unembed, **generate images with OpenAI** (`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`), **edit/combine images** with prompts and masks, resolution check |
| References | list bundled and your own `.idml` files, describe them, start a new document from one, import styles/swatches/fonts, copy master pages or whole pages |
| Production | preflight (overset text, low-resolution or missing pictures, missing fonts, RGB in print work, hairlines, missing bleed), package for a printer, data merge from CSV/JSON, export to PDF / PNG / JPEG |
| Previews | render a page, a spread, one item, or a contact sheet of all pages to PNG. Uses **Adobe InDesign itself when it is installed** (pixel-exact), otherwise a built-in renderer with real fonts, tables, bullets, drop caps, tab leaders, text wrap and anchored objects |

The full list with parameters is in [docs/tools.md](docs/tools.md). Three prompts (`design-from-brief`, `match-reference-look`, `review-layout`) appear as slash commands in Claude Desktop.

### Good to know

- **Everything is saved immediately.** Each tool call writes the `.idml` file. Bare file names go to the documents folder (`~/Documents/InDesign MCP` by default).
- **Measurements** default to millimetres from the top-left corner of the page; you can say `"0.5in"` or `"12pt"` anywhere.
- **Mistakes are caught early.** Sizes that cannot work (a frame with no width, a line that is a point, a page bigger than InDesign allows, margins with no room left for text) are refused with an explanation, and anything that lands on the pasteboard or hangs over the trim edge comes back with a note saying so.
- **Fonts are not embedded.** Claude tells you which fonts a document uses; they must be installed on the computer that opens it in InDesign. Previews substitute missing fonts with metric-compatible ones and say so.
- **Pictures stay linked**, like in InDesign. Generated and edited pictures are saved in a `Links` folder next to the document.
- **Exporting**: with InDesign installed, `export_document` lets InDesign make the PDF (press-ready, colour-managed). Without it the built-in exporter writes a vector PDF with the text as outlines — fine for proofs and web use, not for a printer.
- **Validation** runs against Adobe's own IDML schema (InDesign 2020 is bundled; newer schema versions can be added, see `schemas/idml/README.md`).

## Settings

| Environment variable | Meaning | Default |
|---|---|---|
| `OPENAI_API_KEY` | Enables `generate_image` / `edit_image` | off |
| `INDESIGN_MCP_IMAGE_MODEL` | OpenAI image model | `gpt-image-2` |
| `INDESIGN_MCP_DOCUMENTS` | Folder for bare file names | `~/Documents/InDesign MCP` |
| `INDESIGN_MCP_REFERENCES` | Folder(s) with reference `.idml` files (`;`-separated) | none |
| `INDESIGN_MCP_DEFAULT_UNIT` | `mm`, `cm`, `in`, `pt` | `mm` |
| `INDESIGN_MCP_SCHEMA_DIR` | Extra IDML schema versions | none |
| `INDESIGN_MCP_FONT_DIRS` | Extra font folders for previews | none |
| `INDESIGN_MCP_DISABLE_INDESIGN` | `1` = never use an installed InDesign for previews | off |

The `.mcpb` bundle exposes the first four as fields in Claude Desktop's extension settings.

## An example

`examples/presentation.ts` builds an eight-slide deck through the same tools Claude uses — master
page with a running footer and page number, a type scale, a numbered agenda, a bulleted list, a
process diagram, a metrics table, a bar chart drawn from rectangles, a quote slide and a closing
slide — then renders every slide to PNG:

```bash
bun run example ~/Desktop/deck    # or: bun run examples/presentation.ts <folder>
```

## Development

Requirements: [Bun](https://bun.sh) 1.3+.

```sh
bun install
bun test                 # unit, integration and schema tests
bun run lint             # biome
bun run typecheck        # tsc
bun run dev              # run the server from source (stdio)
bun run scripts/call.ts '[{"tool":"preview","arguments":{...}}]'   # tool calls against the source, previews saved as images
bun run build            # single executable for this platform -> dist/
bun run build:all        # macOS (arm64, x64), Windows x64, Linux (x64, arm64)
bun run smoke dist/indesign-mcp   # drive a compiled binary over JSON-RPC
bun run gen              # regenerate embedded asset lists (references/, schemas/, fonts/)
bun run docs             # regenerate docs/tools.md
```

Layout: `src/idml` (IDML package, XML, pages, items, stories, styles, images, validator, template), `src/rng` (RELAX NG engine), `src/references`, `src/images` (OpenAI provider), `src/preview` (fonts, composer, SVG, PNG, InDesign bridge), `src/tools` (MCP tools), `test/`, `schemas/idml` (Adobe's schemas), `references/` (bundled reference documents), `fonts/` (bundled fallback fonts).

### Releasing

CI runs lint, type check, tests, cross-compiles every target and smoke-tests the binaries on Linux, macOS and Windows for every pull request.

To publish a release, run the **Release** workflow from the Actions tab and pick `patch`, `minor` or `major`. It works off `master`: the tests run first, then the new version is written to `package.json`, committed and tagged, and the executables, the `.mcpb` bundles and the GitHub Release are built from that commit. The version counts up from the newest `vX.Y.Z` tag; with no tags yet, the version already in `package.json` is released as it stands and the choice is ignored.

Pushing a tag `vX.Y.Z` that matches `package.json` still works and releases the commit the tag points at.

If the repository secrets `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` exist, the macOS binaries are signed and notarized; otherwise they are ad-hoc signed and `setup` clears the quarantine flag.

### Making it better with your own files

- Drop InDesign exports into `references/` (bundled) or point `INDESIGN_MCP_REFERENCES` at a folder. Real exports are the best templates.
- Add the IDML schema of your InDesign version (`schemas/idml/README.md`) for exact validation.
- Open documents Claude produced in InDesign and go through [docs/manual-checklist.md](docs/manual-checklist.md); report anything InDesign complains about.

## License

MIT. Bundled third-party material: IDML schemas via transpect (BSD-2-Clause), reference fixtures from SimpleIDML (BSD), fonts Arimo/Tinos/Cousine (SIL OFL 1.1).
