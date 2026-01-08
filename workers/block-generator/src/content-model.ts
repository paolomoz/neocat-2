/**
 * Content Model Extraction
 *
 * This module handles Step 1 of the two-step block generation:
 * Extract structured content from source HTML into a BlockContentModel.
 *
 * The goal is to create a faithful, complete representation of the source
 * content that can be validated before generation.
 */

import { parseHTML } from 'linkedom';
import {
  BlockContentModel,
  ContentItem,
  ContentCell,
  ContentElement,
  ContentModelValidation,
  LayoutPattern,
} from './types';
import { ComponentDescription } from './enhanced-generator';

// =============================================================================
// Pattern Detection
// =============================================================================

/**
 * Common patterns for repeating content structures
 */
const REPEATING_PATTERNS = {
  carousel: [
    '.slick-slide:not(.slick-cloned)',
    '.swiper-slide',
    '[class*="carousel"] > [class*="slide"]',
    '[class*="slider"] > [class*="slide"]',
    '[class*="slideshow"] [class*="slide"]',
    '.carousel-item',
    '.slide',
  ],
  cards: [
    '.card',
    '[class*="card"]',
    '.grid > div',
    '.cards > div',
    '[class*="cards"] > div',
    '[class*="grid"] > [class*="item"]',
  ],
  columns: [
    '.col',
    '[class*="col-"]',
    '.column',
    '[class*="column"]',
    '.columns > div',
  ],
  tabs: [
    '[role="tabpanel"]',
    '.tab-pane',
    '.tab-content > div',
    '[class*="tab-panel"]',
  ],
  accordion: [
    '.accordion-item',
    '[class*="accordion"] > div',
    '.collapse-item',
    'details',
  ],
};

/**
 * Detect the block type and find repeating items
 */
export function detectBlockPattern(
  root: any,
  componentDescription?: ComponentDescription
): { blockType: LayoutPattern; itemSelector: string | null; items: any[] } {
  // Use component description hint if available
  const componentType = componentDescription?.componentType?.toLowerCase() || '';

  // Try to detect carousel first (highest priority for fidelity issues)
  if (componentType.includes('carousel') || componentType.includes('slider') || componentType.includes('slideshow')) {
    for (const selector of REPEATING_PATTERNS.carousel) {
      const items = root.querySelectorAll(selector);
      if (items.length > 0) {
        return { blockType: 'carousel', itemSelector: selector, items: Array.from(items) };
      }
    }
  }

  // Try cards
  if (componentType.includes('card') || componentType.includes('grid')) {
    for (const selector of REPEATING_PATTERNS.cards) {
      const items = root.querySelectorAll(selector);
      if (items.length >= 2) {
        return { blockType: 'cards', itemSelector: selector, items: Array.from(items) };
      }
    }
  }

  // Try tabs
  if (componentType.includes('tab')) {
    for (const selector of REPEATING_PATTERNS.tabs) {
      const items = root.querySelectorAll(selector);
      if (items.length >= 2) {
        return { blockType: 'tabs', itemSelector: selector, items: Array.from(items) };
      }
    }
  }

  // Try accordion
  if (componentType.includes('accordion') || componentType.includes('collapse') || componentType.includes('faq')) {
    for (const selector of REPEATING_PATTERNS.accordion) {
      const items = root.querySelectorAll(selector);
      if (items.length >= 2) {
        return { blockType: 'accordion', itemSelector: selector, items: Array.from(items) };
      }
    }
  }

  // Auto-detect: try all patterns
  for (const selector of REPEATING_PATTERNS.carousel) {
    const items = root.querySelectorAll(selector);
    if (items.length >= 2) {
      return { blockType: 'carousel', itemSelector: selector, items: Array.from(items) };
    }
  }

  for (const selector of REPEATING_PATTERNS.cards) {
    const items = root.querySelectorAll(selector);
    if (items.length >= 2) {
      return { blockType: 'cards', itemSelector: selector, items: Array.from(items) };
    }
  }

  // Check for columns by looking at flex/grid children
  const directChildren = Array.from(root.children) as any[];
  if (directChildren.length >= 2 && directChildren.length <= 6) {
    const allSimilar = directChildren.every(
      (child: any) => child.tagName === directChildren[0].tagName
    );
    if (allSimilar) {
      return { blockType: 'columns', itemSelector: null, items: directChildren };
    }
  }

  // Hero (single item) or text-only
  const hasImage = root.querySelector('img, picture, [style*="background-image"]');
  const hasHeading = root.querySelector('h1, h2, h3');

  if (hasImage && hasHeading) {
    return { blockType: 'hero', itemSelector: null, items: [root] };
  }

  return { blockType: 'text', itemSelector: null, items: [root] };
}

