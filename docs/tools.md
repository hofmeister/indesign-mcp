# Tools

82 tools. Parameters marked with * are required. Lengths accept a number in millimetres or a string with a unit ("10mm", "0.5in", "12pt").

## Everything at once

### `list`

Lists one part of a document: pages, masters, layers, items, styles, swatches, fonts, hyperlinks, text_variables, image_jobs, images, reference_documents, links, merge_fields. Start with describe_document for an overview; use this when you want one subject in full.

| Parameter | Type | Description |
|---|---|---|
| `what` * | `pages` \| `masters` \| `layers` \| `items` \| `styles` \| `swatches` \| `fonts` \| `hyperlinks` \| `text_variables` \| `image_jobs` \| `images` \| `reference_documents` \| `links` \| `merge_fields` | Which subject this is. |
| `document` | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. Only for pages, masters, layers, items, styles, swatches, fonts, hyperlinks, text_variables, images, links, merge_fields. |
| `page` | integer \| string | Only for items, images. |
| `includeMasters` | boolean | Only for items. |
| `kind` | `paragraph` \| `character` \| `object` \| `all` | Only for styles. |

### `batch`

Runs a list of edits in order, as if each tool had been called on its own. Use it whenever you know several steps up front — laying out a page, filling a table, styling a set of frames — instead of one call per edit. The document is written once at the end rather than after every step. Each step reports its own result; by default the first failure stops the batch and the document keeps the edits made before it. Unknown tools and bad arguments are caught before anything runs, so the batch either starts clean or makes no edits at all. Read-only steps (list, describe_document, preflight_document, validate_document) may be mixed in; their output is included in the report.

| Parameter | Type | Description |
|---|---|---|
| `steps` * | array | The edits to run, in order. |
| `continueOnError` | boolean | Carry on after a step fails instead of stopping (default false). |

## Documents

### `server_info`

Returns the version of the InDesign MCP server, its default unit and folders.

| Parameter | Type | Description |
|---|---|---|


### `new_document`

Creates a new InDesign document (.idml) from the built-in blank template: page size, orientation, number of pages, margins, columns and bleed. The file is saved immediately. Then use add_text_frame, place_image etc. to fill it.

| Parameter | Type | Description |
|---|---|---|
| `path` * | string | Where to save, e.g. "flyer.idml" (saved in the documents folder) or an absolute path. |
| `pageSize` | string | Preset name: A3, A4, A5, A6, B5, Letter, Legal, Tabloid, US Business Card, EU Business Card, Instagram Post, Instagram Story, Facebook Post. Default A4. Ignore when width/height are given. |
| `orientation` | `portrait` \| `landscape` |  |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `pages` | integer | Number of pages (default 1). |
| `facingPages` | boolean | Facing pages (spreads) like a brochure. Default false. |
| `margins` | number,string | Uniform page margin (default 12.7mm). |
| `columns` | integer |  |
| `gutter` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `bleed` | number,string | Bleed on all sides, e.g. "3mm". |
| `overwrite` | boolean | Overwrite an existing file. Default false. |

### `open_document`

Opens an existing .idml file and returns a summary of its pages, items, styles and swatches (same as describe_document).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

### `describe_document`

Describes a document: pages with every item (type, name, id, position and size in mm, text, images), master pages, layers, paragraph/character styles, swatches and fonts. Call this before editing so you can refer to items by name or id.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Only describe this page. |

### `validate_document`

Checks the document for problems that would stop InDesign from opening it or make it behave oddly: missing parts, duplicate ids, references to deleted styles/swatches/stories, page-count mismatches, broken text threads, and (schema: true, default) every part against Adobe's IDML schema.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `schema` | boolean | Also validate against the IDML RELAX NG schema (default true). |

### `save_document_as`

Saves a copy of the document under a new name. Later edits should refer to the new path.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `newPath` * | string |  |
| `overwrite` | boolean |  |

### `set_document_options`

Changes document-wide settings: bleed, slug, facing pages. Page size is changed with set_page_size.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `bleed` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `slug` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `facingPages` | boolean |  |

## Pages, masters and layers

### `set_page_size`

Changes the page size of the whole document. Presets: A3, A4, A5, A6, B5, Letter, Legal, Tabloid, US Business Card, EU Business Card, Instagram Post, Instagram Story, Facebook Post, or give width and height. Existing items keep their position relative to the top-left corner of their page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `pageSize` | string |  |
| `orientation` | `portrait` \| `landscape` |  |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |

### `set_margins_and_columns`

Sets page margins and column guides for all pages, or for specific pages.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `margins` | number,string \| object |  |
| `columns` | integer |  |
| `gutter` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `pages` | array | Limit to these pages (default: all pages and masters). |

### `apply_master`

Applies a master page (or "none") to the given pages, so they inherit its running heads, footers, folios and grid. Pages created by new_document already carry the first master.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `master` * | string |  |
| `pages` * | array |  |

### `add_guides`

Adds ruler guides to a page: explicit horizontal/vertical positions (from the page top-left), or guides along the margins and column edges.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `horizontal` | array | Distances from the top of the page. |
| `vertical` | array | Distances from the left edge of the page. |
| `fromMargins` | boolean | Add guides on the four margins. |
| `fromColumns` | boolean | Add guides on every column edge. |
| `color` | string | Guide color name, e.g. Cyan, Magenta, Green. |

### `override_master_item`

