import { Browser } from '@cloudflare/puppeteer';
import { AnthropicConfig, NamedBlock } from './design-analyzer';

/**
 * Candidate element found in the DOM
 */
interface DOMCandidate {
  index: number;
  selector: string;
  tagName: string;
  classes: string[];
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  textPreview: string;
  hasImages: boolean;
  hasHeadings: boolean;
  childCount: number;
}

/**
 * Result from annotated detection
 */
export interface AnnotatedDetectionResult {
  url: string;
  title: string;
  blocks: NamedBlock[];
}

/**
 * Main detection function using annotated screenshot approach
 *
 * 1. Find candidate elements from DOM
 * 2. Get their bounding boxes and generate selectors
 * 3. Send screenshot + numbered region list to Claude
 * 4. Claude identifies which regions are content blocks
 * 5. Return blocks with verified selectors
 */
export async function detectBlocksAnnotated(
  browser: Browser,
  url: string,
  config: AnthropicConfig
): Promise<AnnotatedDetectionResult> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const title = await page.title();

    // Step 1: Find all candidate elements and their bounding boxes
    const candidates = await findCandidateElements(page);
    console.log(`Found ${candidates.length} candidate elements`);

    if (candidates.length === 0) {
      return { url, title, blocks: [] };
    }

    // Step 2: Take full-page screenshot
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png',
    });
    const screenshotBase64 = Buffer.from(screenshot).toString('base64');

    // Step 3: Send to Claude with region descriptions
    const selectedIndices = await askClaudeToSelectBlocks(
      screenshotBase64,
      candidates,
      config
    );
    console.log(`Claude selected blocks: ${selectedIndices.join(', ')}`);

    // Step 4: Get Claude to name the selected blocks
    const selectedCandidates = candidates.filter(c => selectedIndices.includes(c.index));
    const namedBlocks = await nameSelectedBlocks(selectedCandidates, config);

    return {
      url,
      title,
      blocks: namedBlocks,
    };
  } finally {
    await page.close();
  }
}

/**
 * Find candidate container elements from the DOM
 */