// =============================================================================
// Content Extraction
// =============================================================================

/**
 * Extract a single content element from a DOM element
 */
function extractElement(el: any, baseUrl: string): ContentElement | null {
  const tagName = el.tagName.toLowerCase();

  // Heading
  if (/^h[1-6]$/.test(tagName)) {
    const text = el.textContent?.trim();
    if (text) {
      return {
        type: 'heading',
        level: parseInt(tagName[1]),
        text,
      };
    }
  }

  // Paragraph
  if (tagName === 'p') {
    const text = el.textContent?.trim();
    if (text && text.length > 0) {
      return {
        type: 'paragraph',
        text,
      };
    }
  }

  // Image
  if (tagName === 'img') {
    const src = resolveImageSrc(el, baseUrl);
    if (src) {
      return {
        type: 'image',
        src,
        alt: el.getAttribute('alt') || '',
        imageRole: classifyImageRole(el),
      };
    }
  }

  // Picture element
  if (tagName === 'picture') {
    const img = el.querySelector('img');
    if (img) {
      const src = resolveImageSrc(img, baseUrl);
      if (src) {
        return {
          type: 'image',
          src,
          alt: img.getAttribute('alt') || '',
          imageRole: classifyImageRole(img),
        };
      }
    }
  }

  // Link/button
  if (tagName === 'a' || tagName === 'button') {
    const text = el.textContent?.trim();
    const href = el.getAttribute('href') || '';
    if (text && text.length > 1 && text.length < 100) {
      return {
        type: 'link',
        text,
        href: resolveUrl(href, baseUrl),
      };
    }
  }

  // List
  if (tagName === 'ul' || tagName === 'ol') {
    const items = Array.from(el.querySelectorAll('li'))
      .map((li: any) => li.textContent?.trim())
      .filter((text): text is string => !!text);
    if (items.length > 0) {
      return {
        type: 'list',
        listItems: items,
      };
    }
  }

  return null;
}

/**
 * Extract all content from an item element into cells
 */
function extractItemContent(itemEl: any, baseUrl: string): ContentCell[] {
  const cells: ContentCell[] = [];

  // Cell 1: Image content
  const imageElements: ContentElement[] = [];
  const images = itemEl.querySelectorAll('img, picture');
  images.forEach((img: any) => {
    const element = extractElement(img, baseUrl);
    if (element) {
      imageElements.push(element);
    }
  });

  // Also check for background images
  const bgImage = extractBackgroundImage(itemEl, baseUrl);
  if (bgImage) {
    imageElements.push(bgImage);
  }

  if (imageElements.length > 0) {
    cells.push({ name: 'image', elements: imageElements });
  }

  // Cell 2: Text content (headings, paragraphs)
  const textElements: ContentElement[] = [];

  // Extract headings
  itemEl.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h: any) => {
    const element = extractElement(h, baseUrl);
    if (element) {
      textElements.push(element);
    }
  });

  // Extract paragraphs
  itemEl.querySelectorAll('p').forEach((p: any) => {
    // Skip if inside a link
    if (p.closest('a')) return;
    const element = extractElement(p, baseUrl);
    if (element) {
      textElements.push(element);
    }
  });

  // Extract lists
  itemEl.querySelectorAll('ul, ol').forEach((list: any) => {
    const element = extractElement(list, baseUrl);
    if (element) {
      textElements.push(element);
    }
  });

  if (textElements.length > 0) {
    cells.push({ name: 'content', elements: textElements });
  }

  // Cell 3: CTAs/Links
  const ctaElements: ContentElement[] = [];
  itemEl.querySelectorAll('a, button').forEach((link: any) => {
    const element = extractElement(link, baseUrl);
    if (element) {
      // Avoid duplicating links that contain headings or are navigation
      const isNavLink = link.closest('nav, header, footer');
      const containsHeading = link.querySelector('h1, h2, h3, h4, h5, h6');
      if (!isNavLink && !containsHeading) {
        ctaElements.push(element);
      }
    }
  });

  if (ctaElements.length > 0) {
    cells.push({ name: 'cta', elements: ctaElements });
  }

  return cells;
}

