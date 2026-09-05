# Tools

70 tools. Parameters marked with * are required. Lengths accept a number in millimetres or a string with a unit ("10mm", "0.5in", "12pt").

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

### `list_pages`

Lists the pages with size, side (left/right), margins, columns and applied master page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

### `add_pages`

Adds pages at the end of the document (new pages get the same master as the last page unless specified).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `count` | integer | How many pages (default 1). |
| `master` | string | Master page to apply, e.g. "A-Master", or "none". |

### `remove_pages`

Deletes pages and everything on them.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `pages` * | array |  |

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

### `list_masters`

Lists master pages (parent pages) with the number of items on each.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

### `apply_master`

Applies a master page (or "none") to the given pages.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `master` * | string |  |
| `pages` * | array |  |

### `create_master`

Creates a new master page (parent page) by duplicating an existing one, e.g. "B-Chapter" based on "A-Master". Add items to it with add_text_frame etc. using target master.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `prefix` * | string | One-letter prefix, e.g. "B". |
| `name` * | string | Name, e.g. "Chapter". |
| `basedOn` | string | Existing master to duplicate (default: the first one). Its items are copied. |
| `keepItems` | boolean | Copy the items of the source master (default true). |

### `list_layers`

Lists layers (top-most first).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

### `create_layer`

Creates a new layer on top of the others.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string |  |
| `color` | string | Layer color name, e.g. Red, Green, LightBlue. |

### `set_layer_options`

Renames, hides/shows or locks/unlocks a layer.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `layer` * | string |  |
| `name` | string |  |
| `visible` | boolean |  |
| `locked` | boolean |  |

### `set_item_layer`

Moves an item to another layer.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `layer` * | string |  |

## Frames and shapes

### `list_items`

Lists the items (frames, shapes, images, text) on a page or in the whole document with names, ids, positions and sizes.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `includeMasters` | boolean |  |

### `add_text_frame`

Adds a text frame with text to a page. Positions are measured from the top-left corner of the page. Paragraphs are separated by newlines; **bold** and *italic* markup is supported. Give it a name so you can edit it later.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". |
| `x` * | number,string | Distance from the left edge of the page. |
| `y` * | number,string | Distance from the top edge of the page. |
| `width` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `text` | string | The text. Newlines start new paragraphs. |
| `paragraphStyle` | string | Paragraph style name to apply to all paragraphs. |
| `columns` | integer |  |
| `gutter` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `inset` | number,string | Inset spacing on all sides. |
| `verticalJustification` | `top` \| `center` \| `bottom` \| `justify` |  |
| `autoSize` | `off` \| `height` \| `width` \| `both` | Auto-size the frame to its text. |
| `name` | string | A name to refer to the item later, e.g. "Headline". |
| `layer` | string | Layer name (default: the active layer). |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `strokeWeight` | number | Stroke weight in points. |
| `rotation` | number | Rotation in degrees (counter-clockwise). |

### `add_rectangle`

Adds a rectangle (filled with Black unless fill is given; use fill "none" for an empty frame). To place a picture, use place_image instead.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". |
| `x` * | number,string | Distance from the left edge of the page. |
| `y` * | number,string | Distance from the top edge of the page. |
| `width` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `name` | string | A name to refer to the item later, e.g. "Headline". |
| `layer` | string | Layer name (default: the active layer). |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `strokeWeight` | number | Stroke weight in points. |
| `rotation` | number | Rotation in degrees (counter-clockwise). |
| `cornerRadius` | number,string | Rounded corners (rectangles only). |

### `add_ellipse`

Adds an ellipse/circle inside the given box.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". |
| `x` * | number,string | Distance from the left edge of the page. |
| `y` * | number,string | Distance from the top edge of the page. |
| `width` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `name` | string | A name to refer to the item later, e.g. "Headline". |
| `layer` | string | Layer name (default: the active layer). |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `strokeWeight` | number | Stroke weight in points. |
| `rotation` | number | Rotation in degrees (counter-clockwise). |
| `cornerRadius` | number,string | Rounded corners (rectangles only). |

