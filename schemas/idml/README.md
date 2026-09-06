# IDML RELAX NG schemas

These schemas describe the XML parts of an InDesign Markup Language (IDML) package. InDesign
generates them itself (`app.generateIDMLSchema(folder, true)` from an InDesign script); the
version folder is the InDesign DOM version the schema was generated from:

| Folder | InDesign version | DOMVersion in files |
|--------|------------------|---------------------|
| `15.0` | InDesign 2020    | `15.0` / `15.1`     |
| `10.0` | InDesign CC 2014 | `10.0`              |
| `7.5`  | InDesign CS5.5   | `7.5`               |

The RNG files were obtained from <https://github.com/transpect/idmlvalidation> (BSD-2-Clause,
see `LICENSE-transpect.md`), which converted InDesign's RNC output to RNG with Trang.

## Adding a schema for a newer InDesign

1. In InDesign, run a script containing:
   `app.generateIDMLSchema(Folder("/idml-schema/package"), true);`
   (on Windows use `Folder("C:/idml-schema/package")`).
2. Convert each `.rnc` to `.rng` with [Trang](https://relaxng.org/jclark/trang.html):
   `java -jar trang.jar designmap.rnc designmap.rng` (repeat per file, keeping the folder layout
   `designmap.rng`, `datatype.rng`, `Spreads/Spread.rng`, `MasterSpreads/MasterSpread.rng`,
   `Stories/Story.rng`, `Resources/{Fonts,Graphic,Preferences,Styles}.rng`,
   `XML/{BackingStory,Mapping,Tags}.rng`). In the sub-folder files, point the include at
   `../datatype.rng`.
3. Copy the folder to `schemas/idml/<DOMVersion>/`.

The server picks the schema whose version is closest to (and not above) the document's
`DOMVersion`; the newest schema is embedded in the release binaries for the
`validate_document` tool's strict mode.