/**
 * Extract background image from element styles
 */
function extractBackgroundImage(el: any, baseUrl: string): ContentElement | null {
  const style = el.getAttribute('style') || '';
  const urlMatch = style.match(/background(?:-image)?:\s*url\(['"]?([^'")\s]+)['"]?\)/);

  if (urlMatch) {
    const src = resolveUrl(urlMatch[1], baseUrl);
    if (src && !isPlaceholderImage(src)) {
      return {
        type: 'image',
        src,
        alt: 'Background',
        imageRole: 'background',
      };
    }
  }

  // Check data attributes for lazy-loaded backgrounds
  const bgAttrs = ['data-background', 'data-bg', 'data-background-image'];
  for (const attr of bgAttrs) {
    const bgSrc = el.getAttribute(attr);
    if (bgSrc) {
      const src = resolveUrl(bgSrc, baseUrl);
      if (src && !isPlaceholderImage(src)) {
        return {
          type: 'image',
          src,
          alt: 'Background',
          imageRole: 'background',
        };
      }
    }
  }

  return null;
}

// =============================================================================
// URL Resolution Helpers
// =============================================================================

function isPlaceholderImage(url: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('clear.gif') ||
    lower.includes('spacer.gif') ||
    lower.includes('blank.gif') ||
    lower.includes('pixel.gif') ||
    lower.includes('1x1') ||
    lower.includes('placeholder') ||
    lower.startsWith('data:image/gif;base64,R0lGOD') ||
    (lower.startsWith('data:') && lower.length < 100)
  );
}

function resolveUrl(src: string, baseUrl: string): string {
  if (!src || src === '#') return '';
  if (src.startsWith('http')) return src;
  if (src.startsWith('data:')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return '';
  }
}

function resolveImageSrc(img: any, baseUrl: string): string {
  // Priority: data-src > srcset > src
  const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original'];
  for (const attr of lazyAttrs) {
    const val = img.getAttribute(attr);
    if (val && !isPlaceholderImage(val)) {
      return resolveUrl(val, baseUrl);
    }
  }

  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const srcPart = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (srcPart && !isPlaceholderImage(srcPart)) {
      return resolveUrl(srcPart, baseUrl);
    }
  }

  const src = img.getAttribute('src');
  if (src && !isPlaceholderImage(src)) {
    return resolveUrl(src, baseUrl);
  }

  return '';
}

function classifyImageRole(img: any): 'photo' | 'background' | 'icon' {
  const parentClasses = (img.parentElement?.className || '').toLowerCase();
  const imgClasses = (img.className || '').toLowerCase();

  if (
    parentClasses.includes('background') ||
    parentClasses.includes('hero') ||
    parentClasses.includes('banner') ||
    imgClasses.includes('bg')
  ) {
    return 'background';
  }

  const width = img.getAttribute('width');
  if (width && parseInt(width) < 100) {
    return 'icon';
  }

  return 'photo';
}