### `add_line`

Adds a straight line (rule) between two points on a page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page to place the item on (default 1). Ignored when master is given. |
| `master` | string | Put the item on this master page instead of a document page, e.g. "A-Master". |
| `x1` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y1` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `x2` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y2` * | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `name` | string |  |
| `layer` | string |  |
| `stroke` | string | Default Black. |
| `strokeWeight` | number | Default 1pt. |
| `strokeType` | string | solid, dashed, dotted, thick-thin, thin-thick, wavy |

### `move_item`

Moves an item to a position (from the top-left of its page) or by an offset (dx/dy).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Disambiguates items with the same name. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `dx` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `dy` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `toPage` | integer \| string | Move the item to another page (keeps x/y unless given). |

### `resize_item`

Changes the width and/or height of an item, keeping its top-left corner in place.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |

### `rotate_item`

Sets the rotation of an item in degrees (counter-clockwise, around its center).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `degrees` * | number |  |

### `set_appearance`

Changes fill color, stroke (color, weight, type), corner radius and opacity of an item.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `fill` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `fillTint` | number |  |
| `stroke` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `strokeWeight` | number |  |
| `strokeType` | string |  |
| `strokeAlignment` | `center` \| `inside` \| `outside` |  |
| `cornerRadius` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `cornerShape` | `rounded` \| `inverse-rounded` \| `bevel` \| `inset` \| `fancy` \| `none` |  |
| `opacity` | number |  |
| `blendMode` | string | Normal, Multiply, Screen, Overlay, Darken, Lighten… |

### `delete_item`

Deletes an item (and its text story if it was a text frame).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `duplicate_item`

Duplicates an item, offset by dx/dy (default 5mm) or onto another page at the same position.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `dx` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `dy` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `toPage` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `name` | string |  |

### `rename_item`

Gives an item a name (or removes it).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `name` | string |  |

### `arrange_item`

Brings an item to the front / sends it to the back / one step forward or backward within its layer order.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `action` * | `front` \| `back` \| `forward` \| `backward` |  |

### `align_items`

Aligns items to the page or page margins: left, center, right, top, middle, bottom. Also distributes several items evenly.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `items` * | array |  |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `to` | `page` \| `margins` |  |
| `horizontal` | `left` \| `center` \| `right` |  |
| `vertical` | `top` \| `middle` \| `bottom` |  |
| `distribute` | `horizontal` \| `vertical` | Distribute the items evenly between the outermost ones. |

### `set_text_frame_options`

Columns, gutter, inset spacing, vertical justification and auto-size of a text frame.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
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
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `mode` * | `none` \| `bounding-box` \| `jump` \| `next-column` |  |
| `offset` | number,string | Distance between item and text. |

### `fit_frame_to_content`

For text frames: turns on auto-size so the frame grows/shrinks with its text (height, or both). For image frames use set_image_fit.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `mode` | `height` \| `both` |  |

## Text

### `get_text`

Returns the text of a text frame (or of every text frame in the document), paragraph by paragraph with style names.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

### `set_text`

Replaces all text in a text frame. Use `text` (newlines = paragraphs) or `paragraphs` for per-paragraph styles.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
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
| `item` * | string | The item's name or id (see describe_document / list_items). |
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
| `item` | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `regex` | boolean |  |
| `caseSensitive` | boolean |  |
| `wholeWord` | boolean |  |

### `apply_paragraph_style`

