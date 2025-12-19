import { Browser, Page } from '@cloudflare/puppeteer';
import { AnthropicConfig, NamedBlock } from './design-analyzer';

/**
 * Bounding box coordinates returned by Claude Vision
 */
export interface VisualBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX?: number; // Explicit center point for element detection
  centerY?: number;
  name: string;
  description: string;
  type: 'hero' | 'carousel' | 'cards' | 'columns' | 'tabs' | 'accordion' | 'form' | 'navigation' | 'footer' | 'content' | 'other';
  priority: 'high' | 'medium' | 'low';
}

/**
 * Result from visual block detection
 */
export interface VisualDetectionResult {
  url: string;
  title: string;
  screenshotWidth: number;
  screenshotHeight: number;
  blocks: NamedBlock[];
}

const VISUAL_BLOCK_DETECTION_PROMPT = `Analyze this full-page screenshot and identify distinct content blocks that should be converted to web components.

The screenshot dimensions are: WIDTH x HEIGHT pixels (provided below).

For each content block, provide bounding box coordinates where (0,0) is the top-left corner of the page.

IMPORTANT GUIDELINES:
1. Each block should be a SELF-CONTAINED section that can stand alone
2. For card grids: if cards are in multiple rows, treat the ENTIRE grid as ONE block (not separate rows)
3. Bounding boxes should NOT overlap - each pixel belongs to at most one block
4. Draw boxes around the OUTERMOST container of each section, not inner elements
5. Place the center point of each box on the MAIN CONTENT AREA, not on decorative elements

Focus on identifying:
- Hero sections (large background images with overlaid text/CTAs)
- Card grids (multiple cards showing products, features, categories - treat whole grid as one block)
- Multi-column content sections
- Feature/benefit sections
- Testimonial sections
- Call-to-action sections

Ignore:
- Header/navigation bars
- Footers
- Cookie banners, modals

Return a JSON array:
[
  {
    "x": 0,
    "y": 100,
    "width": 1440,
    "height": 500,
    "centerX": 720,
    "centerY": 350,
    "name": "Hero Banner",
    "description": "Full-width hero with background image and heading",
    "type": "hero",
    "priority": "high"
  },
  {
    "x": 100,
    "y": 650,
    "width": 1240,
    "height": 800,
    "centerX": 720,
    "centerY": 1050,
    "name": "Product Categories Grid",
    "description": "8 cards in 2 rows showing product categories with images",
    "type": "cards",
    "priority": "high"
  }
]

The centerX/centerY should be positioned on a meaningful content element (like text or the center of a card), NOT on empty space or background images.

Return ONLY the JSON array, no other text.`;

/**
 * Take a full-page screenshot and have Claude Vision identify content blocks
 */
export async function detectBlocksVisually(
  browser: Browser,
  url: string,
  config: AnthropicConfig
): Promise<VisualDetectionResult> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Get page title
    const title = await page.title();

    // Take full-page screenshot
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png',
    });

    // Get page dimensions
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    // Convert screenshot to base64
    const screenshotBase64 = Buffer.from(screenshot).toString('base64');

    // Send to Claude Vision for block detection
    // Note: Claude may resize the image internally, so we need to handle coordinate scaling
    const boundingBoxes = await detectBlocksWithVision(screenshotBase64, config, dimensions);

    // Calculate scale factor if Claude's coordinates don't match page dimensions
    // Claude typically returns coordinates based on the image it sees (possibly resized)
    // We'll detect this by checking if any bounding box exceeds reasonable bounds
    let scaleX = 1;
    let scaleY = 1;

    if (boundingBoxes.length > 0) {
      // Find the max x+width and y+height from Claude's response
      const maxX = Math.max(...boundingBoxes.map(b => b.x + b.width));
      const maxY = Math.max(...boundingBoxes.map(b => b.y + b.height));

      // If Claude's coordinates are significantly smaller than actual dimensions,
      // it means the image was scaled down. Calculate scale factors.
      if (maxX > 0 && maxX < dimensions.width * 0.8) {
        scaleX = dimensions.width / maxX;
        console.log(`Detected image scaling: Claude width=${maxX}, page width=${dimensions.width}, scaleX=${scaleX}`);
      }
      if (maxY > 0 && maxY < dimensions.height * 0.8) {
        scaleY = dimensions.height / maxY;
        console.log(`Detected image scaling: Claude height=${maxY}, page height=${dimensions.height}, scaleY=${scaleY}`);
      }
    }

    // Scale bounding boxes to actual page coordinates
    const scaledBoundingBoxes = boundingBoxes.map(box => ({
      ...box,
      x: Math.round(box.x * scaleX),
      y: Math.round(box.y * scaleY),
      width: Math.round(box.width * scaleX),
      height: Math.round(box.height * scaleY),
      centerX: box.centerX ? Math.round(box.centerX * scaleX) : undefined,
      centerY: box.centerY ? Math.round(box.centerY * scaleY) : undefined,
    }));

    // Map bounding boxes back to DOM elements
    const blocks = await mapBoundingBoxesToElements(page, scaledBoundingBoxes, dimensions);

    return {
      url,
      title,
      screenshotWidth: dimensions.width,
      screenshotHeight: dimensions.height,
      blocks,
    };
  } finally {
    await page.close();
  }
}

