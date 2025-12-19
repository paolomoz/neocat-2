import { parseHTML } from 'linkedom';

export interface ExtractedColumn {
  image?: {
    src: string;
    alt: string;
  };
  heading?: string;
  headingLevel?: number;
  description?: string;
  cta?: {
    text: string;
    href: string;
  };
  rawContent?: string;
}

export interface ExtractedBlock {
  type: 'columns' | 'cards' | 'tabs' | 'accordion' | 'hero' | 'text' | 'carousel' | 'unknown';
  title?: string;
  subtitle?: string;
  columns: ExtractedColumn[];
  styles: ExtractedStyles;
}

export interface ExtractedStyles {
  // Colors
  backgroundColor?: string;
  textColor?: string;
  headingColor?: string;
  linkColor?: string;
  // Layout
  columnCount: number;
  gap?: string;
  padding?: string;
  // Typography
  headingFont?: string;
  bodyFont?: string;
  // Other
  borderRadius?: string;
  boxShadow?: string;
}

/**
 * Extracts structured content from HTML, regardless of nesting depth
 */
export function extractContent(html: string, baseUrl?: string): ExtractedBlock {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  const root = document.getElementById('root')!;

  // Find the main title/header
  const title = findMainTitle(root);

  // Find columns/cards - look for repeating structures
  const columns = findColumns(root, baseUrl);

  // Determine block type based on structure
  const type = determineBlockType(root, columns);

  // Extract style hints
  const styles = extractStyles(root, columns);

  return {
    type,
    title: title?.text,
    subtitle: title?.subtitle,
    columns,
    styles,
  };
}

/**
 * Find the main title of the block
 */
function findMainTitle(root: Element): { text: string; subtitle?: string } | null {
  // Look for main headings - typically h2 with classes like mainHeader, title, etc.
  const headings = root.querySelectorAll('h1, h2, h3');

  for (const heading of headings) {
    const text = heading.textContent?.trim();
    if (!text) continue;

    // Skip hidden/accessibility-only headings
    const className = heading.className || '';
    if (className.includes('offscreen') || className.includes('sr-only') || className.includes('hidden') || className.includes('aria-')) {
      continue;
    }

    // Look for main header indicators
    if (className.includes('mainHeader') || className.includes('main-header') ||
        className.includes('title') || className.includes('headline')) {
      return { text };
    }

    // Check if this heading appears before the columns (top-level position)
    // by seeing if it's not deeply nested in column-like containers
    let parent = heading.parentElement;
    let nestingLevel = 0;
    let isInColumn = false;

    while (parent && parent !== root && nestingLevel < 5) {
      const parentClass = parent.className || '';
      if (/col|card|tab|cell|item/i.test(parentClass)) {
        isInColumn = true;
        break;
      }
      parent = parent.parentElement;
      nestingLevel++;
    }

    if (!isInColumn && text.length > 5 && text.length < 100) {
      return { text };
    }
  }

  return null;
}

/**
 * Find column/card structures in the content
 */
function findColumns(root: Element, baseUrl?: string): ExtractedColumn[] {
  const columns: ExtractedColumn[] = [];

  // Strategy 1: Look for elements with column-indicating classes
  const classPatterns = [
    /\bcol[_-]?\d+\b/i,        // col1, col-1, col_1
    /\bcolumn[_-]?\d*\b/i,     // column, column1
    /\btab[_-]?content\b/i,    // tabContent, tab-content
    /\bcard\b/i,               // card
    /\bgrid[_-]?\d+\b/i,       // grid_8, grid-4
    /\bcell\b/i,               // cell
    /\bslide\b/i,              // slide, carousel-slide
    /carousel[_-]*item/i,      // carousel-item, carousel__item, cmp-carousel__item
    /\bswiper-slide\b/i,       // swiper-slide
    /\bslick-slide\b/i,        // slick-slide
  ];

  // Find all potential column containers
  const allElements = root.querySelectorAll('*');
  const columnCandidates: Element[] = [];

  for (const el of allElements) {
    const className = el.className || '';
    if (classPatterns.some(pattern => pattern.test(className))) {
      columnCandidates.push(el);
    }
  }

  // Group by parent to find siblings
  const siblingGroups = groupBySiblings(columnCandidates);

  // Find the best group (most siblings with similar structure)
  let bestGroup = findBestColumnGroup(siblingGroups);

  // If no class-based columns found, try structure-based detection
  if (!bestGroup || bestGroup.length < 2) {
    bestGroup = findStructuralColumns(root);
  }

  // Extract content from each column
  for (const colEl of bestGroup) {
    columns.push(extractColumnContent(colEl, baseUrl));
  }

  return columns;
}

