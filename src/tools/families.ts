// The merged tools built from families the modules register into.
import { registerFamilyTool } from './family.ts';
import type { ToolRegistry } from './registry.ts';

export function registerMergedTools(reg: ToolRegistry): void {
  registerFamilyTool(reg, {
    name: 'list',
    family: 'list',
    title: 'List part of the document',
    discriminator: 'what',
    keyName: 'subject',
    readOnly: true,
    description: (keys) =>
      `Lists one part of a document: ${keys.join(', ')}. Start with describe_document for an overview; use this when you want one subject in full.`,
  });

  registerFamilyTool(reg, {
    name: 'edit_item',
    family: 'edit_item',
    title: 'Change an item on the page',
    discriminator: 'op',
    keyName: 'operation',
    description: (keys) =>
      `Changes an item that is already on a page: ${keys.join(', ')}. Identify the item by the name you gave it or by the id from list items. To create items use add_text_frame, add_shape or place_image.`,
  });

  registerFamilyTool(reg, {
    name: 'edit_pages',
    family: 'edit_pages',
    title: 'Add, remove or reorder pages',
    discriminator: 'op',
    keyName: 'operation',
    description: (keys) =>
      `Changes which pages the document has and what order they are in: ${keys.join(', ')}. For the size, margins or master of a page use set_page_size, set_margins_and_columns or apply_master.`,
  });

  registerFamilyTool(reg, {
    name: 'edit_layers',
    family: 'edit_layers',
    title: 'Work with layers',
    discriminator: 'op',
    keyName: 'operation',
    description: (keys) =>
      `Creates and changes layers: ${keys.join(', ')}. Give every document a few named layers early ("Background", "Images", "Text") and pass layer: when you add items, so the file stays editable. To move an item between layers use edit_item with op "layer".`,
  });

  registerFamilyTool(reg, {
    name: 'preview',
    family: 'preview',
    title: 'Render a preview image',
    discriminator: 'what',
    keyName: 'subject',
    readOnly: true,
    description: (keys) =>
      `Renders part of the document to a PNG and shows it, so you can check the layout: ${keys.join(', ')} ("document" is a contact sheet of every page). Uses Adobe InDesign itself when installed (exact), otherwise a built-in renderer with real fonts. Also saves the PNG next to the document.`,
  });
}
