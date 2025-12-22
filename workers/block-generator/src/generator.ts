import { parseHTML } from 'linkedom';
import {
  LayoutAnalysis,
  LayoutPattern,
  EDSRow,
  EDSCell,
  BlockGeneratorError,
} from './types';

/**
 * Generates decorated EDS block HTML from extracted content
 */
export function generateBlock(
  contentHTML: string,
  analysis: LayoutAnalysis
): string {
  try {
    const { document } = parseHTML(`<div id="content-wrapper">${contentHTML}</div>`);
    const wrapper = document.getElementById('content-wrapper');

    if (!wrapper) {
      throw new BlockGeneratorError('Failed to parse content HTML', 'GENERATION_FAILED');
    }

    // Use the wrapper's first child if it exists, otherwise use wrapper itself
    const content = wrapper.firstElementChild || wrapper;

    const rows = transformToEDSStructure(content, analysis);
    return buildBlockHTML(analysis.blockName, rows, analysis);
  } catch (error) {
    if (error instanceof BlockGeneratorError) {
      throw error;
    }
    throw new BlockGeneratorError(
      `Block generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'GENERATION_FAILED'
    );
  }
}

/**
 * Transforms extracted content into EDS row/cell structure
 */
function transformToEDSStructure(
  content: Element,
  analysis: LayoutAnalysis
): EDSRow[] {
  const rows: EDSRow[] = [];
  const children = Array.from(content.children);

  switch (analysis.pattern) {
    case 'grid':
      // Each child becomes a row with cells for image and content
      for (const child of children) {
        rows.push(createRowFromGridItem(child));
      }
      break;

    case 'columns':
      // Single row with each child as a cell
      rows.push(createRowFromColumns(children));
      break;

    case 'hero':
      // Separate image and content into rows
      rows.push(...createHeroRows(content));
      break;

    case 'media-text':
      // Single row with image and text cells
      rows.push(createMediaTextRow(content));
      break;

    case 'list':
      // Preserve list structure
      rows.push({ cells: [{ content: processImages(content.innerHTML), isImage: false }] });
      break;

    case 'accordion':
      // Each heading-content pair becomes a row
      rows.push(...createAccordionRows(children));
      break;

    case 'text-only':
    case 'single-image':
    case 'unknown':
    default:
      // Wrap all content in a single row/cell
      rows.push({
        cells: [{
          content: processImages(content.innerHTML),
          isImage: analysis.pattern === 'single-image',
        }],
      });
  }

  return rows;
}

/**
 * Creates a row from a grid item (card-like structure)
 */
function createRowFromGridItem(element: Element): EDSRow {
  const cells: EDSCell[] = [];

  // Look for image
  const picture = element.querySelector('picture, img, svg');
  if (picture) {
    const imageContainer = picture.closest('div, figure') || picture;
    cells.push({
      content: processImages(imageContainer.outerHTML),
      isImage: true,
    });
  }

  // Collect remaining content (excluding image container)
  const contentParts: string[] = [];
  for (const child of Array.from(element.children)) {
    if (!child.querySelector('picture, img, svg') && !['IMG', 'PICTURE', 'SVG'].includes(child.tagName)) {
      contentParts.push(child.outerHTML);
    } else if (!cells.some(c => c.isImage)) {
      // If we haven't added an image cell yet, add one
      cells.push({
        content: processImages(child.outerHTML),
        isImage: true,
      });
    }
  }

  if (contentParts.length > 0) {
    cells.push({
      content: contentParts.join('\n'),
      isImage: false,
    });
  }

  // Ensure at least one cell
  if (cells.length === 0) {
    cells.push({
      content: processImages(element.innerHTML),
      isImage: false,
    });
  }

  return { cells };
}

/**
 * Creates a row from column children
 */
function createRowFromColumns(children: Element[]): EDSRow {
  return {
    cells: children.map(child => ({
      content: processImages(child.innerHTML || child.outerHTML),
      isImage: isImageElement(child),
    })),
  };
}

/**
 * Creates rows for hero pattern (image row + content row)
 */
function createHeroRows(content: Element): EDSRow[] {
  const rows: EDSRow[] = [];

  // Find image
  const picture = content.querySelector('picture, img');
  if (picture) {
    const imageContainer = picture.closest('div, figure') || picture;
    rows.push({
      cells: [{
        content: processImages(imageContainer.outerHTML),
        isImage: true,
      }],
    });
  }

  // Collect text content
  const textParts: string[] = [];
  const headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const paragraphs = content.querySelectorAll('p');
  const links = content.querySelectorAll('a, button');

  headings.forEach(h => textParts.push(h.outerHTML));
  paragraphs.forEach(p => textParts.push(p.outerHTML));

  // Add CTAs separately or with text
  const ctaHTML = Array.from(links)
    .filter(l => !textParts.some(t => t.includes(l.outerHTML)))
    .map(l => l.outerHTML)
    .join('\n');

  if (textParts.length > 0 || ctaHTML) {
    rows.push({
      cells: [{
        content: textParts.join('\n') + (ctaHTML ? '\n' + ctaHTML : ''),
        isImage: false,
      }],
    });
  }

  return rows;
}

/**
 * Creates a row for media-text pattern
 */
function createMediaTextRow(content: Element): EDSRow {
  const cells: EDSCell[] = [];

  // Find image
  const picture = content.querySelector('picture, img');
  const imageCell: EDSCell | null = picture ? {
    content: processImages((picture.closest('div, figure') || picture).outerHTML),
    isImage: true,
  } : null;

  // Collect text content
  const textParts: string[] = [];
  for (const child of Array.from(content.children)) {
    if (!child.querySelector('picture, img') && !['IMG', 'PICTURE'].includes(child.tagName)) {
      textParts.push(child.outerHTML);
    }
  }

  const textCell: EDSCell = {
    content: textParts.join('\n') || '',
    isImage: false,
  };

  // Determine order (image first or text first based on DOM order)
  const firstChild = content.firstElementChild;
  const imageFirst = firstChild && (
    firstChild.tagName === 'IMG' ||
    firstChild.tagName === 'PICTURE' ||
    firstChild.querySelector('img, picture')
  );

  if (imageFirst && imageCell) {
    cells.push(imageCell, textCell);
  } else {
    if (textCell.content) cells.push(textCell);
    if (imageCell) cells.push(imageCell);
  }

  return { cells };
}

/**
 * Creates rows for accordion pattern
 */
function createAccordionRows(children: Element[]): EDSRow[] {
  const rows: EDSRow[] = [];
  let currentHeading: string | null = null;

  for (const child of children) {
    const tagName = child.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tagName)) {
      // Start a new accordion item
      if (currentHeading) {
        // Previous heading without content
        rows.push({
          cells: [{ content: currentHeading, isImage: false }],
        });
      }
      currentHeading = child.outerHTML;
    } else if (currentHeading) {
      // Content for current heading
      rows.push({
        cells: [
          { content: currentHeading, isImage: false },
          { content: child.outerHTML, isImage: false },
        ],
      });
      currentHeading = null;
    } else {
      // Standalone content
      rows.push({
        cells: [{ content: child.outerHTML, isImage: false }],
      });
    }
  }

  // Handle trailing heading
  if (currentHeading) {
    rows.push({
      cells: [{ content: currentHeading, isImage: false }],
    });
  }

  return rows;
}

/**
 * Checks if an element is primarily an image element
 */
function isImageElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();

  if (['img', 'picture', 'svg'].includes(tagName)) {
    return true;
  }

  // Check if the element only contains an image
  if (['div', 'figure', 'span'].includes(tagName)) {
    const children = element.children;
    if (children.length === 1) {
      const child = children[0];
      return ['IMG', 'PICTURE', 'SVG'].includes(child.tagName);
    }
  }

  return false;
}

/**
 * Processes images in HTML content, converting to picture elements
 */
function processImages(html: string): string {
  // Convert standalone img tags to picture elements with responsive sources
  return html.replace(
    /<img\s+([^>]*?)src="([^"]*)"([^>]*)>/gi,
    (match, before, src, after) => {
      // Skip if already inside a picture element or is a data URI
      if (src.startsWith('data:')) {
        return match;
      }

      const alt = extractAttribute(before + after, 'alt') || '';
      const loading = extractAttribute(before + after, 'loading') || 'lazy';

      return createPictureElement(src, alt, loading);
    }
  );
}

/**
 * Extracts an attribute value from an attribute string
 */
function extractAttribute(attrString: string, name: string): string | null {
  const match = attrString.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/**
 * Creates a responsive picture element
 */
function createPictureElement(src: string, alt: string, loading: string): string {
  // Determine if this is a relative or absolute URL
  const isAbsolute = src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//');

  // For EDS, we typically use the optimization service
  // The format mirrors what createOptimizedPicture does in aem.js
  const baseSrc = src;

  return `<picture>
  <source type="image/webp" srcset="${baseSrc}?width=2000&amp;format=webply&amp;optimize=medium" media="(min-width: 600px)">
  <source type="image/webp" srcset="${baseSrc}?width=750&amp;format=webply&amp;optimize=medium">
  <source srcset="${baseSrc}?width=2000&amp;format=jpeg&amp;optimize=medium" media="(min-width: 600px)">
  <img loading="${loading}" alt="${escapeHtml(alt)}" src="${baseSrc}?width=750&amp;format=jpeg&amp;optimize=medium">
</picture>`;
}

/**
 * Escapes HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Builds the final EDS block HTML structure
 */
function buildBlockHTML(
  blockName: string,
  rows: EDSRow[],
  analysis: LayoutAnalysis
): string {
  const lines: string[] = [];

  // Block wrapper
  lines.push(`<div class="${blockName}">`);

  // Add rows
  for (const row of rows) {
    lines.push('  <div>');

    for (const cell of row.cells) {
      const cellClass = cell.isImage ? ` class="${blockName}-img-col"` : '';
      lines.push(`    <div${cellClass}>`);
      // Indent cell content
      const contentLines = cell.content.split('\n');
      for (const line of contentLines) {
        if (line.trim()) {
          lines.push(`      ${line.trim()}`);
        }
      }
      lines.push('    </div>');
    }

    lines.push('  </div>');
  }

  lines.push('</div>');

  return lines.join('\n');
}