/**
 * Group elements by their parent (siblings)
 */
function groupBySiblings(elements: Element[]): Map<Element, Element[]> {
  const groups = new Map<Element, Element[]>();

  for (const el of elements) {
    const parent = el.parentElement;
    if (!parent) continue;

    if (!groups.has(parent)) {
      groups.set(parent, []);
    }
    groups.get(parent)!.push(el);
  }

  return groups;
}

/**
 * Find the best group of columns (most siblings, consistent structure)
 */
function findBestColumnGroup(groups: Map<Element, Element[]>): Element[] {
  let bestGroup: Element[] = [];
  let bestScore = 0;

  for (const [parent, elements] of groups) {
    if (elements.length < 2) continue;

    // Score based on count and structural similarity
    const score = elements.length * (hasConsistentStructure(elements) ? 2 : 1);

    if (score > bestScore) {
      bestScore = score;
      bestGroup = elements;
    }
  }

  return bestGroup;
}

/**
 * Check if elements have consistent structure (likely columns/cards)
 */
function hasConsistentStructure(elements: Element[]): boolean {
  if (elements.length < 2) return false;

  // Check if all elements have similar child structure
  const signatures = elements.map(el => getStructureSignature(el));
  const firstSig = signatures[0];

  return signatures.every(sig => sig === firstSig);
}

/**
 * Get a signature of an element's structure
 */
function getStructureSignature(el: Element): string {
  const parts: string[] = [];

  if (el.querySelector('img, picture, [data-src]')) parts.push('img');
  if (el.querySelector('h1, h2, h3, h4, h5, h6')) parts.push('heading');
  if (el.querySelector('p')) parts.push('text');
  if (el.querySelector('a')) parts.push('link');

  return parts.join('+');
}

/**
 * Find columns based on structural patterns (fallback)
 */
function findStructuralColumns(root: Element): Element[] {
  // Look for sections, articles, or divs with similar siblings
  const containers = ['section', 'article', 'div'];

  for (const tag of containers) {
    const elements = root.querySelectorAll(tag);
    const groups = groupBySiblings(Array.from(elements));

    for (const [parent, siblings] of groups) {
      if (siblings.length >= 2 && siblings.length <= 6) {
        if (hasConsistentStructure(siblings)) {
          return siblings;
        }
      }
    }
  }

  return [];
}

/**
 * Check if an element is likely a column container
 */
function isColumnContainer(el: Element): boolean {
  const className = el.className || '';
  const patterns = [/col/i, /card/i, /tab/i, /grid/i, /cell/i];
  return patterns.some(p => p.test(className));
}

/**
 * Resolve a relative URL to an absolute URL
 */