Makes an item that comes from the master page editable on one page (like Cmd/Ctrl+Shift-clicking it in InDesign). Use it to change a headline or logo on a single page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` * | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `item` * | string | Name or id of the item on the master page. |

### `edit_pages`

Changes which pages the document has and what order they are in: add, remove, move, duplicate, reorder. For the size, margins or master of a page use set_page_size, set_margins_and_columns or apply_master.

| Parameter | Type | Description |
|---|---|---|
| `op` * | `add` \| `remove` \| `move` \| `duplicate` \| `reorder` | Which operation this is. |
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `count` | integer | How many pages (default 1). Only for add. |
| `master` | string | Master page to apply, e.g. "A-Master", or "none". Only for add. |
| `pages` | array | Only for remove. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. Only for move, duplicate. |
| `to` | integer | New position (1 = first page). Only for move. |
| `after` | integer | Insert after this page number (0 = at the front). Only for duplicate. |
| `order` | array | Every page, in the new order. Only for reorder. |

### `edit_layers`

Creates and changes layers: create, options, delete, reorder, active. Give every document a few named layers early ("Background", "Images", "Text") and pass layer: when you add items, so the file stays editable. To move an item between layers use edit_item with op "layer".

| Parameter | Type | Description |
|---|---|---|
| `op` * | `create` \| `options` \| `delete` \| `reorder` \| `active` | Which operation this is. |
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string | Only for create, options. |
| `color` | string | Layer color name, e.g. Red, Green, LightBlue. Only for create. |
| `layer` | string | Only for options, delete, reorder, active. |
| `visible` | boolean | Only for options. |
| `locked` | boolean | Only for options. |
| `moveItemsTo` | string | Only for delete. |
| `deleteItems` | boolean | Only for delete. |
| `position` | integer | Only for reorder. |

## Frames and shapes

### `add_text_frame`

Adds a text frame with text to a page. Positions are measured from the top-left corner of the page. Paragraphs are separated by newlines; **bold** and *italic* markup is supported. Give it a name so you can edit it later.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". Use this for anything that repeats across pages — running head, footer, folio, background rule, logo — rather than adding a copy to every page. |
| `masterPage` | integer \| string | Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both. |
| `x` * | number,string | Distance from the left edge of the page. |
| `y` * | number,string | Distance from the top edge of the page. |
| `width` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `text` | string | The text. Newlines start new paragraphs. |
| `paragraphs` | array | Paragraphs with their own styles, instead of `text`. |
| `paragraphStyle` | string | Paragraph style name to apply to all paragraphs. |
| `columns` | integer |  |
| `gutter` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `inset` | number,string | Inset spacing on all sides. |
| `verticalJustification` | `top` \| `center` \| `bottom` \| `justify` |  |
| `autoSize` | `off` \| `height` \| `width` \| `both` | Auto-size the frame to its text. |
| `name` | string | A name to refer to the item later, e.g. "Headline". |
| `layer` | string | Layer to put the item on, e.g. "Text", "Images", "Background" (default: the active layer). Create layers with edit_layers op "create" and name one on every item — a document with everything on one layer is hard to edit later. |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `strokeWeight` | number | Stroke weight in points. |
| `rotation` | number | Rotation in degrees (counter-clockwise). |

### `add_shape`

Adds a rectangle, ellipse, line, polygon/star or free path. Rectangles, ellipses and polygons fill the box given by x/y/width/height; a line runs from x1/y1 to x2/y2; a path follows `points`. Filled with Black unless `fill` says otherwise (use "none" for an empty frame). To place a picture, use place_image instead.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `shape` * | `rectangle` \| `ellipse` \| `line` \| `polygon` \| `path` | Which shape to draw. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". Use this for anything that repeats across pages — running head, footer, folio, background rule, logo — rather than adding a copy to every page. |
| `masterPage` | integer \| string | Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both. |
| `x` | number,string | Box left edge. Rectangle, ellipse and polygon. |
| `y` | number,string | Box top edge. Rectangle, ellipse and polygon. |
| `width` | number,string | Box width. Rectangle, ellipse and polygon. |
| `height` | number,string | Box height. Rectangle, ellipse and polygon. |
| `x1` | number,string | Line start x. |
| `y1` | number,string | Line start y. |
| `x2` | number,string | Line end x. |
| `y2` | number,string | Line end y. |
| `points` | array | Path only: points from the top-left corner of the page. |
| `closed` | boolean | Path only: close it into a shape (default false). |
| `smooth` | boolean | Path only: curve through the points. |
| `sides` | integer | Polygon only: sides or star points (default 6). |
| `starInset` | number | Polygon only: star point depth in percent - 0 = polygon, 50 = classic star. |
| `cornerRadius` | number,string | Rectangle only: rounded corners. |
| `strokeType` | string | Line only: solid, dashed, dotted, thick-thin, thin-thick, wavy. |
| `name` | string | A name to refer to the item later, e.g. "Headline". |
| `layer` | string | Layer to put the item on, e.g. "Text", "Images", "Background" (default: the active layer). Create layers with edit_layers op "create" and name one on every item — a document with everything on one layer is hard to edit later. |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `strokeWeight` | number | Stroke weight in points. |
| `rotation` | number | Rotation in degrees (counter-clockwise). |

### `set_appearance`

Changes fill color, stroke (color, weight, type), corner radius and opacity of an item.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `fillTint` | number |  |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `strokeWeight` | number |  |
| `strokeType` | string |  |
| `strokeAlignment` | `center` \| `inside` \| `outside` |  |
| `cornerRadius` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `cornerShape` | `rounded` \| `inverse-rounded` \| `bevel` \| `inset` \| `fancy` \| `none` |  |
| `opacity` | number |  |
| `blendMode` | string | Normal, Multiply, Screen, Overlay, Darken, Lighten… |

### `set_text_frame_options`

Columns, gutter, inset spacing, vertical justification and auto-size of a text frame.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `columns` | integer |  |
| `gutter` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `inset` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `verticalJustification` | `top` \| `center` \| `bottom` \| `justify` |  |
| `autoSize` | `off` \| `height` \| `width` \| `both` |  |

### `set_text_wrap`

Makes text in other frames flow around this item (bounding box wrap) or turns wrap off.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `mode` * | `none` \| `bounding-box` \| `jump` \| `next-column` |  |
| `offset` | number,string | Distance between item and text. |

### `group_items`

Groups several items on the same page so they can be moved, copied and styled together.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `items` * | array |  |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `name` | string |  |

### `ungroup_items`

Dissolves a group; its items stay where they are.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `group` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `step_and_repeat`

Copies an item into a grid, like InDesign's Step and Repeat — useful for labels, tickets or a photo grid.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `rows` | integer |  |
| `columns` | integer |  |
| `offsetX` | number,string | Horizontal distance between copies (default: the item width plus a small gap). |
| `offsetY` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `name` | string | Base name for the copies. |

### `edit_item`

Changes an item that is already on a page: move, resize, rotate, delete, duplicate, rename, arrange, layer, align, fit. Identify the item by the name you gave it or by the id from list items. To create items use add_text_frame, add_shape or place_image.

| Parameter | Type | Description |
|---|---|---|
| `op` * | `move` \| `resize` \| `rotate` \| `delete` \| `duplicate` \| `rename` \| `arrange` \| `layer` \| `align` \| `fit` | Which operation this is. |
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` | string | The item's name or id (see describe_document / list items). Only for move, resize, rotate, delete, duplicate, rename, arrange, layer, fit. |
| `page` | integer \| string | Disambiguates items with the same name. |
| `x` | number,string | Only for move. |
| `y` | number,string | Only for move. |
| `dx` | number,string | Only for move, duplicate. |
| `dy` | number,string | Only for move, duplicate. |
| `toPage` | integer \| string | Move the item to another page (keeps x/y unless given). Only for move, duplicate. |
| `width` | number,string | Only for resize. |
| `height` | number,string | Only for resize. |
| `degrees` | number | Only for rotate. |
| `name` | string | Only for duplicate, rename. |
| `action` | `front` \| `back` \| `forward` \| `backward` | Only for arrange. |
| `layer` | string | Only for layer. |
| `items` | array | Only for align. |
| `to` | `page` \| `margins` | Only for align. |
| `horizontal` | `left` \| `center` \| `right` | Only for align. |
| `vertical` | `top` \| `middle` \| `bottom` | Only for align. |
| `distribute` | `horizontal` \| `vertical` | Distribute the items evenly between the outermost ones. Only for align. |
| `mode` | `height` \| `both` | Only for fit. |

