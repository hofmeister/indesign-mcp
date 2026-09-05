# IDML test fixtures

Real InDesign exports taken from the SimpleIDML project's regression tests
(<https://github.com/Starou/SimpleIDML>, BSD license, see `LICENSE-SimpleIDML`).

| File | InDesign DOMVersion | What it exercises |
|------|---------------------|-------------------|
| `interview.idml` | 15.1 (InDesign 2020) | modern export, facing pages, many text frames, bleed |
| `4-pages.idml` | 7.5 | 4 pages over 3 spreads, master spread |
| `4-pages-layers-with-guides.idml` | 7.5 | multiple layers and ruler guides |
| `2articles-1photo.idml` | 10.0 | text + a placed image (links to `media/`) |
| `magazineA-template.idml` | 7.5 | a template with styles and masters |
| `page-9modules.idml` | 10.0 | many small frames on one page |

Drop your own InDesign exports next to these; every `.idml` in this folder is
automatically covered by the "load, describe, validate, re-save" test.
