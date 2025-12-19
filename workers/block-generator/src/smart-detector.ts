import { Browser } from '@cloudflare/puppeteer';
import { AnthropicConfig, NamedBlock } from './design-analyzer';

/**
 * Block description from Claude's visual analysis
 */
interface DescribedBlock {
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'carousel' | 'columns' | 'tabs' | 'accordion' | 'form' | 'content' | 'other';
  contentHints: {
    headings?: string[];      // Key headings/titles visible
    hasImages: boolean;
    imageCount?: number;
    hasCards?: boolean;
    cardCount?: number;
    position: 'top' | 'middle' | 'bottom';
  };
}

/**
 * Result from smart detection
 */
export interface SmartDetectionResult {
  url: string;
  title: string;
  blocks: NamedBlock[];
}

/**
 * Smart detection approach:
 * 1. Send screenshot to Claude - "What content blocks do you see?"
 * 2. Claude describes blocks naturally (hero, cards grid, etc.)
 * 3. For each described block, find best matching DOM element
 * 4. Return blocks with verified selectors
 */
export async function detectBlocksSmart(
  browser: Browser,
  url: string,
  config: AnthropicConfig
): Promise<SmartDetectionResult> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const title = await page.title();

    // Step 1: Take screenshot
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png',
    });
    const screenshotBase64 = Buffer.from(screenshot).toString('base64');

    // Step 2: Ask Claude to describe the content blocks
    const describedBlocks = await describePageBlocks(screenshotBase64, config);
    console.log(`Claude identified ${describedBlocks.length} content blocks`);

    // Step 3: For each described block, find matching DOM element
    const matchedBlocks: NamedBlock[] = [];

    for (const block of describedBlocks) {
      console.log(`Finding DOM element for: ${block.name}`);
      const result = await findMatchingElement(page, block);

      if (result && result.selector) {
        console.log(`  Found: ${result.selector}`);
        if (result.siblingSelectors && result.siblingSelectors.length > 0) {
          console.log(`  + ${result.siblingSelectors.length} sibling(s) to merge: ${result.siblingSelectors.join(', ')}`);
        }
        matchedBlocks.push({
          selector: result.selector,
          name: block.name,
          description: block.description,
          type: block.type,
          priority: block.contentHints.position === 'top' ? 'high' : 'medium',
          siblingSelectors: result.siblingSelectors,
        });
      } else {
        console.log(`  Could not find matching element`);
      }
    }

    return {
      url,
      title,
      blocks: matchedBlocks,
    };
  } finally {
    await page.close();
  }
}

/**
 * Ask Claude to describe the content blocks on the page
 */
async function describePageBlocks(
  screenshotBase64: string,
  config: AnthropicConfig
): Promise<DescribedBlock[]> {
  const prompt = `Analyze this webpage screenshot and identify the main CONTENT BLOCKS.

For each content block, provide:
- name: A descriptive name (e.g., "Hero Banner", "Product Cards Grid")
- description: What the block contains/does
- type: One of: hero, cards, carousel, columns, tabs, accordion, form, content, other
- contentHints: Details to help find this block in the DOM:
  - headings: Array of key heading texts visible in this block (first few words are enough)
  - hasImages: true/false
  - imageCount: approximate number of images
  - hasCards: true if it's a grid/list of similar items
  - cardCount: number of cards/items if applicable
  - position: "top", "middle", or "bottom" of the page

Focus on main content sections. IGNORE:
- Navigation/header
- Footer
- Cookie banners
- Modals/popups

Return a JSON array:
[
  {
    "name": "Hero Banner",
    "description": "Full-width hero with industrial pipes background, company headline and intro text",
    "type": "hero",
    "contentHints": {
      "headings": ["Sherwin-Williams Industrial Coatings"],
      "hasImages": true,
      "imageCount": 1,
      "hasCards": false,
      "position": "top"
    }
  },
  {
    "name": "Division Cards Grid",
    "description": "8 cards showing product divisions with images, titles and descriptions",
    "type": "cards",
    "contentHints": {
      "headings": ["Aerospace Coatings", "Automotive Finishes", "Coil & Extrusion"],
      "hasImages": true,
      "imageCount": 8,
      "hasCards": true,
      "cardCount": 8,
      "position": "middle"
    }
  }
]

Return ONLY the JSON array.`;

  let response: Response;

  if (config.useBedrock && config.bedrockToken) {
    const region = config.bedrockRegion || 'us-east-1';
    const model = config.bedrockModel || 'anthropic.claude-sonnet-4-20250514-v1:0';
    const bedrockUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;

    response = await fetch(bedrockUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.bedrockToken}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } else if (config.apiKey) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } else {
    throw new Error('No Anthropic API configuration provided');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) {
    throw new Error('No text response from Claude');
  }

  try {
    const match = textContent.text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    return JSON.parse(match[0]) as DescribedBlock[];
  } catch (e) {
    console.error('Failed to parse block descriptions:', textContent.text);
    return [];
  }
}

