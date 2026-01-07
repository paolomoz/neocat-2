import {
  LayoutAnalysis,
  LayoutPattern,
  LayoutStructure,
  ChildSignature,
  BlockGeneratorError,
} from './types';

/**
 * Analyzes the layout structure of an element and determines the appropriate block pattern
 */
export function analyzeLayout(element: Element): LayoutAnalysis {
  try {
    const structure = analyzeStructure(element);
    const pattern = detectPattern(structure, element);
    const blockName = generateBlockName(pattern, structure);

    return { pattern, blockName, structure };
  } catch (error) {
    if (error instanceof BlockGeneratorError) {
      throw error;
    }
    throw new BlockGeneratorError(
      `Layout analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'ANALYSIS_FAILED'
    );
  }
}

/**
 * Analyzes the structure of an element's children
 */
function analyzeStructure(element: Element): LayoutStructure {
  const children = Array.from(element.children);
  const childSignatures = children.map(classifyChild);

  return {
    rowCount: children.length,
    columnCount: detectColumnCount(element),
    hasImages: hasElementType(element, 'img, picture, svg, [style*="background-image"]'),
    hasHeadings: hasElementType(element, 'h1, h2, h3, h4, h5, h6'),
    hasLinks: hasElementType(element, 'a, button'),
    hasList: hasElementType(element, 'ul, ol'),
    childSignatures,
    isRepeating: detectRepeatingPattern(childSignatures),
  };
}

/**
 * Classifies a child element by its primary content type
 */
function classifyChild(element: Element): ChildSignature {
  const tagName = element.tagName.toLowerCase();

  // Direct tag classification
  if (['img', 'picture', 'svg'].includes(tagName)) {
    return 'image';
  }
  if (/^h[1-6]$/.test(tagName)) {
    return 'heading';
  }
  if (['p', 'span', 'blockquote'].includes(tagName)) {
    return 'text';
  }
  if (['a', 'button'].includes(tagName)) {
    return 'link';
  }
  if (['ul', 'ol', 'dl'].includes(tagName)) {
    return 'list';
  }
  if (['video', 'iframe', 'audio'].includes(tagName)) {
    return 'media';
  }

  // Container analysis - look at what's inside
  if (['div', 'section', 'article', 'figure', 'aside', 'main', 'header', 'footer'].includes(tagName)) {
    return analyzeContainerContent(element);
  }

  return 'mixed';
}

/**
 * Analyzes the content of a container element to determine its primary type
 */
function analyzeContainerContent(element: Element): ChildSignature {
  const hasImage = element.querySelector('img, picture, svg');
  const hasHeading = element.querySelector('h1, h2, h3, h4, h5, h6');
  const hasText = element.querySelector('p');
  const hasLink = element.querySelector('a, button');
  const hasList = element.querySelector('ul, ol');

  // Count content types
  const contentTypes = [hasImage, hasHeading, hasText, hasLink, hasList].filter(Boolean).length;

  if (contentTypes === 0) {
    return 'container';
  }

  if (contentTypes === 1) {
    if (hasImage) return 'image';
    if (hasHeading) return 'heading';
    if (hasText) return 'text';
    if (hasLink) return 'link';
    if (hasList) return 'list';
  }

  // Multiple content types = mixed
  return 'mixed';
}

/**
 * Detects if there's a repeating pattern in child signatures
 */
function detectRepeatingPattern(signatures: ChildSignature[]): boolean {
  if (signatures.length < 2) {
    return false;
  }

  // Check if all signatures are the same or follow a pattern
  const uniqueSignatures = new Set(signatures);

  // All same type = repeating
  if (uniqueSignatures.size === 1) {
    return true;
  }

  // Mixed containers that likely contain similar structures
  if (uniqueSignatures.size === 1 && signatures[0] === 'mixed') {
    return true;
  }

  // Check for alternating patterns (e.g., image-text, image-text)
  if (signatures.length >= 4 && signatures.length % 2 === 0) {
    const firstPair = signatures.slice(0, 2).join('-');
    let isAlternating = true;
    for (let i = 2; i < signatures.length; i += 2) {
      if (signatures.slice(i, i + 2).join('-') !== firstPair) {
        isAlternating = false;
        break;
      }
    }
    if (isAlternating) return true;
  }

  return false;
}

/**
 * Detects the number of columns based on direct children
 */
function detectColumnCount(element: Element): number {
  const children = Array.from(element.children);
  if (children.length === 0) return 0;

  // For simple structures, column count equals child count (up to 4)
  if (children.length <= 4) {
    // Check if children appear to be columns (similar structure)
    const signatures = children.map(classifyChild);
    const allSimilar = new Set(signatures).size <= 2;

    if (allSimilar || children.length === 1) {
      return children.length;
    }
  }

  // For grid-like structures, try to detect columns from first row
  const firstChild = children[0];
  if (firstChild && firstChild.children.length > 0) {
    return firstChild.children.length;
  }

  return 1;
}

/**
 * Checks if an element contains elements matching the selector
 */
function hasElementType(element: Element, selector: string): boolean {
  return element.querySelector(selector) !== null;
}

/**
 * Detects the layout pattern based on structure analysis
 */
function detectPattern(structure: LayoutStructure, element: Element): LayoutPattern {
  const { rowCount, columnCount, hasImages, hasHeadings, hasList, childSignatures, isRepeating } = structure;

  // Single image element
  if (rowCount === 1 && childSignatures[0] === 'image') {
    return 'single-image';
  }

  // List pattern
  if (hasList && rowCount === 1) {
    return 'list';
  }

  // Hero pattern: image + heading + optional text/links
  if (rowCount <= 3 && hasImages && hasHeadings) {
    const hasLargeImage = element.querySelector('img[width], picture');
    if (hasLargeImage || childSignatures[0] === 'image') {
      return 'hero';
    }
  }

  // Grid pattern: multiple similar items (cards)
  if (isRepeating && rowCount >= 3) {
    return 'grid';
  }

  // Media-text pattern: image paired with text content
  if (rowCount === 1 && columnCount === 2 && hasImages) {
    return 'media-text';
  }

  // Columns pattern: 2-4 distinct columns
  if (columnCount >= 2 && columnCount <= 4 && !isRepeating) {
    return 'columns';
  }

  // Grid pattern: multiple items that could be cards
  if (rowCount >= 2 && hasImages && isRepeating) {
    return 'grid';
  }

  // Accordion pattern: heading + content pairs
  if (isRepeating && childSignatures.includes('heading')) {
    const headingCount = childSignatures.filter(s => s === 'heading').length;
    if (headingCount >= 2 && headingCount === rowCount / 2) {
      return 'accordion';
    }
  }

  // Text-only pattern
  if (!hasImages && (hasHeadings || childSignatures.every(s => s === 'text' || s === 'heading'))) {
    return 'text-only';
  }

  return 'unknown';
}

/**
 * Generates a block name based on the detected pattern and structure
 */
function generateBlockName(pattern: LayoutPattern, structure: LayoutStructure): string {
  const { rowCount, columnCount, hasImages, childSignatures } = structure;

  const patternPrefixes: Record<LayoutPattern, string> = {
    'grid': 'card-grid',
    'columns': 'columns',
    'hero': 'hero-banner',
    'media-text': 'media-text',
    'list': 'content-list',
    'accordion': 'accordion',
    'tabs': 'tabs',
    'cards': 'cards',
    'carousel': 'carousel',
    'text': 'text-block',
    'text-only': 'text-block',
    'single-image': 'featured-image',
    'unknown': 'custom-block',
  };

  const prefix = patternPrefixes[pattern];
  let suffix = '';

  switch (pattern) {
    case 'grid':
      suffix = `-${rowCount}`;
      if (hasImages) suffix += '-media';
      break;

    case 'columns':
      suffix = `-${columnCount}`;
      break;

    case 'media-text':
      // Determine orientation based on which comes first
      const firstIsImage = childSignatures[0] === 'image';
      suffix = firstIsImage ? '-left' : '-right';
      break;

    case 'hero':
      // Add variant based on structure
      if (structure.hasLinks) suffix = '-cta';
      break;

    case 'list':
      suffix = hasImages ? '-illustrated' : '';
      break;

    case 'accordion':
      suffix = `-${rowCount / 2}-items`;
      break;

    case 'text-only':
    case 'single-image':
    case 'unknown':
      // No suffix needed
      break;
  }

  return toKebabCase(prefix + suffix);
}

/**
 * Converts a string to kebab-case
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}
