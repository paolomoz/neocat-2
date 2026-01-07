import { Browser } from '@cloudflare/puppeteer';

/**
 * Curated list of CSS properties to extract
 */
const LAYOUT_PROPERTIES = [
  'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'grid-template-columns', 'grid-template-rows', 'gap', 'row-gap', 'column-gap',
];

const SPACING_PROPERTIES = [
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
];

const TYPOGRAPHY_PROPERTIES = [
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'color', 'text-align', 'text-transform', 'text-decoration',
];

const VISUAL_PROPERTIES = [
  'background-color', 'background-image', 'background-size', 'background-position',
  'border', 'border-radius', 'box-shadow', 'opacity',
];

const SIZE_PROPERTIES = [
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
];

const ALL_PROPERTIES = [
  ...LAYOUT_PROPERTIES,
  ...SPACING_PROPERTIES,
  ...TYPOGRAPHY_PROPERTIES,
  ...VISUAL_PROPERTIES,
  ...SIZE_PROPERTIES,
];

/**
 * Extracted styles for an element
 */
export interface ElementStyles {
  selector: string;
  role: 'container' | 'card' | 'image' | 'heading' | 'text' | 'link';
  styles: Record<string, string>;
}

/**
 * Complete extracted styles for a block
 */
export interface ExtractedStyles {
  container: ElementStyles;
  cards: ElementStyles[];
  headings: ElementStyles[];
  images: ElementStyles[];
  texts: ElementStyles[];
  links: ElementStyles[];
}

/**
 * Extract computed styles from a block element and its children
 */
export async function extractComputedStyles(
  browser: Browser,
  url: string,
  selector: string
): Promise<ExtractedStyles> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    await page.waitForSelector(selector, { timeout: 10000 });

    const styles = await page.evaluate((sel: string, props: string[]) => {
      /**
       * Get computed styles for an element
       */
      function getStyles(el: Element): Record<string, string> {
        const computed = window.getComputedStyle(el);
        const result: Record<string, string> = {};

        for (const prop of props) {
          const value = computed.getPropertyValue(prop);
          // Only include non-default, meaningful values
          if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') {
            result[prop] = value;
          }
        }

        return result;
      }

      /**
       * Determine if element looks like a card/item in a grid
       */
      function isCardLike(el: Element, containerRect: DOMRect): boolean {
        const rect = el.getBoundingClientRect();
        // Card should be smaller than container but reasonably sized
        return rect.width > 100 && rect.height > 100 &&
               rect.width < containerRect.width * 0.6 &&
               rect.height < containerRect.height * 0.8;
      }

      const container = document.querySelector(sel);
      if (!container) {
        throw new Error(`Element not found: ${sel}`);
      }

      const containerRect = container.getBoundingClientRect();

      // Extract container styles
      const containerStyles: ElementStyles = {
        selector: sel,
        role: 'container',
        styles: getStyles(container),
      };

      // Find and extract card-like children
      const cards: ElementStyles[] = [];
      const seenCards = new Set<Element>();

      // Look for common card patterns
      const cardSelectors = [
        ':scope > div', ':scope > article', ':scope > li',
        ':scope > a', '[class*="card"]', '[class*="item"]', '[class*="tile"]'
      ];

      for (const cardSel of cardSelectors) {
        try {
          container.querySelectorAll(cardSel).forEach((el, idx) => {
            if (!seenCards.has(el) && isCardLike(el, containerRect)) {
              seenCards.add(el);
              if (cards.length < 4) { // Only sample first few cards
                cards.push({
                  selector: `card-${idx}`,
                  role: 'card',
                  styles: getStyles(el),
                });
              }
            }
          });
        } catch (e) {
          // Invalid selector, skip
        }
      }

      // Extract heading styles
      const headings: ElementStyles[] = [];
      container.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el, idx) => {
        if (headings.length < 3) {
          headings.push({
            selector: `heading-${idx}`,
            role: 'heading',
            styles: getStyles(el),
          });
        }
      });

      // Extract image styles
      const images: ElementStyles[] = [];
      container.querySelectorAll('img, picture').forEach((el, idx) => {
        if (images.length < 3) {
          images.push({
            selector: `image-${idx}`,
            role: 'image',
            styles: getStyles(el),
          });
        }
      });

      // Extract text/paragraph styles
      const texts: ElementStyles[] = [];
      container.querySelectorAll('p, span:not(:empty)').forEach((el, idx) => {
        const text = el.textContent?.trim() || '';
        if (text.length > 20 && texts.length < 3) {
          texts.push({
            selector: `text-${idx}`,
            role: 'text',
            styles: getStyles(el),
          });
        }
      });

      // Extract link/button styles
      const links: ElementStyles[] = [];
      container.querySelectorAll('a, button').forEach((el, idx) => {
        if (links.length < 3) {
          links.push({
            selector: `link-${idx}`,
            role: 'link',
            styles: getStyles(el),
          });
        }
      });

      return {
        container: containerStyles,
        cards,
        headings,
        images,
        texts,
        links,
      };
    }, selector, ALL_PROPERTIES);

    return styles;
  } finally {
    await page.close();
  }
}

/**
 * Format extracted styles as a readable string for the prompt
 */
export function formatStylesForPrompt(styles: ExtractedStyles): string {
  const lines: string[] = [];

  lines.push('## Extracted CSS Styles from Original\n');

  // Container styles
  lines.push('### Container Layout');
  lines.push(formatStyleObject(styles.container.styles, ['display', 'flex-direction', 'grid-template-columns', 'gap', 'padding']));

  // Card styles
  if (styles.cards.length > 0) {
    lines.push('\n### Card/Item Styles');
    lines.push(formatStyleObject(styles.cards[0].styles, ['background-color', 'border-radius', 'box-shadow', 'padding']));
  }

  // Heading styles
  if (styles.headings.length > 0) {
    lines.push('\n### Heading Styles');
    lines.push(formatStyleObject(styles.headings[0].styles, ['font-family', 'font-size', 'font-weight', 'color', 'text-align']));
  }

  // Image styles
  if (styles.images.length > 0) {
    lines.push('\n### Image Styles');
    lines.push(formatStyleObject(styles.images[0].styles, ['width', 'height', 'border-radius', 'object-fit']));
  }

  // Text styles
  if (styles.texts.length > 0) {
    lines.push('\n### Body Text Styles');
    lines.push(formatStyleObject(styles.texts[0].styles, ['font-family', 'font-size', 'color', 'line-height', 'text-align']));
  }

  // Button/Link styles - CRITICAL for matching CTA colors
  if (styles.links && styles.links.length > 0) {
    lines.push('\n### Button/CTA Styles (USE THESE EXACT COLORS)');
    lines.push(formatStyleObject(styles.links[0].styles, ['background-color', 'color', 'border-radius', 'padding', 'border', 'font-weight', 'font-size']));
  }

  return lines.join('\n');
}

/**
 * Format a style object, prioritizing certain properties
 */
function formatStyleObject(styles: Record<string, string>, priorityProps: string[]): string {
  const lines: string[] = [];

  // Add priority properties first
  for (const prop of priorityProps) {
    if (styles[prop]) {
      lines.push(`  ${prop}: ${styles[prop]}`);
    }
  }

  // Add remaining properties
  for (const [prop, value] of Object.entries(styles)) {
    if (!priorityProps.includes(prop)) {
      lines.push(`  ${prop}: ${value}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '  (no significant styles detected)';
}