/**
 * Send screenshot to Claude Vision to identify blocks and their bounding boxes
 */
async function detectBlocksWithVision(
  screenshotBase64: string,
  config: AnthropicConfig,
  dimensions: { width: number; height: number }
): Promise<VisualBoundingBox[]> {
  // Add dimensions to the prompt
  const promptWithDimensions = VISUAL_BLOCK_DETECTION_PROMPT.replace(
    'WIDTH x HEIGHT pixels',
    `${dimensions.width} x ${dimensions.height} pixels`
  );

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
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: promptWithDimensions,
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
        max_tokens: 4096,
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
                text: promptWithDimensions,
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

  try {
    const jsonMatch = textContent.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }
    return JSON.parse(jsonMatch[0]) as VisualBoundingBox[];
  } catch (parseError) {
    console.error('Failed to parse visual detection response:', textContent.text);
    throw new Error('Failed to parse Claude response');
  }
}

/**
 * Map visual bounding boxes to actual DOM elements
 * Uses page coordinates to find elements by their bounding rect positions
 */
async function mapBoundingBoxesToElements(
  page: Page,
  boundingBoxes: VisualBoundingBox[],
  pageDimensions: { width: number; height: number }
): Promise<NamedBlock[]> {
  const blocks: NamedBlock[] = [];
  const foundSelectors = new Set<string>(); // Track selectors to avoid duplicates

  for (const box of boundingBoxes) {
    // Try multiple probe points within the bounding box
    // Start with explicit center, then try other strategic points
    const probePoints = [
      // Explicit center if provided, otherwise calculated center
      { x: box.centerX ?? (box.x + box.width / 2), y: box.centerY ?? (box.y + box.height / 2) },
      // Center of bounding box
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      // Upper third (for cards where content is at top)
      { x: box.x + box.width / 2, y: box.y + box.height / 3 },
      // Lower third
      { x: box.x + box.width / 2, y: box.y + box.height * 2 / 3 },
      // Left third
      { x: box.x + box.width / 3, y: box.y + box.height / 2 },
      // Right third
      { x: box.x + box.width * 2 / 3, y: box.y + box.height / 2 },
    ];

    console.log(`Mapping block "${box.name}" - box: ${box.x},${box.y} ${box.width}x${box.height}, trying ${probePoints.length} probe points`);

    let elementInfo = null;

    // Try each probe point until we find a valid element
    for (const probe of probePoints) {
      const centerX = probe.x;
      const centerY = probe.y;

      // Scroll to make the target area visible, then use elementFromPoint
      elementInfo = await page.evaluate(
        async ({ pageX, pageY, boxX, boxY, boxWidth, boxHeight, existingSelectors }) => {
        // Scroll to position the target area in the viewport
        window.scrollTo(0, Math.max(0, pageY - 300));

        // Wait a bit for scroll to complete
        await new Promise(resolve => setTimeout(resolve, 150));

        // Calculate viewport-relative coordinates
        const viewportY = pageY - window.scrollY;
        const viewportX = pageX;

        // Get element at the point
        let element = document.elementFromPoint(viewportX, viewportY);
        if (!element) {
          return { error: `No element at viewport point (${viewportX}, ${viewportY})` };
        }

        const initialTag = element.tagName;
        const initialClass = element.className;

        // Skip certain element types that are never good matches
        const skipTags = ['IMG', 'PICTURE', 'SOURCE', 'SVG', 'PATH', 'SPAN', 'A', 'BUTTON', 'STRONG', 'EM', 'B', 'I'];
        while (element && skipTags.includes(element.tagName)) {
          element = element.parentElement;
        }
        if (!element) {
          return { error: `Walked past all parent elements from ${initialTag}.${initialClass}` };
        }

        // Walk up to find a meaningful container that roughly matches the bounding box
        let current: Element | null = element;
        let bestMatch: Element | null = null;
        let bestMatchScore = 0;

        while (current && current !== document.body && current !== document.documentElement) {
          const rect = current.getBoundingClientRect();
          const pageTop = rect.top + window.scrollY;
          const pageLeft = rect.left + window.scrollX;

          // Calculate how well this element matches the bounding box
          const widthMatch = Math.min(rect.width, boxWidth) / Math.max(rect.width, boxWidth);
          const heightMatch = Math.min(rect.height, boxHeight) / Math.max(rect.height, boxHeight);

          // Also check position overlap
          const topDiff = Math.abs(pageTop - boxY) / boxHeight;
          const leftDiff = Math.abs(pageLeft - boxX) / boxWidth;
          const positionScore = Math.max(0, 1 - (topDiff + leftDiff) / 2);

          // Combined score: size match + position match
          const score = (widthMatch + heightMatch + positionScore) / 3;

          // Element must be at least 30% of expected size and position must be reasonable
          if (score > bestMatchScore &&
              rect.width >= boxWidth * 0.3 &&
              rect.height >= boxHeight * 0.2 &&
              topDiff < 1.5 && leftDiff < 1.5) {
            bestMatch = current;
            bestMatchScore = score;

            // If we found a very good match (>70%), stop searching
            if (score > 0.7) break;
          }

          current = current.parentElement;
        }

        if (!bestMatch) bestMatch = element;

        const matchInfo = `${bestMatch.tagName}.${Array.from(bestMatch.classList).join('.')} score=${bestMatchScore.toFixed(2)}`;

        // Generate a unique selector for the best match
        function generateSelector(el: Element): string | null {
          // Try ID first
          if (el.id && !el.id.match(/^\d/)) { // Skip IDs that start with numbers
            const selector = `#${CSS.escape(el.id)}`;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }

          // Try unique class combination (skip utility classes)
          if (el.classList.length > 0) {
            const meaningfulClasses = Array.from(el.classList)
              .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|flex|grid|col-|row-)/));
            if (meaningfulClasses.length > 0) {
              const classes = meaningfulClasses.map(c => `.${CSS.escape(c)}`).join('');
              if (document.querySelectorAll(classes).length === 1) {
                return classes;
              }
            }
          }

          // Try tag + classes
          if (el.classList.length > 0) {
            const selector = el.tagName.toLowerCase() + Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }

          // Try semantic tags with position
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            const index = siblings.indexOf(el) + 1;

            let parentSelector = '';
            if (parent.id && !parent.id.match(/^\d/)) {
              parentSelector = `#${CSS.escape(parent.id)}`;
            } else if (parent.classList.length > 0) {
              const meaningfulClasses = Array.from(parent.classList)
                .filter(c => c.length > 2 && !c.match(/^(mt-|mb-|px-|py-|flex|grid|col-|row-)/));
              if (meaningfulClasses.length > 0) {
                parentSelector = meaningfulClasses.map(c => `.${CSS.escape(c)}`).join('');
              }
            }

            if (!parentSelector && ['MAIN', 'ARTICLE', 'SECTION', 'BODY'].includes(parent.tagName)) {
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
          const dataAttrs = Array.from(el.attributes).filter(a => a.name.startsWith('data-') && a.value);
          for (const attr of dataAttrs) {
            const selector = `[${attr.name}="${CSS.escape(attr.value)}"]`;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }

          return null;
        }

        const selector = generateSelector(bestMatch);
        if (!selector) {
          return { error: `Could not generate unique selector for ${matchInfo}` };
        }

        // Verify selector matches exactly one element
        if (document.querySelectorAll(selector).length !== 1) {
          return { error: `Selector "${selector}" matches ${document.querySelectorAll(selector).length} elements` };
        }

        // Skip if this selector is already used or is a child of an existing selector
        for (const existingSel of existingSelectors) {
          try {
            const existingEl = document.querySelector(existingSel);
            if (existingEl && (existingEl.contains(bestMatch) || bestMatch.contains(existingEl))) {
              return { error: `Selector "${selector}" overlaps with existing "${existingSel}"` };
            }
          } catch (e) {
            // Ignore invalid selectors
          }
        }

        return {
          selector,
          tagName: bestMatch.tagName.toLowerCase(),
          classes: Array.from(bestMatch.classList),
          id: bestMatch.id || null,
          matchInfo,
        };
      },
      {
        pageX: centerX,
        pageY: centerY,
        boxX: box.x,
        boxY: box.y,
        boxWidth: box.width,
        boxHeight: box.height,
        existingSelectors: Array.from(foundSelectors)
      }
    );

      // If we found a valid element, stop trying other probe points
      if (elementInfo && 'selector' in elementInfo && elementInfo.selector) {
        console.log(`Found element for "${box.name}" at probe (${centerX}, ${centerY}): ${elementInfo.selector} [${elementInfo.matchInfo}]`);
        break;
      } else if (elementInfo && 'error' in elementInfo) {
        console.log(`Probe (${centerX}, ${centerY}) failed: ${elementInfo.error}`);
      }
    } // End of probe points loop

    if (elementInfo && 'selector' in elementInfo && elementInfo.selector) {
      // Check for duplicates
      if (!foundSelectors.has(elementInfo.selector)) {
        foundSelectors.add(elementInfo.selector);
        blocks.push({
          selector: elementInfo.selector,
          name: box.name,
          description: box.description,
          type: box.type,
          priority: box.priority,
        });
      } else {
        console.warn(`Duplicate selector skipped for block "${box.name}": ${elementInfo.selector}`);
      }
    } else {
      console.warn(`Could not find DOM element for block "${box.name}" after trying ${probePoints.length} probe points`);
    }
  }

  return blocks;
}
