# Bundled preview fonts

These fonts are embedded into the server binary and used by the built-in page renderer when a
font used in the document is not installed on this computer:

| Family  | Stands in for                     | License   | Source                                  |
|---------|-----------------------------------|-----------|-----------------------------------------|
| Arimo   | Arial / Helvetica (sans-serif)    | OFL 1.1   | Fontsource `@fontsource/arimo` 5.3.0    |
| Tinos   | Times New Roman (serif)           | OFL 1.1   | Fontsource `@fontsource/tinos` 5.3.0    |
| Cousine | Courier New (monospace)           | OFL 1.1   | Fontsource `@fontsource/cousine` 5.3.0  |

They are metric-compatible with the fonts they stand in for, so line breaks stay close even when
the exact typeface is missing. The renderer also scans the fonts installed on the computer
(including Adobe Fonts activations) and prefers those. Run `bun run gen` after changing this folder.