/**
 * Result from element matching
 */
interface MatchResult {
  selector: string | null;
  siblingSelectors?: string[];
  debug?: string;
}

/**
 * Find the DOM element that best matches the described block
 * Also detects similar siblings for merged content (e.g., card grids split across multiple rows)
 */
async function findMatchingElement(
  page: any,
  block: DescribedBlock
): Promise<MatchResult | null> {
  return await page.evaluate((blockData: DescribedBlock) => {
    const { name, type, contentHints } = blockData;

    /**
     * Generate a unique selector for an element
     */
    function generateSelector(el: Element): string | null {
      // Try ID
      if (el.id && !el.id.match(/^\d/)) {
        const selector = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      // Try meaningful classes (excluding AEM utility classes)
      if (el.classList.length > 0) {
        const meaningful = Array.from(el.classList)
          .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|mx-|my-|flex|grid|col-|row-|w-|h-|text-|bg-|p-|m-|d-|aem-)/));
        if (meaningful.length > 0) {
          const selector = meaningful.map(c => `.${CSS.escape(c)}`).join('');
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
      }

      // Try tag + classes
      if (el.classList.length > 0) {
        const selector = el.tagName.toLowerCase() + Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
        if (document.querySelectorAll(selector).length === 1) return selector;
      }

      // Try meaningful classes + nth-of-type for disambiguation
      if (el.classList.length > 0) {
        const meaningful = Array.from(el.classList)
          .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|mx-|my-|flex|grid|col-|row-|w-|h-|text-|bg-|p-|m-|d-|aem-)/));
        if (meaningful.length > 0) {
          const baseSelector = meaningful.map(c => `.${CSS.escape(c)}`).join('');
          const matches = document.querySelectorAll(baseSelector);
          if (matches.length > 1 && matches.length <= 10) {
            const idx = Array.from(matches).indexOf(el) + 1;
            const selector = `${baseSelector}:nth-of-type(${idx})`;
            // Verify this is unique
            if (document.querySelectorAll(selector).length === 1) return selector;
            // If not, try with nth-child
            const nthChildSelector = `${baseSelector}:nth-child(${idx})`;
            if (document.querySelectorAll(nthChildSelector).length === 1) return nthChildSelector;
          }
        }
      }

      // Try parent > nth-of-type
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const idx = siblings.indexOf(el) + 1;

        // Try to generate a parent selector
        let parentSel = '';
        if (parent.id) {
          parentSel = `#${CSS.escape(parent.id)}`;
        } else if (parent.tagName === 'MAIN' || parent.tagName === 'BODY') {
          parentSel = parent.tagName.toLowerCase();
        } else if (parent.classList.length > 0) {
          // Try parent's meaningful classes
          const parentMeaningful = Array.from(parent.classList)
            .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|mx-|my-|flex|grid|col-|row-|w-|h-|text-|bg-|p-|m-|d-|aem-)/));
          if (parentMeaningful.length > 0) {
            parentSel = parentMeaningful.map(c => `.${CSS.escape(c)}`).join('');
          }
        }

        if (parentSel) {
          const selector = `${parentSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }

        // Last resort: tag + position among all siblings
        if (siblings.length > 1) {
          const selector = `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
          // Only use if it's reasonably unique (< 5 matches)
          const matches = document.querySelectorAll(selector);
          if (matches.length > 0 && matches.length < 5 && Array.from(matches).includes(el)) {
            return selector;
          }
        }
      }

      return null;
    }

    /**
     * Score how well an element matches the described block
     */
    function scoreElement(el: Element): number {
      let score = 0;
      const rect = el.getBoundingClientRect();
      const text = el.textContent || '';
      const classStr = (el.className || '').toLowerCase();

      // Must be visible and reasonably sized
      if (rect.width < 300 || rect.height < 80) return 0;
      if (rect.height > document.documentElement.scrollHeight * 0.9) return 0;

      // PENALTY: Generic container classes (too broad)
      if (classStr.includes('responsivegrid') || classStr.includes('container') || classStr.includes('wrapper')) {
        // Check if this contains multiple distinct sections
        const childSections = el.querySelectorAll('[class*="hero"], [class*="card"], [class*="grid"], section, article');
        if (childSections.length > 1) {
          // This is likely a parent container, heavily penalize
          score -= 50;
        }
      }

      // PENALTY: If looking for cards but element contains hero-like content
      if (type === 'cards') {
        const heroElements = el.querySelectorAll('[class*="hero"], [class*="banner"], [class*="jumbotron"]');
        if (heroElements.length > 0) {
          // Contains hero content - this is probably a parent container
          score -= 40;
        }
        // Also check for large background images typical of heroes
        const firstChild = el.firstElementChild;
        if (firstChild) {
          const firstRect = firstChild.getBoundingClientRect();
          if (firstRect.height > 300 && firstRect.width > rect.width * 0.8) {
            // First child is a large full-width element (likely hero)
            score -= 30;
          }
        }
      }

      // PENALTY: If looking for hero but element contains card grids
      if (type === 'hero') {
        const cardElements = el.querySelectorAll('[class*="card"], [class*="grid"], [class*="tile"]');
        if (cardElements.length > 3) {
          score -= 40;
        }
      }

      // Check position
      const pageHeight = document.documentElement.scrollHeight;
      const relativeY = (rect.top + window.scrollY) / pageHeight;

      if (contentHints.position === 'top' && relativeY < 0.3) score += 30;
      else if (contentHints.position === 'middle' && relativeY >= 0.2 && relativeY <= 0.7) score += 20;
      else if (contentHints.position === 'bottom' && relativeY > 0.6) score += 20;

      // Check for heading matches
      if (contentHints.headings && contentHints.headings.length > 0) {
        for (const heading of contentHints.headings) {
          if (text.toLowerCase().includes(heading.toLowerCase().substring(0, 20))) {
            score += 25;
            break;
          }
        }
      }

      // Check for images
      const images = el.querySelectorAll('img, picture, video');
      if (contentHints.hasImages && images.length > 0) {
        score += 15;
        if (contentHints.imageCount && Math.abs(images.length - contentHints.imageCount) <= 2) {
          score += 10;
        }
        // PENALTY: Too many images suggests this is a parent container
        if (contentHints.imageCount && images.length > contentHints.imageCount * 2) {
          score -= 20;
        }
      }

      // Check for cards structure
      if (contentHints.hasCards && contentHints.cardCount) {
        // Look for repeated similar children
        const children = Array.from(el.children);
        const similarChildren = children.filter(c => {
          const cRect = c.getBoundingClientRect();
          return cRect.width > 100 && cRect.height > 100;
        });

        if (similarChildren.length >= contentHints.cardCount * 0.5) {
          score += 20;
        }

        // Also check for nested card-like structures
        const cardLike = el.querySelectorAll('[class*="card"], [class*="item"], [class*="tile"]');
        if (cardLike.length >= contentHints.cardCount * 0.5) {
          score += 15;
        }
      }

      // Bonus for type-specific class names
      if (type === 'hero' && (classStr.includes('hero') || classStr.includes('banner') || classStr.includes('jumbotron'))) {
        score += 20;
      }
      if (type === 'cards' && (classStr.includes('card') || classStr.includes('grid') || classStr.includes('list') || classStr.includes('column-control') || classStr.includes('columns'))) {
        score += 20;
      }
      if (type === 'carousel' && (classStr.includes('carousel') || classStr.includes('slider') || classStr.includes('swiper'))) {
        score += 20;
      }

      return score;
    }

    // Collect candidate elements
    const candidates: Array<{ el: Element; score: number; selector: string }> = [];

    // Search strategy based on block type
    let searchSelectors: string[] = [];

    if (type === 'hero') {
      searchSelectors = [
        '[class*="hero"]', '[class*="banner"]', '[class*="jumbotron"]',
        'main > section:first-of-type', 'main > div:first-of-type',
        '[class*="intro"]', '[class*="splash"]'
      ];
    } else if (type === 'cards') {
      searchSelectors = [
        // Look for card containers first
        'section[class*="column-control"]', 'div[class*="column-control"]',
        'section[class*="columns"]', 'div[class*="columns"]',
        '[class*="card-container"]', '[class*="cards"]',
        '[class*="grid"]', '[class*="tiles"]',
        '[class*="products"]', '[class*="features"]', '[class*="services"]',
        '[class*="categories"]', '[class*="divisions"]', '[class*="items"]',
        // Broader selectors
        'main section', 'main > div'
      ];
    } else if (type === 'carousel') {
      searchSelectors = [
        '[class*="carousel"]', '[class*="slider"]', '[class*="swiper"]',
        '[class*="slideshow"]', '[class*="gallery"]'
      ];
    } else {
      searchSelectors = ['section', 'article', 'main > div', '[class*="content"]', '[class*="block"]'];
    }

    // Search for candidates
    for (const sel of searchSelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const score = scoreElement(el);
          if (score > 30) {
            const selector = generateSelector(el);
            if (selector) {
              // Avoid duplicates
              if (!candidates.some(c => c.selector === selector)) {
                candidates.push({ el, score, selector });
              }
            }
          }
        });
      } catch (e) {
        // Invalid selector, skip
      }
    }

    // Also search all sections and large divs as fallback
    document.querySelectorAll('section, article, main > div, [role="main"] > div').forEach(el => {
      const score = scoreElement(el);
      if (score > 30) {
        const selector = generateSelector(el);
        if (selector && !candidates.some(c => c.selector === selector)) {
          candidates.push({ el, score, selector });
        }
      }
    });

    // Sort by score and return best match
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      const best = candidates[0];

      // For cards type, check if there are similar siblings that should be merged
      let siblingSelectors: string[] = [];

      if (type === 'cards' && contentHints.hasCards && contentHints.cardCount) {
        const el = best.el;
        const parent = el.parentElement;

        if (parent) {
          // Count card-like items in the matched element
          const cardItems = el.querySelectorAll('[class*="card"], [class*="tile"], [class*="item"], [class*="category"], [class*="division"]');
          const directChildren = Array.from(el.children).filter(c => {
            const cRect = c.getBoundingClientRect();
            return cRect.width > 100 && cRect.height > 100;
          });
          const itemsInElement = Math.max(cardItems.length, directChildren.length);

          // If we found fewer items than expected, look for similar siblings
          if (itemsInElement > 0 && itemsInElement < contentHints.cardCount) {
            const elClasses = Array.from(el.classList).filter(c =>
              c.length > 2 &&
              !c.match(/^(aem-Grid|aem-GridColumn|col-|row-|w-|h-|p-|m-|d-)/)
            );

            // Find siblings with similar class structure
            const siblings = Array.from(parent.children).filter(sib => {
              if (sib === el) return false;
              if (sib.tagName !== el.tagName) return false;

              // Check for matching meaningful classes
              const sibClasses = Array.from(sib.classList);
              const matchingClasses = elClasses.filter(c => sibClasses.includes(c));

              // If at least one meaningful class matches, consider it a similar sibling
              return matchingClasses.length > 0;
            });

            // Generate selectors for similar siblings
            for (const sib of siblings) {
              const sibSelector = generateSelector(sib);
              if (sibSelector) {
                siblingSelectors.push(sibSelector);
              }
            }

            if (siblingSelectors.length > 0) {
              const totalItems = itemsInElement * (1 + siblingSelectors.length);
              console.log(`Found ${siblingSelectors.length} similar sibling(s), total items: ~${totalItems}`);
            }
          }
        }
      }

      return {
        selector: best.selector,
        siblingSelectors: siblingSelectors.length > 0 ? siblingSelectors : undefined,
      };
    }

    return null;
  }, block);
}