## Text

### `get_text`

Returns the text of a text frame (or of every text frame in the document), paragraph by paragraph with style names.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `set_text`

Replaces all text in a text frame. Use `text` (newlines = paragraphs) or `paragraphs` for per-paragraph styles.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `text` | string |  |
| `paragraphs` | array |  |
| `paragraphStyle` | string | Default paragraph style for all paragraphs. |
| `markup` | boolean | Interpret **bold**/*italic* (default true). |

### `append_text`

Adds paragraphs at the end of a text frame's text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `text` | string |  |
| `paragraphs` | array |  |
| `paragraphStyle` | string |  |

### `find_and_replace`

Finds and replaces text across the whole document or inside one text frame. Supports regular expressions.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `find` * | string |  |
| `replace` | string | Omit to only count matches. |
| `item` | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `regex` | boolean |  |
| `caseSensitive` | boolean |  |
| `wholeWord` | boolean |  |

### `apply_paragraph_style`

Applies a paragraph style to all paragraphs of a text frame, to specific paragraph numbers, or to paragraphs containing some text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `style` * | string |  |
| `paragraphs` | array | 1-based paragraph numbers. |
| `containing` | string |  |

### `format_text`

Formats every occurrence of some text inside a frame (or the whole document): apply a character style, or local formatting such as bold, italic, size, font, color, tracking.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `find` * | string | The text to format (exact, case-insensitive by default). |
| `item` | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `regex` | boolean |  |
| `caseSensitive` | boolean |  |
| `characterStyle` | string |  |
| `bold` | boolean |  |
| `italic` | boolean |  |
| `fontStyle` | string | Exact font style name, e.g. "Semibold Italic" (overrides bold/italic). |
| `font` | string |  |
| `size` | number |  |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `tracking` | number |  |
| `underline` | boolean |  |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` |  |

### `insert_page_number`

Adds an automatic page-number marker to a text frame, so each page shows its own number — at the end of the text, or in place of text you name with replaceText. It belongs in a small frame on a master page — add that frame with add_text_frame using master, not one per page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `prefix` | string |  |
| `suffix` | string |  |
| `replaceText` | string | Text to replace with the marker. Without it the marker is added at the end. |
| `paragraphStyle` | string | Paragraph style for the marker. Only needed for an empty frame: in a frame that already has text the marker matches the text it is added to. |

### `thread_text_frames`

Links two text frames so text overflowing the first continues in the second. The second frame's own text is discarded.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `from` * | string | The item's name or id (see describe_document / list items). |
| `to` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

## Styles, swatches and fonts

### `create_paragraph_style`

Creates one paragraph style (font, size, leading, alignment, spacing, color…) or a whole set in one call — pass "styles" with the list. Define the document's styles in a single call rather than one call each. Apply them with add_text_frame, set_text or apply_paragraph_style.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string |  |
| `basedOn` | string |  |
| `nextStyle` | string |  |
| `group` | string | Style group (folder) name. |
| `font` | string | Font family, e.g. "Helvetica Neue". Must be installed on the designer's computer. |
| `fontStyle` | string | Font style name: Regular, Bold, Italic, Light, Semibold… |
| `size` | number | Point size (0.1–1296, as in InDesign). |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `tracking` | number | Letter spacing in 1/1000 em (-1000 to 10000). |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number | Percent (1–1000). |
| `baselineShift` | number | Points. |
| `alignment` | `left` \| `center` \| `right` \| `justify` \| `justify-all` \| `justify-center` \| `justify-right` \| `to-binding` \| `away-from-binding` |  |
| `spaceBefore` | number | Points. |
| `spaceAfter` | number |  |
| `leftIndent` | number |  |
| `rightIndent` | number |  |
| `firstLineIndent` | number |  |
| `hyphenate` | boolean |  |
| `keepLinesTogether` | boolean |  |
| `dropCapLines` | integer |  |
| `dropCapCharacters` | integer |  |
| `styles` | array | Several styles at once, e.g. [{name:"Headline",font:"Helvetica",size:28,...},{name:"Body",size:10,...}]. Use this instead of the single-style fields. |

### `create_character_style`

Creates one character style for inline formatting (e.g. "Emphasis": italic; "Price": bold red) or several at once — pass "styles" with the list. Apply them with format_text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string |  |
| `basedOn` | string |  |
| `group` | string |  |
| `font` | string | Font family, e.g. "Helvetica Neue". Must be installed on the designer's computer. |
| `fontStyle` | string | Font style name: Regular, Bold, Italic, Light, Semibold… |
| `size` | number | Point size (0.1–1296, as in InDesign). |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `tracking` | number | Letter spacing in 1/1000 em (-1000 to 10000). |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number | Percent (1–1000). |
| `baselineShift` | number | Points. |
| `styles` | array | Several styles at once. Use this instead of the single-style fields. |

### `update_style`

Changes settings of an existing paragraph or character style. Everything using the style updates automatically in InDesign.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `kind` * | `paragraph` \| `character` |  |
| `style` * | string |  |
| `basedOn` | string |  |
| `nextStyle` | string |  |
| `font` | string | Font family, e.g. "Helvetica Neue". Must be installed on the designer's computer. |
| `fontStyle` | string | Font style name: Regular, Bold, Italic, Light, Semibold… |
| `size` | number | Point size (0.1–1296, as in InDesign). |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `tracking` | number | Letter spacing in 1/1000 em (-1000 to 10000). |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number | Percent (1–1000). |
| `baselineShift` | number | Points. |
| `alignment` | `left` \| `center` \| `right` \| `justify` \| `justify-all` \| `justify-center` \| `justify-right` \| `to-binding` \| `away-from-binding` |  |
| `spaceBefore` | number | Points. |
| `spaceAfter` | number |  |
| `leftIndent` | number |  |
| `rightIndent` | number |  |
| `firstLineIndent` | number |  |
| `hyphenate` | boolean |  |
| `keepLinesTogether` | boolean |  |
| `dropCapLines` | integer |  |
| `dropCapCharacters` | integer |  |

### `delete_style`

Deletes a paragraph or character style; text using it gets the replacement style (default: basic/none).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `kind` * | `paragraph` \| `character` |  |
| `style` * | string |  |
| `replaceWith` | string |  |

### `create_swatch`

Creates one named colour swatch from CMYK, RGB or hex values, or a whole palette in one call — pass "swatches" with the list (CMYK recommended for print). Define the document's palette in a single call rather than one call each.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string | Swatch name (default: InDesign-style "C=0 M=100 Y=0 K=0"). |
| `color` | string | "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". |
| `cmyk` | array | Percentages 0-100. |
| `rgb` | array | Values 0-255. |
| `spot` | boolean |  |
| `swatches` | array | A whole palette at once, e.g. [{name:"Brand Blue",color:"cmyk(90,60,0,0)"},{name:"Sand",color:"#e8dcc8"}]. Use this instead of the single-swatch fields. |

### `create_object_style`

Creates one object style — fill, stroke, corners, opacity, text frame options and a paragraph style in one reusable set — or several at once by passing "styles" with the list. Apply them with apply_object_style.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string |  |
| `basedOn` | string |  |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `fillTint` | number |  |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `strokeWeight` | number |  |
| `strokeType` | string | Solid, Dashed, Dotted… |
| `strokeAlignment` | `center` \| `inside` \| `outside` |  |
| `cornerRadius` | number | Points. |
| `cornerShape` | `rounded` \| `inverse-rounded` \| `bevel` \| `inset` \| `fancy` \| `none` |  |
| `opacity` | number |  |
| `paragraphStyle` | string | Paragraph style applied to text in frames using this style. |
| `columns` | integer |  |
| `gutter` | number |  |
| `inset` | number |  |
| `verticalJustification` | `top` \| `center` \| `bottom` \| `justify` |  |
| `textWrap` | `none` \| `bounding-box` |  |
| `textWrapOffset` | number |  |
| `styles` | array | Several object styles at once. Use this instead of the single-style fields. |

### `update_object_style`

Changes an existing object style. Items using it follow automatically in InDesign.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string |  |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `strokeWeight` | number |  |
| `cornerRadius` | number |  |
| `cornerShape` | `rounded` \| `inverse-rounded` \| `bevel` \| `inset` \| `fancy` \| `none` |  |
| `opacity` | number |  |
| `paragraphStyle` | string |  |
| `columns` | integer |  |
| `inset` | number |  |
| `verticalJustification` | `top` \| `center` \| `bottom` \| `justify` |  |
| `textWrap` | `none` \| `bounding-box` |  |

### `create_gradient`

Creates a linear or radial gradient swatch from two or more colours. Use it as a fill like any swatch.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string |  |
| `type` | `linear` \| `radial` |  |
| `stops` * | array | Colours from start to end; locations default to an even spread. |

### `apply_object_style`

Applies an object style to an item (fill, stroke, corners, text frame options and paragraph style in one go).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `style` * | string |  |

## Pictures

### `place_image`

Places an existing image file (PNG, JPEG, TIFF, PSD, PDF…) on a page: either in a new frame at x/y with width (height optional, keeps proportions) or into an existing frame. The file stays linked, like File > Place in InDesign; keep it next to the document (a Links folder is ideal).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `image` * | string | Path to the image file. |
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
| `masterPage` | integer \| string | Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `frame` | string | Put the image into this existing frame instead of creating a new one. |
| `name` | string |  |
| `layer` | string |  |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size). |

### `set_image_fit`

Changes how a placed picture fits its frame (fill, fit, stretch, center, frame-to-content).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `fit` * | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` |  |

### `generate_image`

Generates a picture with OpenAI from a text prompt, saves it in the document's Links folder and optionally places it: give x/y/width for a new frame or frame for an existing one. Without placement it only saves the file. Generation runs in the background: when the picture is not ready within waitSeconds you get a job id and collect it with wait_for_image — nothing is lost and nothing is generated twice. Costs money per image, so confirm the prompt with the user before generating many.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `prompt` * | string |  |
| `size` | string | "square", "landscape", "portrait", an aspect like "16:9" or "3:4", or exact pixels "1536x1024". Default: matches the frame, else square. |
| `quality` | `low` \| `medium` \| `high` \| `auto` | Higher quality costs more and takes longer. Default auto. |
| `transparentBackground` | boolean | Produce a PNG with transparent background (logos, cut-outs). |
| `model` | string | OpenAI image model (default gpt-image-2). Others: gpt-image-1.5, gpt-image-1-mini. |
| `fileName` | string | File name for the saved image (without extension). Default: derived from the prompt. |
| `returnPreview` | boolean | Include a small preview of the image in the reply (default true). |
| `waitSeconds` | number | How long to wait for the picture before returning a job id instead, in seconds (default 45, 0 returns the job id at once). Keep it under your own tool timeout: nothing is lost when the wait runs out, wait_for_image picks the job up again. |
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
| `masterPage` | integer \| string | Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `frame` | string | Put the image into this existing frame instead of creating a new one. |
| `name` | string |  |
| `layer` | string |  |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size). |

### `edit_image`

Edits or combines existing pictures with OpenAI: describe the change in the prompt, pass one or more source images (file paths or frame names whose picture should be used) and optionally a mask PNG whose transparent areas mark what to change. Saves the result to the Links folder and optionally places it (frame / x,y,width). Runs in the background like generate_image: collect a slow edit with wait_for_image.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `prompt` * | string |  |
| `images` * | array | Source image paths, or names/ids of frames containing pictures. |
| `mask` | string | Path to a PNG mask (transparent = area to edit). |
| `size` | string | "square", "landscape", "portrait", an aspect like "16:9" or "3:4", or exact pixels "1536x1024". |
| `quality` | `low` \| `medium` \| `high` \| `auto` | Higher quality costs more and takes longer. Default auto. |
| `transparentBackground` | boolean | Produce a PNG with transparent background (logos, cut-outs). |
| `model` | string | OpenAI image model (default gpt-image-2). Others: gpt-image-1.5, gpt-image-1-mini. |
| `fileName` | string | File name for the saved image (without extension). Default: derived from the prompt. |
| `returnPreview` | boolean | Include a small preview of the image in the reply (default true). |
| `waitSeconds` | number | How long to wait for the picture before returning a job id instead, in seconds (default 45, 0 returns the job id at once). Keep it under your own tool timeout: nothing is lost when the wait runs out, wait_for_image picks the job up again. |
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
| `masterPage` | integer \| string | Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `frame` | string | Put the image into this existing frame instead of creating a new one. |
| `name` | string |  |
| `layer` | string |  |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size). |
| `replaceInFrame` | boolean | When a source is a frame, put the result back into that frame (default true). |

### `wait_for_image`

Collects a picture from generate_image or edit_image that was not ready in time. Waits for the job and returns the finished image, or reports that it is still running — in which case call this again with the same id, as many times as it takes. Generation is not interrupted or restarted by waiting or by giving up on a wait.

| Parameter | Type | Description |
|---|---|---|
| `id` | string | The job id returned by generate_image / edit_image. Default: the job still running. |
| `waitSeconds` | number | How long to wait this time, in seconds (default 45). If it comes back still running, just call again. |
| `returnPreview` | boolean | Include a preview of the image (default true). |

### `relink_image`

Points a placed picture at a different file, keeping the frame, its position and its fitting. Also fixes a missing link.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `image` * | string | Which picture: the frame name or id, or the current file name (see list links). |
| `newFile` * | string | Path of the image file to link to. |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture sits in its frame; fill (default) crops to fill it. |

### `embed_images`

Copies picture files into the document so it can be sent on its own. The file grows; use unembed_images or package_document if you would rather keep the pictures as separate files.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `image` | string | One picture (frame name, id or file name). Omit for all. |

### `unembed_images`

Writes embedded pictures into a Links folder next to the document and links to them again.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `image` | string | One picture. Omit for all embedded pictures. |
| `folder` | string | Where to write them (default: a Links folder next to the document). |

## Reference documents

### `describe_reference`

Full description of a reference document: pages and items, master pages, styles (with fonts and sizes), swatches and fonts.

| Parameter | Type | Description |
|---|---|---|
| `reference` * | string | Reference name (from list reference_documents) or a path to an .idml file. |

### `add_reference_folder`

Registers a folder of .idml files as references for this session.

| Parameter | Type | Description |
|---|---|---|
| `folder` * | string |  |

### `new_document_from_reference`

Starts a new document from a reference: either a full copy (keepContent true) or its styles, swatches, masters and page setup with empty pages (default).

| Parameter | Type | Description |
|---|---|---|
| `reference` * | string |  |
| `path` * | string | Where to save the new document. |
| `keepContent` | boolean | Keep the reference's pages and content (default false = empty pages, same setup). |
| `pages` | integer | Number of pages when not keeping content (default 1). |
| `pageSize` | string |  |
| `orientation` | `portrait` \| `landscape` |  |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `overwrite` | boolean |  |

### `import_styles_from_reference`

Copies paragraph/character/object styles, swatches and fonts from a reference document into the current document. By default everything; limit with the flags or `only` names.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `reference` * | string |  |
| `paragraph` | boolean |  |
| `character` | boolean |  |
| `object` | boolean |  |
| `swatches` | boolean |  |
| `fonts` | boolean |  |
| `only` | array | Only these style/swatch names. |
| `conflict` | `skip` \| `overwrite` \| `rename` | What to do when a style with the same name exists (default skip). |

### `copy_master_from_reference`

Copies a master page (with its items, styles and swatches) from a reference document into the current document.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `reference` * | string |  |
| `master` * | string | Master name in the reference, e.g. "A-Master". |
| `prefix` | string |  |
| `name` | string |  |

### `copy_page_from_reference`

Copies everything on a reference page onto a new page at the end of the current document (or onto an existing page), including the styles, swatches and master it needs. Linked images stay linked to their original files.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `reference` * | string |  |
| `page` * | integer \| string | Page in the reference. |
| `ontoPage` | integer \| string | Existing page to copy onto (default: a new page). |
| `applyMaster` | boolean |  |

## Previews

### `preview_capabilities`

Reports whether Adobe InDesign is available for exact previews and which fonts the built-in renderer can use.

| Parameter | Type | Description |
|---|---|---|


### `preview`

Renders part of the document to a PNG and shows it, so you can check the layout: page, spread, document, item ("document" is a contact sheet of every page). Uses Adobe InDesign itself when installed (exact), otherwise a built-in renderer with real fonts. Also saves the PNG next to the document.

| Parameter | Type | Description |
|---|---|---|
| `what` * | `page` \| `spread` \| `document` \| `item` | Which subject this is. |
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Only for page, spread, item. |
| `width` | integer | Width in pixels of the PNG saved next to the document (default 1200). The picture shown in the reply is capped at about 1400 px whatever this says, so raise it for a file to look at, not for a closer look here — use preview item for that. |
| `renderer` | `auto` \| `builtin` \| `indesign` | auto (default): use Adobe InDesign for a pixel-exact render if it is installed, otherwise the built-in renderer; builtin: always the built-in renderer; indesign: require InDesign. Only for page, spread. |
| `showGuides` | boolean | Draw margin and column guides. Only for page, spread, document. |
| `showFrameEdges` | boolean | Outline text and picture frames. Only for page, spread, item. |
| `bleed` | boolean | Include the bleed area. Only for page, spread. |
| `save` | boolean | Also write the PNG next to the document, in a .previews folder (default true). Only for page, spread. |
| `columns` | integer | Only for document. |
| `item` | string | The item's name or id (see describe_document / list items). Only for item. |

## Other

### `set_gradient_geometry`

Sets the angle and length of a gradient fill on an item (0° = left to right, 90° = bottom to top).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `angle` | number |  |
| `length` | number |  |

### `add_table`

Puts a table in a text frame (creating the frame when x/y/width/height are given). Fill it with `data` row by row; the first rows can be header rows that repeat when the table flows.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` | string | Existing text frame to put the table in. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `name` | string | Name for the new frame. |
| `rows` | integer | Number of rows (default: the number of data rows). |
| `columns` | integer |  |
| `data` | array | Cell text, row by row. **bold** and *italic* work. |
| `headerRows` | integer |  |
| `footerRows` | integer |  |
| `columnWidths` | array | Column widths; one value applies to all. |
| `rowHeights` | array |  |
| `paragraphStyle` | string |  |
| `headerParagraphStyle` | string |  |
| `cellInset` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `strokeWeight` | number | Weight of the lines between cells, in points. |
| `strokeColor` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `borderWeight` | number |  |
| `borderColor` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `headerFill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `alternatingFill` | string | Fill for every other body row (banding). |

### `get_table`

Returns the contents of a table as rows of text, with its size and header rows.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `set_table_cells`

Writes text into table cells: one cell, or a block of cells starting at a position.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `row` * | integer | Row number, 1 = first row (header rows count). |
| `column` * | integer |  |
| `text` | string | Text for a single cell. |
| `data` | array | A block of cells starting at row/column. |
| `paragraphStyle` | string |  |

### `style_table`

Colours cells, changes their strokes, insets, vertical alignment or paragraph style — the whole table, whole rows/columns, or a block.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `rows` | array | Row numbers to style (1 = first). |
| `columns` | array |  |
| `fromRow` | integer |  |
| `fromColumn` | integer |  |
| `rowSpan` | integer |  |
| `columnSpan` | integer |  |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `fillTint` | number |  |
| `strokeWeight` | number |  |
| `strokeColor` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep". |
| `inset` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `verticalAlignment` | `top` \| `center` \| `bottom` |  |
| `paragraphStyle` | string |  |

### `edit_table_structure`

Inserts or deletes rows and columns, sets column widths and row heights, or merges a block of cells.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `action` * | `insert-rows` \| `delete-rows` \| `insert-columns` \| `delete-columns` \| `merge` \| `column-widths` \| `row-heights` |  |
| `at` | integer | Row/column number to insert before or delete (1 = first). |
| `count` | integer | How many rows/columns (default 1). |
| `rowSpan` | integer | For merge: how many rows to join. |
| `columnSpan` | integer |  |
| `widths` | array |  |
| `heights` | array |  |

### `merge_table_cells`

Joins a rectangular block of cells into one, keeping the top-left cell's text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `frame` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `row` * | integer |  |
| `column` * | integer |  |
| `rowSpan` | integer |  |
| `columnSpan` | integer |  |

### `set_list_options`

Turns a paragraph style into a bulleted or numbered list (or switches the list off). Apply the style to paragraphs as usual; InDesign then draws the bullets or numbers.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string | Paragraph style to change. |
| `kind` * | `none` \| `bullet` \| `number` |  |
| `bulletCharacter` | string | Default •. Try –, ▪, ●, ✓. |
| `numberStyle` | `arabic` \| `upper-roman` \| `lower-roman` \| `upper-letters` \| `lower-letters` |  |
| `numberFormat` | string | Pattern, e.g. "^#." for 1. or "^#)" for 1). ^# is the number, ^t a tab. textAfter is appended to it. |
| `startAt` | integer |  |
| `textAfter` | string | What follows the bullet/number, default a tab (^t). |
| `indent` | number,string | Left indent of the paragraph. |
| `bulletIndent` | number,string | How far the bullet/number hangs into the margin. |
| `characterStyle` | string | Character style for the bullet/number itself. |
| `font` | string | Font for the bullet character. |
| `fontStyle` | string | Style of that font, e.g. "Bold" (default Regular). |

### `set_tab_stops`

Sets the tab stops of a paragraph style — useful for price lists and tables of contents (a right tab with a dotted leader).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string |  |
| `stops` * | array | An empty list removes all tab stops. |

### `add_hyperlink`

Turns text into a hyperlink to a web address. The link survives PDF and EPUB export from InDesign.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | Text frame containing the text. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `text` * | string | The exact text to link. |
| `url` * | string | Target address, e.g. https://example.com |
| `all` | boolean | Link every occurrence (default: only the first). |
| `characterStyle` | string | Character style for the link text, e.g. a blue underlined style. |
| `name` | string |  |

### `set_page_numbering`

Controls how pages are numbered: where a section starts, the first number, the style (1, i, I, a, A) and a section prefix. Combine with insert_page_number on a master page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `startPage` | integer | Page where this section starts (default 1). |
| `pageNumberStart` | integer | Number the first page of the section gets. |
| `continueNumbering` | boolean | Continue from the previous section instead. |
| `style` | `arabic` \| `upper-roman` \| `lower-roman` \| `upper-letters` \| `lower-letters` |  |
| `prefix` | string | Section prefix, e.g. "A-". |
| `includePrefix` | boolean | Show the prefix in page numbers. |
| `marker` | string | Section marker text (insert it with a text variable). |

### `anchor_item_in_text`

Moves an item into a story so it flows with the text (an anchored object in InDesign): an icon in a sentence, or a picture that stays with its paragraph.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item to anchor. |
| `intoFrame` * | string | The text frame whose story it should flow with. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `afterText` | string | Put it at this text; otherwise at the end of the story. |
| `position` | `inline` \| `above-line` \| `custom` |  |
| `yOffset` | number,string | Vertical offset from the baseline. |
| `xOffset` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `alignment` | `left` \| `center` \| `right` |  |

### `insert_special_characters`

Replaces placeholders in a text frame with typographic characters. Available: em-dash, en-dash, bullet, ellipsis, copyright, registered, trademark, section, paragraph, degree, euro, pound, yen, non-breaking-space, thin-space, hair-space, en-space, em-space, forced-line-break, discretionary-hyphen, non-breaking-hyphen, zero-width-space, right-quote, left-quote, right-double-quote, left-double-quote. Write them as <em-dash>, <bullet>, <non-breaking-space> in your text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `create_text_variable`

Makes a text variable: a running header that repeats the current heading, the date, the file name, the chapter number, the last page number, or a piece of custom text you can change in one place. Put it into a frame with insert_text_variable, usually on a master page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string | What to call it, e.g. "Running head". |
| `kind` * | `custom-text` \| `file-name` \| `last-page-number` \| `chapter-number` \| `creation-date` \| `modification-date` \| `output-date` \| `running-header-paragraph` \| `running-header-character` |  |
| `text` | string | The text, for a custom-text variable. |
| `format` | string | Date pattern for the date variables, e.g. "d MMMM yyyy" or "dd/MM/yyyy". |
| `style` | string | The style a running header follows, e.g. the "Heading 1" paragraph style. |
| `use` | `first` \| `last` | Which match on the page a running header takes (default the first). |
| `textBefore` | string |  |
| `textAfter` | string |  |

### `insert_text_variable`

Puts a text variable into a text frame — in place of some text you name, or at the end of the story. On a master page this gives every page a running header or a date that updates itself.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The text frame. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `variable` * | string | Name of the variable (see list text_variables). |
| `replaceText` | string | Text to replace with the variable. |
| `characterStyle` | string |  |

### `delete_text_variable`

Removes a text variable from the document.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string |  |

### `set_nested_styles`

Styles the start of every paragraph automatically: "the first two words in Bold", "everything up to the first colon in Small caps". InDesign calls these nested styles; they follow the paragraph style, so the text stays editable.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string | The paragraph style to change. |
| `nested` * | array | In order, from the start of the paragraph. An empty list removes them. |

### `set_line_styles`

Styles whole lines of every paragraph in a style — "the first line in small caps", for instance.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string |  |
| `lines` * | array |  |

### `set_grep_styles`

Styles every match of a pattern inside the paragraphs of a style — phone numbers in bold, acronyms in small caps, prices in a different colour. Uses InDesign's GREP (regular expression) syntax.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `style` * | string |  |
| `grep` * | array | An empty list removes the GREP styles. |

### `preflight_document`

Checks the document the way InDesign’s Preflight panel does: overset text, missing or low-resolution pictures, missing fonts, RGB colours in print work, hairlines, objects running off the page without bleed and empty frames.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `intent` | `print` \| `screen` | print (default) checks CMYK and resolution; screen is more relaxed. |
| `minPpi` | integer | Minimum picture resolution (default 250 for print). |

### `package_document`

Collects the document, copies of every linked picture and a font/preflight report into one folder, ready to hand over — InDesign’s File > Package.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `folder` * | string | Folder to create the package in. |
| `copyFonts` | boolean | Also copy the font files used (check your font licence first). Default false. |

### `data_merge`

Fills a template page once per row of a CSV or JSON file, adding a page for every row — for name badges, certificates, price lists or personalised letters. Write <<Field>> in the text; name a picture frame <<Field>> to place a picture whose path is in that column.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `dataFile` * | string | Path to a .csv, .tsv or .json file. The first CSV row holds the column names. |
| `templatePage` | integer \| string | Page holding the placeholders (default 1). |
| `separateDocuments` | boolean | Write one document per row instead of adding pages (default false). |
| `outputFolder` | string | Where to write the separate documents. |
| `nameFrom` | string | Column to name the separate documents after. |
| `limit` | integer | Only merge the first N rows (useful for a test run). |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture sits in its frame; fill (default) crops to fill it. |

### `export_document`

Exports the document for sending or printing. With Adobe InDesign installed the export is done by InDesign itself (press-ready PDF); otherwise the built-in renderer writes a vector PDF or images that are very close but not colour-managed.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `format` * | `pdf` \| `png` \| `jpeg` | pdf for sending or printing, png/jpeg for the web. |
| `outputFile` | string | Where to write it (default: next to the document). Several pages become file-1, file-2, … |
| `pages` | array | Pages to export, e.g. [1,2] or ["1-4"]. All pages by default. |
| `spreads` | boolean | Export facing pages together as spreads. |
| `dpi` | integer | Resolution for PNG/JPEG (default 150). |
| `quality` | integer | JPEG quality (default 90). |
| `bleed` | boolean | Include the bleed area. |
| `marks` | boolean | Printer's marks on a PDF: crop and bleed marks, registration, colour bars and page info. Needs Adobe InDesign; the built-in renderer cannot draw them. |
| `renderer` | `auto` \| `builtin` \| `indesign` |  |

### `edit_masters`

Creates and changes master pages (parent pages): create, delete, rename, pages, parent. Put repeating furniture — running head, folio, background, grid — on a master and apply it to pages with apply_master, rather than copying it onto every page. Items go on a master with add_text_frame / add_shape using master and masterPage.

| Parameter | Type | Description |
|---|---|---|
| `op` * | `create` \| `delete` \| `rename` \| `pages` \| `parent` | Which operation this is. |
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `prefix` | string | One-letter prefix, e.g. "B". Only for create, rename. |
| `name` | string | Name, e.g. "Chapter". Only for create, rename. |
| `copyFrom` | string | Master to copy (default: the first one). Only for create. |
| `keepItems` | boolean | Copy the items of that master (default true). Only for create. |
| `pages` | integer | Pages in the spread: 1 single-sided, 2 facing, more for a gatefold. Only for create. |
| `basedOn` | string | Another master this one is based on, so its items show through and follow changes. Only for create. |
| `master` | string | Master page, e.g. "A-Master" or its id. Only for delete, rename, pages, parent. |
| `replaceWith` | string | Master for the pages that used it (default: none). Only for delete. |
| `count` | integer | Only for pages. |
| `parent` | string | The master it is based on, or "none". Only for parent. |

# Prompts

Prompts appear as slash commands in Claude Desktop.

- **design-from-brief** — Create a flyer, poster, brochure or other InDesign document from a short brief. Arguments: `brief`*, `format`, `file`.
- **match-reference-look** — Build a new document that follows the styles, colors and masters of a reference document. Arguments: `reference`*, `content`*, `file`.
- **review-layout** — Inspect a document page by page and suggest improvements. Arguments: `document`*.