// =============================================================================
// Main Extraction Function
// =============================================================================

/**
 * Extract structured content model from HTML
 *
 * This is the main entry point for Step 1 of two-step generation.
 * It produces a BlockContentModel that faithfully represents the source content.
 */
export function extractContentModel(
  html: string,
  baseUrl: string,
  componentDescription?: ComponentDescription
): BlockContentModel {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = document.body.firstElementChild || document.body;

  // Detect block pattern and find items
  const { blockType, itemSelector, items } = detectBlockPattern(root as Element, componentDescription);

  const warnings: string[] = [];
  const contentItems: ContentItem[] = [];
  let completeItems = 0;

  // Extract content from each item
  items.forEach((itemEl, index) => {
    const cells = extractItemContent(itemEl as Element, baseUrl);

    // Check if item has minimum required content
    const hasImage = cells.some(c => c.name === 'image' && c.elements.length > 0);
    const hasContent = cells.some(c => c.name === 'content' && c.elements.length > 0);
    const hasCta = cells.some(c => c.name === 'cta' && c.elements.length > 0);

    if (hasContent || hasImage) {
      completeItems++;
    } else {
      warnings.push(`Item ${index + 1}: Missing content or image`);
    }

    // Check for placeholder links
    cells.forEach(cell => {
      cell.elements.forEach(el => {
        if (el.type === 'link' && (!el.href || el.href === '#' || el.href === '')) {
          warnings.push(`Item ${index + 1}: CTA "${el.text}" has placeholder href`);
        }
      });
    });

    contentItems.push({
      index,
      cells,
    });
  });

  // Build block name suggestion
  const blockName = buildBlockName(blockType, items.length, componentDescription);

  // Build description from component analysis
  const description = componentDescription
    ? {
        componentType: componentDescription.componentType,
        layout: componentDescription.structure.layout,
        layers: componentDescription.structure.layers,
        colorScheme: componentDescription.design.colorScheme,
        effects: componentDescription.design.effects,
      }
    : {
        componentType: blockType,
        layout: 'auto-detected',
        colorScheme: 'unknown',
      };

  const model: BlockContentModel = {
    blockType,
    blockName,
    variant: componentDescription?.componentType.includes('hero') ? 'hero' : undefined,
    description,
    content: {
      items: contentItems,
    },
    validation: {
      itemCount: contentItems.length,
      completeItems,
      warnings,
      isComplete: warnings.length === 0 && contentItems.length > 0,
    },
    source: {
      url: baseUrl,
      extractedAt: new Date().toISOString(),
      selector: itemSelector || undefined,
    },
  };

  return model;
}

/**
 * Build a descriptive block name
 */
function buildBlockName(
  blockType: LayoutPattern,
  itemCount: number,
  description?: ComponentDescription
): string {
  const componentType = description?.componentType?.toLowerCase() || '';

  if (componentType.includes('hero')) {
    if (blockType === 'carousel') return 'hero-carousel';
    return 'hero';
  }

  if (blockType === 'carousel') {
    return `carousel-${itemCount}-slides`;
  }

  if (blockType === 'cards') {
    return `cards-${itemCount}`;
  }

  if (blockType === 'columns') {
    return `columns-${itemCount}`;
  }

  return blockType;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a content model before generation
 *
 * This ensures we don't proceed with incomplete or problematic content.
 */
export function validateContentModel(model: BlockContentModel): ContentModelValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Check for empty content
  if (model.content.items.length === 0) {
    errors.push('No content items extracted');
    suggestions.push('Verify the HTML contains the expected block structure');
  }

  // Check for placeholder links
  let placeholderLinkCount = 0;
  model.content.items.forEach((item, idx) => {
    item.cells.forEach(cell => {
      cell.elements.forEach(el => {
        if (el.type === 'link' && (!el.href || el.href === '#' || el.href === '')) {
          placeholderLinkCount++;
          warnings.push(`Item ${idx + 1}: Link "${el.text}" has no valid href`);
        }
      });
    });
  });

  if (placeholderLinkCount > 0) {
    suggestions.push(`${placeholderLinkCount} links have placeholder hrefs - consider fixing source content`);
  }

  // Check for missing images in carousel/cards
  if (model.blockType === 'carousel' || model.blockType === 'cards') {
    const itemsWithoutImages = model.content.items.filter(
      item => !item.cells.some(c => c.name === 'image' && c.elements.length > 0)
    );
    if (itemsWithoutImages.length > 0) {
      warnings.push(`${itemsWithoutImages.length} items missing images`);
    }
  }

  // Check for empty text content
  const itemsWithoutContent = model.content.items.filter(
    item => !item.cells.some(c => c.name === 'content' && c.elements.length > 0)
  );
  if (itemsWithoutContent.length > 0 && itemsWithoutContent.length === model.content.items.length) {
    errors.push('No text content extracted from any item');
    suggestions.push('Check if content is loaded dynamically or hidden');
  }

  // Add existing warnings from model
  warnings.push(...model.validation.warnings);

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    suggestions,
  };
}

