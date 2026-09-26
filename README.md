# InDesign MCP

Create and edit **Adobe InDesign documents from Claude** — pages, master pages, text frames with paragraph and character styles, swatches, layers, placed pictures and AI-generated images — and look at the result as a picture before you open it in InDesign.

This is a community project. It is not made, endorsed or supported by Adobe; you do not need InDesign to use it, but it uses InDesign for previews and PDFs when it is installed.

It works on the open **IDML** format that InDesign opens with *File › Open* (and exports with *File › Export › Adobe InDesign Markup*).

```
You:     Make an A5 flyer called "summer-sale" for our bakery: a big headline, a short
         paragraph, a photo of croissants and our address at the bottom. Warm colours.
Claude:  (creates the document, styles and swatches, lays out the frames, generates the
          photo with OpenAI, shows you a preview image, and tells you where the file is)
```

## Install

### Claude plugin (Claude Code and Cowork)

Requires [Bun](https://bun.sh) 1.3 or newer on your `PATH`; the plugin runs the server from the TypeScript source in this repository with Bun.

```sh
claude plugin marketplace add hofmeister/indesign-mcp
claude plugin install indesign-mcp@indesign-mcp
```

Claude Code installs the dependencies from `bun.lock` when you install the plugin (`bun install --frozen-lockfile --ignore-scripts`) and then asks for five settings, all optional:

- **OpenAI API key** — only needed to *generate or edit pictures for your layouts*; stored in your system's secure credential store.
- **Documents folder** — where bare file names are saved (default `~/Documents/InDesign MCP`).
- **Reference documents folder** — your own `.idml` exports that Claude may borrow styles, colours and master pages from.
- **Default unit** (`mm`, `cm`, `in`, `pt`) and **OpenAI image model**.

The plugin runs the InDesign server only. Its picture tools make pictures for the document being designed and place them in the layout; the standalone image server described in [Image generation on its own](#image-generation-on-its-own) is not part of the plugin.

To try a working copy, run `claude --plugin-dir .` in the repository, and `claude plugin validate .` before you push.

### Claude Desktop (one click)

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

## Example prompts

- "Make an A5 flyer called `summer-sale` for our bakery: a big headline, a short paragraph, a photo placeholder and our address at the bottom. Warm colours. Show me a preview."
- "Open `annual-report.idml`, check it for overset text, missing fonts and low-resolution pictures, and fix what you can."
- "Create a 12-page A4 magazine template with a master page that has running headers and page numbers, three columns, and paragraph styles for headline, standfirst, body and captions."
- "Fill the `name-badge.idml` template with one page per row of `attendees.csv`, then export it as a PDF."

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
- **Image generation runs in the background.** A picture can take minutes, longer than most MCP clients wait for an answer. `generate_image` and `edit_image` therefore wait a while (`waitSeconds`, 45 s by default) and then return a job id instead of failing; `wait_for_image` collects the picture, and can be called again as often as needed. Giving up on a wait never cancels the work or generates — or pays for — the same picture twice.
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
| `IMAGE_MCP_OUTPUT` | Folder for the standalone image server's pictures | `~/Documents/AI Images` |
| `IMAGE_MCP_MODEL` | Its OpenAI image model | `gpt-image-2` |

The `.mcpb` bundle exposes the first four as fields in Claude Desktop's extension settings, and the Claude plugin asks for the first four plus `INDESIGN_MCP_DEFAULT_UNIT`.

## Image generation on its own

*Not part of the Claude plugin.*

The same program also runs as a small **image-only MCP server** with no InDesign in it: `generate_image`, `edit_image`, `wait_for_image` and `list_image_jobs`, writing PNGs to a folder. Useful if you just want pictures.

```sh
indesign-mcp images                          # start it on stdio
indesign-mcp setup --images --openai-key sk-…  # register it as "openai-images" alongside the InDesign server
claude mcp add openai-images -e OPENAI_API_KEY=sk-… -- /path/to/indesign-mcp images
```

It uses the same models, the same size handling and the same background jobs as the tools inside the InDesign server.

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

To publish a release, run the **Release** workflow from the Actions tab and pick `patch`, `minor` or `major`. It works off `master`: the tests run first, then the new version is written to `package.json` and `.claude-plugin/plugin.json`, committed and tagged, and the executables, the `.mcpb` bundles and the GitHub Release are built from that commit. The version counts up from the newest `vX.Y.Z` tag; with no tags yet, the version already in `package.json` is released as it stands and the choice is ignored.

Pushing a tag `vX.Y.Z` that matches `package.json` still works and releases the commit the tag points at.

If the repository secrets `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` exist, the macOS binaries are signed and notarized; otherwise they are ad-hoc signed and `setup` clears the quarantine flag.

### Making it better with your own files

- Drop InDesign exports into `references/` (bundled) or point `INDESIGN_MCP_REFERENCES` at a folder. Real exports are the best templates.
- Add the IDML schema of your InDesign version (`schemas/idml/README.md`) for exact validation.
- Open documents Claude produced in InDesign and go through [docs/manual-checklist.md](docs/manual-checklist.md); report anything InDesign complains about.

## Privacy

The server runs on your computer. It has no server of its own, collects no analytics or telemetry, and sends nothing to its author or to Anthropic.

- **What it sends, and where:** only `generate_image` and `edit_image` use the network. They send your picture prompt, and for `edit_image` the pictures and masks you pass, to the OpenAI Images API (`api.openai.com`) with your own OpenAI API key. Without a key those tools are off and nothing leaves your computer. `wait_for_image` only collects a picture that is already being made.
- **What it runs:** when Adobe InDesign is installed, previews and PDF exports ask it to open the document, through `osascript` on macOS or `cscript` on Windows. The server starts nothing else. (The `setup` command, which the plugin does not use, also runs `claude mcp add` and, on macOS, `xattr` to clear the download quarantine flag.)
- **What it stores:** the documents you create and edit, pictures it generates (in a `Links` folder next to the document), previews and exports — all in the folders you choose, by default `~/Documents/InDesign MCP`. It keeps no other files, caches or logs apart from short-lived scripts in the system temp folder when it drives InDesign; diagnostics go to the MCP client's log on stderr. The API key is kept by Claude Code in your system's secure credential store and held only in memory while the server runs.
- **Third parties:** OpenAI receives the prompts and pictures above and handles them under the [OpenAI privacy policy](https://openai.com/policies/privacy-policy) and API data-usage terms. Tool results go back to Claude as part of your conversation, where Anthropic's policies apply.
- **Retention:** your documents and pictures stay until you delete them. Background image jobs live in memory and are gone when the server stops.
- **Contact:** open an issue at [github.com/hofmeister/indesign-mcp/issues](https://github.com/hofmeister/indesign-mcp/issues) for questions about privacy or security.

## Support

Report bugs and ask questions at [github.com/hofmeister/indesign-mcp/issues](https://github.com/hofmeister/indesign-mcp/issues). Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). Bundled third-party material: IDML schemas via transpect (BSD-2-Clause), reference fixtures from SimpleIDML (BSD), fonts Arimo/Tinos/Cousine (SIL OFL 1.1).
