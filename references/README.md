# Reference documents

Every `.idml` file in this folder is bundled into the server binary and offered to Claude as a
reference: it can inspect the file, copy its paragraph/character styles, swatches, master pages
or whole pages into a new document, or start a new document from it.

Add your own InDesign exports here (File > Export > Adobe InDesign Markup (IDML)) and rebuild,
or point the server at a folder on your computer with the `INDESIGN_MCP_REFERENCES` environment
variable (several folders separated by `;`). Files added at runtime need no rebuild.

The three starter files come from the SimpleIDML test suite (BSD license, see
`test/fixtures/idml/LICENSE-SimpleIDML`).

After adding files here run `bun run gen` so `src/generated/references.ts` lists them.