/**
 * Merge live images into a content model
 *
 * Live images (extracted from browser) are more reliable than static HTML parsing.
 * This merges them into the model while preserving structure.
 */
export function mergeImagesIntoModel(
  model: BlockContentModel,
  liveImages: Array<{ src: string; alt: string; role: 'photo' | 'background' | 'icon' }>
): BlockContentModel {
  if (!liveImages || liveImages.length === 0) {
    return model;
  }

  // Create a copy to avoid mutation
  const updatedModel = JSON.parse(JSON.stringify(model)) as BlockContentModel;

  // Map live images to items by order
  // Assumption: images appear in document order matching item order
  let imageIndex = 0;

  for (const item of updatedModel.content.items) {
    const imageCell = item.cells.find(c => c.name === 'image');

    if (imageCell) {
      // Replace existing images with live ones
      for (let i = 0; i < imageCell.elements.length && imageIndex < liveImages.length; i++) {
        const liveImg = liveImages[imageIndex];
        imageCell.elements[i] = {
          type: 'image',
          src: liveImg.src,
          alt: liveImg.alt,
          imageRole: liveImg.role,
        };
        imageIndex++;
      }
    } else if (imageIndex < liveImages.length) {
      // No image cell yet but we have images - add one
      const liveImg = liveImages[imageIndex];
      item.cells.unshift({
        name: 'image',
        elements: [{
          type: 'image',
          src: liveImg.src,
          alt: liveImg.alt,
          imageRole: liveImg.role,
        }],
      });
      imageIndex++;
    }
  }

  return updatedModel;
}

/**
 * Format content model as a summary for logging/debugging
 */
export function formatContentModelSummary(model: BlockContentModel): string {
  const lines: string[] = [
    `Block: ${model.blockName} (${model.blockType})`,
    `Items: ${model.content.items.length}`,
    '',
  ];

  model.content.items.forEach((item, idx) => {
    lines.push(`Item ${idx + 1}:`);
    item.cells.forEach(cell => {
      const elementTypes = cell.elements.map(e => e.type).join(', ');
      lines.push(`  ${cell.name}: [${elementTypes}]`);
      cell.elements.forEach(el => {
        if (el.type === 'heading') {
          lines.push(`    H${el.level}: "${el.text?.substring(0, 50)}..."`);
        } else if (el.type === 'paragraph') {
          lines.push(`    P: "${el.text?.substring(0, 50)}..."`);
        } else if (el.type === 'link') {
          lines.push(`    A: "${el.text}" -> ${el.href?.substring(0, 50)}`);
        } else if (el.type === 'image') {
          lines.push(`    IMG: ${el.src?.substring(0, 50)}...`);
        }
      });
    });
  });

  if (model.validation.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    model.validation.warnings.forEach(w => lines.push(`  - ${w}`));
  }

  return lines.join('\n');
}
