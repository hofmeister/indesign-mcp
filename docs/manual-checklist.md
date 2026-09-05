# Checking a generated document in InDesign

The server cannot run InDesign itself (unless it is installed next to it), so the final judge is
InDesign. After Claude produced a document, open the `.idml` with *File › Open* and check:

1. **It opens without a dialog.** A warning about missing fonts or links is normal; an error about
   the file being damaged is not — send the `.idml` and the tool output to the developers.
2. **Pages** — count, size, facing pages, margins and columns match what was asked.
3. **Frames** — every text frame, picture frame and shape is on the right page at the right
   position (rulers set to page origin, millimetres). Compare with the preview PNG in the
   `<document>.previews` folder.
4. **Text** — paragraph and character styles exist in the Styles panels, are applied, and the
   text has no unexpected overset (red + at the out port). Bold/italic runs are where expected.
5. **Colours** — swatches appear in the Swatches panel with the right values; fills and strokes use
   them.
6. **Pictures** — placed images show at the right crop/fit; the Links panel points at the files in
   the `Links` folder (relink if the document moved).
7. **Master pages** — applied masters and their items (e.g. page numbers) appear on the pages.
8. **Save as .indd** once you are happy; keep the `.idml` if you want Claude to keep editing.

Anything that differs from the preview or from what Claude reported is a bug worth reporting with
the `.idml` file attached.