Applies a paragraph style to all paragraphs of a text frame, to specific paragraph numbers, or to paragraphs containing some text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
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
| `item` | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `regex` | boolean |  |
| `caseSensitive` | boolean |  |
| `characterStyle` | string |  |
| `bold` | boolean |  |
| `italic` | boolean |  |
| `fontStyle` | string | Exact font style name, e.g. "Semibold Italic" (overrides bold/italic). |
| `font` | string |  |
| `size` | number |  |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `tracking` | number |  |
| `underline` | boolean |  |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` |  |

### `insert_page_number`

Adds an automatic page-number marker to a text frame, typically a small frame on a master page (create it with add_text_frame using master).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `prefix` | string |  |
| `suffix` | string |  |

### `thread_text_frames`

Links two text frames so text overflowing the first continues in the second. The second frame's own text is discarded.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `from` * | string | The item's name or id (see describe_document / list_items). |
| `to` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

## Styles, swatches and fonts

### `list_styles`

Lists paragraph, character and object styles with their main settings.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `kind` | `paragraph` \| `character` \| `object` \| `all` |  |

### `create_paragraph_style`

Creates a paragraph style (font, size, leading, alignment, spacing, color…). Apply it with add_text_frame, set_text or apply_paragraph_style.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string |  |
| `basedOn` | string |  |
| `nextStyle` | string |  |
| `group` | string | Style group (folder) name. |
| `font` | string | Font family, e.g. "Helvetica Neue". Must be installed on the designer's computer. |
| `fontStyle` | string | Font style name: Regular, Bold, Italic, Light, Semibold… |
| `size` | number | Point size. |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `tracking` | number |  |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number |  |
| `baselineShift` | number |  |
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

### `create_character_style`

Creates a character style for inline formatting (e.g. "Emphasis": italic; "Price": bold red). Apply it with format_text.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` * | string |  |
| `basedOn` | string |  |
| `group` | string |  |
| `font` | string | Font family, e.g. "Helvetica Neue". Must be installed on the designer's computer. |
| `fontStyle` | string | Font style name: Regular, Bold, Italic, Light, Semibold… |
| `size` | number | Point size. |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `tracking` | number |  |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number |  |
| `baselineShift` | number |  |

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
| `size` | number | Point size. |
| `leading` | number \| string | Line spacing in points, or "auto". |
| `color` | string | A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches. |
| `tracking` | number |  |
| `capitalization` | `normal` \| `small-caps` \| `all-caps` \| `cap-to-small-cap` |  |
| `underline` | boolean |  |
| `strikeThrough` | boolean |  |
| `position` | `normal` \| `superscript` \| `subscript` |  |
| `horizontalScale` | number |  |
| `baselineShift` | number |  |
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

### `list_swatches`

Lists color swatches with their values and an approximate hex color.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

### `create_swatch`

Creates a named color swatch from CMYK, RGB or hex values (CMYK recommended for print).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `name` | string | Swatch name (default: InDesign-style "C=0 M=100 Y=0 K=0"). |
| `color` | string | "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". |
| `cmyk` | array | Percentages 0-100. |
| `rgb` | array |  |
| `spot` | boolean |  |

### `list_fonts`

Lists the fonts the document refers to. Fonts must be installed on the computer that opens the document in InDesign.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |

## Pictures

### `place_image`