function resolveUrl(url: string, baseUrl?: string): string {
  if (!url || !baseUrl) return url;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * Extract content from a single column element
 */
function extractColumnContent(el: Element, baseUrl?: string): ExtractedColumn {
  const column: ExtractedColumn = {};

  // Find image - check multiple sources
  // Priority: data-src on picture container > img src > background-image
  const dataSrcElements = el.querySelectorAll('[data-src]');
  const imgs = el.querySelectorAll('img');

  let imageSrc = '';
  let imageAlt = '';

  // Check data-src attributes (common for lazy-loaded images)
  for (const dsEl of dataSrcElements) {
    const src = dsEl.getAttribute('data-src');
    if (src && !src.includes('clear.gif') && !src.includes('spacer') && !src.includes('1x1')) {
      imageSrc = src;
      imageAlt = dsEl.getAttribute('data-alt') || '';
      break;
    }
  }

  // Check img elements if no data-src found
  if (!imageSrc) {
    for (const img of imgs) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (src && !src.includes('clear.gif') && !src.includes('spacer') && !src.includes('1x1')) {
        imageSrc = src;
        imageAlt = img.getAttribute('alt') || '';
        break;
      }
    }
  }

  // Check for background images in style
  if (!imageSrc) {
    const allElements = el.querySelectorAll('*');
    for (const elem of allElements) {
      const style = elem.getAttribute('style') || '';
      const bgMatch = style.match(/background(?:-image)?:\s*url\(['"]?([^'")\s]+)['"]?\)/i);
      if (bgMatch && bgMatch[1]) {
        imageSrc = bgMatch[1];
        break;
      }
    }
  }

  if (imageSrc) {
    column.image = { src: resolveUrl(imageSrc, baseUrl), alt: imageAlt };
  }

  // Find heading
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    const text = heading.textContent?.trim();
    // Skip hidden headings
    const className = heading.className || '';
    if (text && !className.includes('offscreen') && !className.includes('hidden')) {
      column.heading = text;
      column.headingLevel = parseInt(heading.tagName[1]);
    }
  }

  // Find description (paragraph text)
  const paragraphs = el.querySelectorAll('p');
  const descriptions: string[] = [];
  for (const p of paragraphs) {
    const text = p.textContent?.trim();
    if (text && text.length > 10) {
      descriptions.push(text);
    }
  }
  if (descriptions.length > 0) {
    column.description = descriptions.join(' ');
  }

  // Find CTA link
  const links = el.querySelectorAll('a');
  for (const link of links) {
    const href = link.getAttribute('href');
    const text = link.textContent?.trim();
    if (href && text && !href.startsWith('#') && text.length > 2) {
      column.cta = { text, href: resolveUrl(href, baseUrl) };
      break;
    }
  }

  return column;
}

/**
 * Detect if the structure looks like cards based on visual/structural signals
 */
function detectCardSignals(root: Element, columns: ExtractedColumn[]): { isCards: boolean; confidence: number } {
  let cardScore = 0;
  let columnScore = 0;

  // 1. Check class names for card/column hints
  const classStr = root.innerHTML.toLowerCase();

  // Card-related class patterns
  if (/\bcard\b/.test(classStr)) cardScore += 3;
  if (/\btile\b/.test(classStr)) cardScore += 3;
  if (/\bgrid-item\b/.test(classStr)) cardScore += 2;
  if (/\bproduct\b/.test(classStr)) cardScore += 1;
  if (/\bteaser\b/.test(classStr)) cardScore += 2;

  // Column-related class patterns
  if (/\bcol(?:umn)?[-_]?\d*\b/.test(classStr)) columnScore += 2;
  if (/\bfeature\b/.test(classStr)) columnScore += 1;

  // 2. Check for visual boundaries (box-shadow, border, border-radius in inline styles)
  const elementsWithStyle = root.querySelectorAll('[style]');
  for (const el of elementsWithStyle) {
    const style = (el.getAttribute('style') || '').toLowerCase();
    if (/box-shadow/.test(style)) cardScore += 2;
    if (/border-radius/.test(style)) cardScore += 1;
    if (/border:\s*\d/.test(style)) cardScore += 1;
  }

  // 3. Check description length - cards have shorter descriptions
  const avgDescLength = columns.reduce((sum, c) => sum + (c.description?.length || 0), 0) / (columns.length || 1);
  if (avgDescLength < 80) {
    cardScore += 2; // Short descriptions = likely cards
  } else if (avgDescLength > 150) {
    columnScore += 2; // Long descriptions = likely columns
  }

  // 4. Check for wrapper links (entire item wrapped in <a>)
  const allElements = root.querySelectorAll('a');
  let wrapperLinkCount = 0;
  for (const link of allElements) {
    // If link contains both image and heading, it's a wrapper link (card pattern)
    if (link.querySelector('img, picture') && link.querySelector('h2, h3, h4')) {
      wrapperLinkCount++;
    }
  }
  if (wrapperLinkCount >= columns.length * 0.5) {
    cardScore += 3;
  }

  // 5. Check if items have CTA links (columns often have explicit CTAs, cards are clickable)
  const itemsWithCta = columns.filter(c => c.cta).length;
  if (itemsWithCta >= columns.length * 0.7) {
    columnScore += 2; // Explicit CTAs = likely columns
  }

  const isCards = cardScore > columnScore;
  const confidence = Math.abs(cardScore - columnScore);

  return { isCards, confidence };
}

