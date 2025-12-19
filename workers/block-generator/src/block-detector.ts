import { Browser } from '@cloudflare/puppeteer';

export interface DetectedBlock {
  selector: string;
  tagName: string;
  classes: string[];
  id: string | null;
  htmlSnippet: string; // First 500 chars of outerHTML for context
  textContent: string; // First 200 chars of text
  hasImages: boolean;
  hasHeadings: boolean;
  hasLinks: boolean;
  childCount: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

export interface PageDetectionResult {
  url: string;
  title: string;
  blocks: DetectedBlock[];
}

/**
 * Detect content blocks by running JavaScript in the actual browser context.
 * This ensures all selectors are verified to exist and match exactly one element.
 */
export async function detectBlocksInBrowser(
  browser: Browser,
  url: string
): Promise<PageDetectionResult> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Get page title
    const title = await page.title();

    // Run block detection script in browser context
    const blocks = await page.evaluate(() => {
      const detected: Array<{
        selector: string;
        tagName: string;
        classes: string[];
        id: string | null;
        htmlSnippet: string;
        textContent: string;
        hasImages: boolean;
        hasHeadings: boolean;
        hasLinks: boolean;
        childCount: number;
        boundingBox: { x: number; y: number; width: number; height: number } | null;
      }> = [];

      /**
       * Generate a unique CSS selector for an element
       */
      function generateSelector(el: Element): string | null {
        // Try ID first (most reliable)
        if (el.id) {
          const selector = `#${CSS.escape(el.id)}`;
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }

        // Try unique class combination
        if (el.classList.length > 0) {
          const classes = Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
          if (document.querySelectorAll(classes).length === 1) {
            return classes;
          }
        }

        // Try tag + classes
        if (el.classList.length > 0) {
          const selector = el.tagName.toLowerCase() + Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }

        // Try nth-of-type with parent context
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
          const index = siblings.indexOf(el) + 1;

          // Get parent selector
          let parentSelector = '';
          if (parent.id) {
            parentSelector = `#${CSS.escape(parent.id)}`;
          } else if (parent.classList.length > 0) {
            parentSelector = Array.from(parent.classList).map(c => `.${CSS.escape(c)}`).join('');
          } else if (parent.tagName.toLowerCase() === 'main' || parent.tagName.toLowerCase() === 'body') {
            parentSelector = parent.tagName.toLowerCase();
          }

          if (parentSelector) {
            const selector = `${parentSelector} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }
        }

        // Try data attributes
        const dataAttrs = Array.from(el.attributes).filter(a => a.name.startsWith('data-'));
        for (const attr of dataAttrs) {
          const selector = `[${attr.name}="${CSS.escape(attr.value)}"]`;
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }

        return null;
      }

      /**
       * Check if element is a meaningful content block (not a wrapper)
       */
      function isContentBlock(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const classList = Array.from(el.classList).join(' ').toLowerCase();

        // Must be visible and have reasonable size
        if (rect.width < 200 || rect.height < 80) return false;

        // Skip navigation, header, footer
        if (tag === 'nav' || tag === 'header' || tag === 'footer') return false;

        // Skip full-page wrappers (cover most of viewport)
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        if (rect.height > viewportHeight * 2 && rect.width > viewportWidth * 0.9) {
          return false; // Too big, likely a wrapper
        }

        // Skip generic wrappers
        if (classList.includes('page') && el.children.length < 5) return false;
        if (classList.includes('container') && !classList.includes('section')) return false;
        if (classList.includes('wrapper') && !classList.includes('content')) return false;

        // Skip if it's just a wrapper with single child that has same content
        if (el.children.length === 1) {
          const child = el.children[0];
          const childRect = child.getBoundingClientRect();
          // If child takes up most of parent, parent is just a wrapper
          if (childRect.height > rect.height * 0.8 && childRect.width > rect.width * 0.8) {
            return false;
          }
        }

        // Must have some content
        const text = el.textContent?.trim() || '';
        if (text.length < 20) return false;

        // Check for meaningful content
        const hasHeadings = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
        const hasImages = el.querySelector('img, picture, video') !== null;
        const hasParagraphs = el.querySelector('p') !== null;
        const hasLinks = el.querySelector('a') !== null;
        const hasMultipleChildren = el.children.length >= 2;

        // Require meaningful structure
        return (hasHeadings || hasImages) && (hasParagraphs || hasLinks || hasMultipleChildren);
      }

      /**
       * Find all content blocks on the page
       */
      function findContentBlocks(): Element[] {
        const candidates: Element[] = [];
        const seenElements = new Set<Element>();

        function addCandidate(el: Element) {
          if (!seenElements.has(el) && isContentBlock(el)) {
            seenElements.add(el);
            candidates.push(el);
          }
        }

        // Strategy 1: Look for semantic sections
        document.querySelectorAll('main section, main article, main > div, [role="main"] section, [role="main"] > div').forEach(addCandidate);

        // Strategy 2: Look for common CMS/framework patterns
        document.querySelectorAll(
          '[class*="section"]:not([class*="section-"]), ' +
          '[class*="-section"], ' +
          '[class*="hero"], [class*="banner"], ' +
          '[class*="carousel"], [class*="slider"], ' +
          '[class*="cards"], [class*="grid"]:not(body > *), ' +
          '[class*="columns"], [class*="row"]:not(body > *), ' +
          '[data-component], [data-block], [data-module]'
        ).forEach(addCandidate);

        // Strategy 3: If few candidates, look at direct children of main containers
        if (candidates.length < 3) {
          document.querySelectorAll('.page > div, .content > div, .main > div, #main > div, #content > div').forEach(addCandidate);
        }

        // Strategy 4: Look for elements with specific class patterns (AEM, Drupal, etc.)
        document.querySelectorAll(
          '[class*="cmp-"], [class*="component-"], ' +
          '[class*="block-"], [class*="module-"], ' +
          '[class*="node-"], [class*="field-"]'
        ).forEach(addCandidate);

        // Remove nested duplicates - prefer more specific (child) over generic (parent)
        // unless parent is clearly a cohesive block
        const filtered = candidates.filter((el, i) => {
          // Check if this element is contained in another candidate
          const parent = candidates.find((other, j) => j !== i && other.contains(el) && other !== el);
          if (parent) {
            // Keep child if parent is much larger (wrapper-like)
            const parentRect = parent.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const parentIsWrapper = parentRect.height > elRect.height * 1.5;
            return parentIsWrapper;
          }
          return true;
        });

        // Also remove parents when children cover most of the content
        const finalFiltered = filtered.filter(el => {
          const children = filtered.filter(c => el.contains(c) && el !== c);
          if (children.length >= 2) {
            // If element has 2+ child candidates, it's likely just a container
            return false;
          }
          return true;
        });

        // Sort by visual position (top to bottom)
        finalFiltered.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return rectA.top - rectB.top;
        });

        return finalFiltered.slice(0, 10); // Limit to top 10 blocks
      }

      // Find blocks
      const blocks = findContentBlocks();

      // Process each block
      for (const el of blocks) {
        const selector = generateSelector(el);
        if (!selector) continue; // Skip if can't generate unique selector

        // Verify selector works
        const matches = document.querySelectorAll(selector);
        if (matches.length !== 1) continue;

        const rect = el.getBoundingClientRect();

        detected.push({
          selector,
          tagName: el.tagName.toLowerCase(),
          classes: Array.from(el.classList),
          id: el.id || null,
          htmlSnippet: el.outerHTML.substring(0, 500),
          textContent: (el.textContent || '').trim().substring(0, 200),
          hasImages: el.querySelector('img, picture, video') !== null,
          hasHeadings: el.querySelector('h1, h2, h3, h4, h5, h6') !== null,
          hasLinks: el.querySelectorAll('a').length > 0,
          childCount: el.children.length,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }

      return detected;
    });

    return {
      url,
      title,
      blocks,
    };
  } finally {
    await page.close();
  }
}