Places an existing image file (PNG, JPEG, TIFF, PSD, PDF…) on a page: either in a new frame at x/y with width (height optional, keeps proportions) or into an existing frame. The file stays linked, like File > Place in InDesign; keep it next to the document (a Links folder is ideal).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `image` * | string | Path to the image file. |
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
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
| `frame` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `fit` * | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` |  |

### `generate_image`

Generates a picture with OpenAI from a text prompt, saves it in the document's Links folder and optionally places it: give x/y/width for a new frame or frame for an existing one. Without placement it only saves the file. Costs money per image, so confirm the prompt with the user before generating many.

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
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `frame` | string | Put the image into this existing frame instead of creating a new one. |
| `name` | string |  |
| `layer` | string |  |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size). |

### `edit_image`

Edits or combines existing pictures with OpenAI: describe the change in the prompt, pass one or more source images (file paths or frame names whose picture should be used) and optionally a mask PNG whose transparent areas mark what to change. Saves the result to the Links folder and optionally places it (frame / x,y,width).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `prompt` * | string |  |
| `images` * | array | Source image paths, or names/ids of frames containing pictures. |
| `mask` | string | Path to a PNG mask (transparent = area to edit). |
| `size` | string | "square", "landscape", "portrait", an aspect like "16:9" or "3:4", or exact pixels "1536x1024". Default: matches the frame, else square. |
| `quality` | `low` \| `medium` \| `high` \| `auto` | Higher quality costs more and takes longer. Default auto. |
| `transparentBackground` | boolean | Produce a PNG with transparent background (logos, cut-outs). |
| `model` | string | OpenAI image model (default gpt-image-2). Others: gpt-image-1.5, gpt-image-1-mini. |
| `fileName` | string | File name for the saved image (without extension). Default: derived from the prompt. |
| `returnPreview` | boolean | Include a small preview of the image in the reply (default true). |
| `page` | integer \| string | Page for a new frame (default 1). |
| `master` | string | Place on this master page instead. |
| `x` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `y` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `width` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `height` | number,string | A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt". |
| `frame` | string | Put the image into this existing frame instead of creating a new one. |
| `name` | string |  |
| `layer` | string |  |
| `fit` | `fill` \| `fit` \| `stretch` \| `center` \| `frame-to-content` | How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size). |
| `replaceInFrame` | boolean | When a source is a frame, put the result back into that frame (default true). |

### `list_images`

Lists every placed picture with its frame, file path, pixel size, scale and effective resolution (warns below 150 ppi for print).

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |

## Reference documents

### `list_reference_documents`

Lists the reference InDesign documents available (bundled with the server and from configured folders). Use them to reuse styles, swatches, master pages or whole pages instead of designing from scratch.

| Parameter | Type | Description |
|---|---|---|


### `describe_reference`

Full description of a reference document: pages and items, master pages, styles (with fonts and sizes), swatches and fonts.

| Parameter | Type | Description |
|---|---|---|
| `reference` * | string | Reference name (from list_reference_documents) or a path to an .idml file. |

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

### `preview_page`

Renders a page to a PNG image and shows it, so you can check the layout. Uses Adobe InDesign itself when installed (exact), otherwise a built-in renderer with real fonts (very close: frames, colours, pictures and text positions match; fine typographic details may differ). Also saves the PNG next to the document.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `width` | integer | Image width in pixels (default 1200). |
| `renderer` | `auto` \| `builtin` \| `indesign` | auto (default): use Adobe InDesign for a pixel-exact render if it is installed, otherwise the built-in renderer; builtin: always the built-in renderer; indesign: require InDesign. |
| `showGuides` | boolean | Draw margin and column guides. |
| `showFrameEdges` | boolean | Outline text and picture frames. |
| `bleed` | boolean | Include the bleed area. |

### `preview_spread`

Renders the whole spread (facing pages side by side) that contains the given page.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `width` | integer | Image width in pixels (default 1200). |
| `renderer` | `auto` \| `builtin` \| `indesign` | auto (default): use Adobe InDesign for a pixel-exact render if it is installed, otherwise the built-in renderer; builtin: always the built-in renderer; indesign: require InDesign. |
| `showGuides` | boolean | Draw margin and column guides. |
| `showFrameEdges` | boolean | Outline text and picture frames. |
| `bleed` | boolean | Include the bleed area. |

### `preview_document`

Renders every page as a thumbnail on one contact sheet.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `width` | integer |  |
| `columns` | integer |  |
| `showGuides` | boolean |  |

### `preview_item`

Renders a close-up of one item and its surroundings.

| Parameter | Type | Description |
|---|---|---|
| `document` * | string | Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder. |
| `item` * | string | The item's name or id (see describe_document / list_items). |
| `page` | integer \| string | Page number (1 = first page) or the page name shown in InDesign. |
| `width` | integer |  |
| `showFrameEdges` | boolean |  |

### `preview_capabilities`

Reports whether Adobe InDesign is available for exact previews and which fonts the built-in renderer can use.

| Parameter | Type | Description |
|---|---|---|


## Other

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

# Prompts

Prompts appear as slash commands in Claude Desktop.

- **design-from-brief** — Create a flyer, poster, brochure or other InDesign document from a short brief. Arguments: `brief`*, `format`, `file`.
- **match-reference-look** — Build a new document that follows the styles, colors and masters of a reference document. Arguments: `reference`*, `content`*, `file`.
- **review-layout** — Inspect a document page by page and suggest improvements. Arguments: `document`*.