/**
 * Detect if the structure is a carousel
 */
function detectCarousel(root: Element): boolean {
  const html = root.innerHTML.toLowerCase();
  const outerHTML = root.outerHTML?.toLowerCase() || '';

  // Check class names for carousel patterns
  const carouselClassPatterns = [
    /\bcarousel\b/,
    /\bslider\b/,
    /\bswiper\b/,
    /\bslick\b/,
    /\bslideshow\b/,
    /\bgallery\b/,
  ];

  for (const pattern of carouselClassPatterns) {
    if (pattern.test(html) || pattern.test(outerHTML)) {
      return true;
    }
  }

  // Check for ARIA carousel attributes
  if (root.querySelector('[aria-roledescription="carousel"]')) return true;
  if (root.querySelector('[data-cmp-is="carousel"]')) return true;
  if (root.querySelector('[data-slick]')) return true;
  if (root.querySelector('[data-swiper]')) return true;
  if (root.querySelector('.owl-carousel')) return true;

  // Check for carousel navigation elements
  const hasCarouselNav = root.querySelector(
    '[class*="carousel-indicator"], [class*="carousel-control"], ' +
    '[class*="slick-dots"], [class*="swiper-pagination"], ' +
    '[class*="slide-nav"], [class*="slider-nav"]'
  );
  if (hasCarouselNav) return true;

  return false;
}

/**
 * Determine the block type based on structure
 */
function determineBlockType(root: Element, columns: ExtractedColumn[]): ExtractedBlock['type'] {
  const columnCount = columns.length;

  // Check for carousel first (before other patterns)
  if (detectCarousel(root)) {
    return 'carousel';
  }

  // Check for hero (single large image with text)
  if (columnCount <= 1) {
    const hasLargeImage = root.querySelector('img, picture, [data-src]');
    const hasHeading = root.querySelector('h1, h2');
    if (hasLargeImage && hasHeading) {
      return 'hero';
    }
  }

  // Check for accordion (heading + content pairs without images)
  const columnsWithImages = columns.filter(c => c.image).length;
  if (columnCount >= 2 && columnsWithImages === 0) {
    const allHaveHeadings = columns.every(c => c.heading);
    if (allHaveHeadings) {
      return 'accordion';
    }
  }

  // Use signal-based detection to distinguish cards from columns
  if (columnCount >= 2) {
    const { isCards } = detectCardSignals(root, columns);
    return isCards ? 'cards' : 'columns';
  }

  // Default
  if (columnCount === 0) {
    return root.querySelector('h1, h2, h3, p') ? 'text' : 'unknown';
  }

  return 'columns';
}

/**
 * Extract style hints from the HTML
 */
function extractStyles(root: Element, columns: ExtractedColumn[]): ExtractedStyles {
  const styles: ExtractedStyles = {
    columnCount: columns.length || 1,
  };

  // Look for inline styles
  const elementsWithStyle = root.querySelectorAll('[style]');
  for (const el of elementsWithStyle) {
    const style = el.getAttribute('style') || '';

    // Extract colors
    const bgMatch = style.match(/background(?:-color)?:\s*([^;]+)/i);
    if (bgMatch) styles.backgroundColor = bgMatch[1].trim();

    const colorMatch = style.match(/(?:^|;)\s*color:\s*([^;]+)/i);
    if (colorMatch) styles.textColor = colorMatch[1].trim();

    // Extract spacing
    const paddingMatch = style.match(/padding:\s*([^;]+)/i);
    if (paddingMatch) styles.padding = paddingMatch[1].trim();

    const gapMatch = style.match(/gap:\s*([^;]+)/i);
    if (gapMatch) styles.gap = gapMatch[1].trim();
  }

  // Look for color hints in class names
  const classStr = root.innerHTML || '';
  if (classStr.includes('gradient')) {
    styles.headingColor = 'var(--link-color)'; // Common gradient text pattern
  }

  return styles;
}