async function findCandidateElements(page: any): Promise<DOMCandidate[]> {
  return await page.evaluate(() => {
    const candidates: DOMCandidate[] = [];
    const seen = new Set<Element>();
    let index = 0;

    /**
     * Generate a unique CSS selector for an element
     */
    function generateSelector(el: Element): string | null {
      // Try ID first
      if (el.id && !el.id.match(/^\d/)) {
        const selector = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      // Try unique class combination
      if (el.classList.length > 0) {
        const meaningfulClasses = Array.from(el.classList)
          .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|mx-|my-|flex|grid|col-|row-|w-|h-|text-|bg-|p-|m-)/));
        if (meaningfulClasses.length > 0) {
          const classes = meaningfulClasses.map(c => `.${CSS.escape(c)}`).join('');
          if (document.querySelectorAll(classes).length === 1) {
            return classes;
          }
        }
      }

      // Try tag + all classes
      if (el.classList.length > 0) {
        const selector = el.tagName.toLowerCase() + Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      // Try parent context with nth-of-type
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        const idx = siblings.indexOf(el) + 1;

        let parentSelector = '';
        if (parent.id && !parent.id.match(/^\d/)) {
          parentSelector = `#${CSS.escape(parent.id)}`;
        } else if (parent.tagName === 'MAIN' || parent.tagName === 'BODY') {
          parentSelector = parent.tagName.toLowerCase();
        } else if (parent.classList.length > 0) {
          const pClasses = Array.from(parent.classList)
            .filter(c => c.length > 2)
            .slice(0, 2)
            .map(c => `.${CSS.escape(c)}`).join('');
          if (pClasses && document.querySelectorAll(pClasses).length === 1) {
            parentSelector = pClasses;
          }
        }

        if (parentSelector) {
          const selector = `${parentSelector} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }

      // Try data attributes
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-') && attr.value) {
          const selector = `[${attr.name}="${CSS.escape(attr.value)}"]`;
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }

      return null;
    }

    /**
     * Check if element is a valid candidate
     */
    function isValidCandidate(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();

      // Must be visible and reasonably sized
      if (rect.width < 300 || rect.height < 100) return false;
      if (rect.top + window.scrollY < 0) return false;

      // Skip navigation, header, footer, aside
      if (['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript'].includes(tag)) return false;

      // Skip elements that are too tall (likely page wrappers)
      const pageHeight = document.documentElement.scrollHeight;
      if (rect.height > pageHeight * 0.8) return false;

      // Skip obvious wrappers with single child that's similar size
      if (el.children.length === 1) {
        const child = el.children[0];
        const childRect = child.getBoundingClientRect();
        if (childRect.height > rect.height * 0.9 && childRect.width > rect.width * 0.9) {
          return false;
        }
      }

      // Must have some content
      const text = el.textContent?.trim() || '';
      if (text.length < 30) return false;

      // Check for meaningful structure
      const hasImages = el.querySelector('img, picture, video, svg') !== null;
      const hasHeadings = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
      const hasText = el.querySelector('p, span, li') !== null;

      return hasImages || hasHeadings || hasText;
    }

    /**
     * Add candidate if valid and not seen
     */
    function addCandidate(el: Element) {
      if (seen.has(el)) return;
      if (!isValidCandidate(el)) return;

      const selector = generateSelector(el);
      if (!selector) return;

      // Verify selector
      if (document.querySelectorAll(selector).length !== 1) return;

      seen.add(el);
      const rect = el.getBoundingClientRect();

      candidates.push({
        index: index++,
        selector,
        tagName: el.tagName.toLowerCase(),
        classes: Array.from(el.classList),
        boundingBox: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        textPreview: (el.textContent || '').trim().substring(0, 100),
        hasImages: el.querySelector('img, picture, video') !== null,
        hasHeadings: el.querySelector('h1, h2, h3, h4, h5, h6') !== null,
        childCount: el.children.length,
      });
    }

    // Strategy 1: Direct children of main/body that are sections or divs
    document.querySelectorAll('main > section, main > div, main > article, body > main > *, [role="main"] > *').forEach(addCandidate);

    // Strategy 2: Semantic sections and articles anywhere
    document.querySelectorAll('section, article').forEach(addCandidate);

    // Strategy 3: Common CMS patterns
    document.querySelectorAll(`
      [class*="hero"], [class*="banner"],
      [class*="carousel"], [class*="slider"],
      [class*="cards"], [class*="card-grid"],
      [class*="features"], [class*="benefits"],
      [class*="testimonial"], [class*="review"],
      [class*="cta"], [class*="call-to-action"],
      [class*="content-block"], [class*="block-"],
      [class*="-section"], [class*="section-"],
      [data-component], [data-block], [data-module]
    `).forEach(addCandidate);

    // Strategy 4: Large divs with multiple children
    document.querySelectorAll('div').forEach(el => {
      if (el.children.length >= 2) {
        const rect = el.getBoundingClientRect();
        if (rect.height >= 200 && rect.width >= 600) {
          addCandidate(el);
        }
      }
    });

    // Remove nested candidates - keep outermost unless inner is very different
    const filtered = candidates.filter(c => {
      const el = document.querySelector(c.selector);
      if (!el) return false;

      // Check if this element is contained in another candidate
      for (const other of candidates) {
        if (other.index === c.index) continue;
        const otherEl = document.querySelector(other.selector);
        if (otherEl && otherEl.contains(el) && otherEl !== el) {
          // Keep inner only if it's significantly smaller (not just a thin wrapper)
          const sizeRatio = (c.boundingBox.width * c.boundingBox.height) /
                           (other.boundingBox.width * other.boundingBox.height);
          if (sizeRatio > 0.7) {
            return false; // Too similar in size, prefer outer
          }
        }
      }
      return true;
    });

    // Sort by position (top to bottom)
    filtered.sort((a, b) => a.boundingBox.y - b.boundingBox.y);

    // Re-index after filtering
    return filtered.map((c, i) => ({ ...c, index: i + 1 }));
  });
}

/**
 * Build the prompt for Claude to select blocks
 */
function buildSelectionPrompt(candidates: DOMCandidate[]): string {
  const regionList = candidates.map(c => {
    return `Region ${c.index}: Position (${c.boundingBox.x}, ${c.boundingBox.y}), Size ${c.boundingBox.width}x${c.boundingBox.height}px, Tag: ${c.tagName}, Has images: ${c.hasImages}, Has headings: ${c.hasHeadings}`;
  }).join('\n');

  return `Look at this webpage screenshot. I've identified ${candidates.length} candidate regions that might be content blocks.

Here are the regions with their positions (x, y from top-left) and sizes:

${regionList}

Select which regions are MEANINGFUL CONTENT BLOCKS that should be converted to reusable web components.

Include:
- Hero sections (large banners with images/text)
- Card grids (multiple cards showing products, features, categories)
- Feature/benefit sections
- Testimonial sections
- Call-to-action sections
- Content sections with text and images

Exclude:
- Navigation/headers
- Footers
- Cookie banners
- Empty containers
- Page wrappers that contain multiple distinct sections

Return ONLY a JSON array of region numbers, like: [1, 3, 5]

If a region is a CONTAINER that holds multiple distinct content blocks, exclude it and include its children instead.`;
}

/**
 * Ask Claude to select which regions are content blocks
 */
async function askClaudeToSelectBlocks(
  screenshotBase64: string,
  candidates: DOMCandidate[],
  config: AnthropicConfig
): Promise<number[]> {
  const prompt = buildSelectionPrompt(candidates);

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
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
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
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
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

  // Parse the JSON array of indices
  const match = textContent.text.match(/\[[\d,\s]*\]/);
  if (!match) {
    console.error('Could not parse selection response:', textContent.text);
    return [];
  }

  try {
    return JSON.parse(match[0]) as number[];
  } catch {
    console.error('Failed to parse JSON:', match[0]);
    return [];
  }
}

/**
 * Get Claude to name and describe the selected blocks
 */
async function nameSelectedBlocks(
  candidates: DOMCandidate[],
  config: AnthropicConfig
): Promise<NamedBlock[]> {
  if (candidates.length === 0) return [];

  const prompt = `Based on these content blocks from a webpage, provide a name, description, and type for each.

Blocks:
${candidates.map(c => `- Selector: ${c.selector}
  Size: ${c.boundingBox.width}x${c.boundingBox.height}px
  Has images: ${c.hasImages}, Has headings: ${c.hasHeadings}
  Text preview: "${c.textPreview}"`).join('\n\n')}

Return a JSON array with one object per block:
[
  {
    "selector": "(copy from above)",
    "name": "Hero Banner",
    "description": "Full-width hero with background image and CTA",
    "type": "hero",
    "priority": "high"
  }
]

Types: hero, carousel, cards, columns, tabs, accordion, form, content, other
Priority: high (main content), medium (supporting), low (minor)

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
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
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
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
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
    // Fallback to basic naming
    return candidates.map((c, i) => ({
      selector: c.selector,
      name: c.hasImages && c.hasHeadings ? 'Content Section' : c.hasImages ? 'Media Section' : 'Text Section',
      description: c.textPreview,
      type: 'content' as const,
      priority: i === 0 ? 'high' as const : 'medium' as const,
    }));
  }

  try {
    const match = textContent.text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    return JSON.parse(match[0]) as NamedBlock[];
  } catch {
    console.error('Failed to parse naming response:', textContent.text);
    return candidates.map((c, i) => ({
      selector: c.selector,
      name: 'Content Block',
      description: c.textPreview,
      type: 'content' as const,
      priority: i === 0 ? 'high' as const : 'medium' as const,
    }));
  }
}
