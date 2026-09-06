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
8. **Tables** — rows, columns, header rows, merged cells, cell fills and strokes look right, and
   the cell text is not overset (a red dot in the corner of a cell).
9. **Typography** — bulleted and numbered lists carry their bullets/numbers, tab stops line up
   (Type › Tabs), hyperlinks are in the Hyperlinks panel, and drop caps span the right number of
   lines. Nested and GREP styles (Paragraph Style Options › Drop Caps and Nested Styles / GREP
   Style) apply the character styles you asked for.
10. **Text variables** — Type › Text Variables lists them, and running headers/dates on master
    pages resolve on the pages (their text is recomputed by InDesign when the file opens).
11. **Anchored objects** — items anchored in text sit in the line and move with it (Object ›
    Anchored Object › Options).
12. **Sections and numbering** — the page numbers in the Pages panel use the style and prefix you
    asked for (roman numerals for front matter, for instance).
13. **Preflight** (Window › Output › Preflight) is clean, or shows only what `preflight_document`
    already reported.
14. **Package** (File › Package) — a package Claude produced should open with its `Links` folder
    intact; InDesign's own packaging of the same document should report the same fonts.
15. **Export** — a PDF Claude exported without InDesign is a proof, not a press file: text is
    outlined and colours are not managed. For print, export the PDF from InDesign itself.
16. **Save as .indd** once you are happy; keep the `.idml` if you want Claude to keep editing.

Anything that differs from the preview or from what Claude reported is a bug worth reporting with
the `.idml` file attached.
