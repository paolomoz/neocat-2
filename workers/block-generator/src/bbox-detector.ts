import { Page } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Bounding box for a detected block
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Block detected using bounding boxes - no selectors needed
 */
export interface DetectedBlock {
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'columns' | 'carousel' | 'tabs' | 'accordion' | 'form' | 'content' | 'other';
  priority: 'high' | 'medium' | 'low';
  boundingBox: BoundingBox;
  html: string;
}

/**
 * Result of page analysis
 */
export interface PageAnalysisResult {
  title: string;
  blocks: DetectedBlock[];
  fullScreenshot: string; // Base64 encoded full page screenshot
  pageWidth: number;
  pageHeight: number;
}

/**
 * Simple bounding-box based block detection
 * 1. Take full page screenshot
 * 2. Claude identifies blocks with bounding boxes
 * 3. Extract HTML from each region using elementFromPoint
 */
export async function detectBlocks(
  page: Page,
  url: string,
  config: AnthropicConfig
): Promise<PageAnalysisResult> {
  // Navigate and wait for page load
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  // Get page title
  const title = await page.title();

  // Take full page screenshot
  const screenshotBuffer = await page.screenshot({
    fullPage: true,
    type: 'png',
  }) as Buffer;
  const fullScreenshot = screenshotBuffer.toString('base64');

  // Get page dimensions
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  // Ask Claude to identify blocks with bounding boxes
  const claudeBlocks = await identifyBlocksWithClaude(
    fullScreenshot,
    dimensions.width,
    dimensions.height,
    config
  );

  console.log(`Claude identified ${claudeBlocks.length} blocks`);

  // For each block, extract HTML from the bounding box region
  const blocks: DetectedBlock[] = [];

  for (const block of claudeBlocks) {
    console.log(`Extracting HTML for: ${block.name}`);

    const html = await extractHtmlFromRegion(page, block.boundingBox);

    if (html) {
      blocks.push({
        ...block,
        html,
      });
      console.log(`  Extracted ${html.length} chars of HTML`);
    } else {
      console.log(`  Could not extract HTML for region`);
    }
  }

  return {
    title,
    blocks,
    fullScreenshot,
    pageWidth: dimensions.width,
    pageHeight: dimensions.height,
  };
}

/**
 * Ask Claude to identify content blocks with bounding boxes
 */
async function identifyBlocksWithClaude(
  screenshotBase64: string,
  pageWidth: number,
  pageHeight: number,
  config: AnthropicConfig
): Promise<Omit<DetectedBlock, 'html'>[]> {
  const prompt = `Analyze this webpage screenshot and identify the main content blocks.

For each distinct content block (hero, cards, features, testimonials, etc.), provide:
1. A descriptive name
2. Brief description of contents
3. Block type (hero, cards, columns, carousel, tabs, accordion, form, content, other)
4. Priority (high for above-fold/key content, medium for secondary, low for footer/minor)
5. Bounding box coordinates (x, y, width, height) in pixels

The page dimensions are: ${pageWidth}px wide × ${pageHeight}px tall

Return JSON array:
[
  {
    "name": "Hero Banner",
    "description": "Full-width hero with background image and headline",
    "type": "hero",
    "priority": "high",
    "boundingBox": { "x": 0, "y": 80, "width": 1440, "height": 500 }
  },
  {
    "name": "Product Cards Grid",
    "description": "4-column grid of product cards with images and titles",
    "type": "cards",
    "priority": "medium",
    "boundingBox": { "x": 100, "y": 600, "width": 1240, "height": 400 }
  }
]

Important:
- Only identify meaningful content blocks, not navigation/header/footer
- Bounding boxes should tightly wrap each block
- Coordinates are relative to top-left of page (0,0)
- Be precise with coordinates based on what you see

Return ONLY the JSON array.`;

  const response = await callClaude(screenshotBase64, prompt, config);

  try {
    // Parse JSON response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('No JSON array found in Claude response');
      return [];
    }

    const blocks = JSON.parse(jsonMatch[0]);
    return blocks.map((b: any) => ({
      name: b.name || 'Unnamed Block',
      description: b.description || '',
      type: b.type || 'content',
      priority: b.priority || 'medium',
      boundingBox: {
        x: Math.round(b.boundingBox?.x || 0),
        y: Math.round(b.boundingBox?.y || 0),
        width: Math.round(b.boundingBox?.width || 100),
        height: Math.round(b.boundingBox?.height || 100),
      },
    }));
  } catch (e) {
    console.error('Failed to parse Claude response:', e);
    return [];
  }
}

/**
 * Extract HTML from a bounding box region using elementFromPoint
 */
async function extractHtmlFromRegion(
  page: Page,
  bbox: BoundingBox
): Promise<string | null> {
  return await page.evaluate((box: BoundingBox) => {
    // Find element at center of bounding box
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // Scroll to make sure the element is in view for elementFromPoint
    window.scrollTo(0, Math.max(0, box.y - 100));

    const element = document.elementFromPoint(
      centerX - window.scrollX,
      centerY - window.scrollY + 100 // Adjust for scroll offset
    );

    if (!element) {
      // Try multiple points if center fails
      const points = [
        [box.x + box.width * 0.25, box.y + box.height * 0.25],
        [box.x + box.width * 0.75, box.y + box.height * 0.25],
        [box.x + box.width * 0.25, box.y + box.height * 0.75],
        [box.x + box.width * 0.75, box.y + box.height * 0.75],
      ];

      for (const [px, py] of points) {
        window.scrollTo(0, Math.max(0, py - 100));
        const el = document.elementFromPoint(px - window.scrollX, py - window.scrollY + 100);
        if (el && el !== document.body && el !== document.documentElement) {
          return findBestContainer(el, box).outerHTML;
        }
      }
      return null;
    }

    return findBestContainer(element, box).outerHTML;

    /**
     * Walk up the DOM to find the best container that covers the bounding box
     */
    function findBestContainer(el: Element, targetBox: typeof box): Element {
      let current = el;
      let best = el;
      let bestOverlap = 0;

      // Walk up to find element that best covers the bounding box
      while (current && current !== document.body && current !== document.documentElement) {
        const rect = current.getBoundingClientRect();
        const scrollY = window.scrollY;

        // Convert to page coordinates
        const elBox = {
          x: rect.left + window.scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
        };

        // Calculate overlap with target bounding box
        const overlapX = Math.max(0, Math.min(elBox.x + elBox.width, targetBox.x + targetBox.width) - Math.max(elBox.x, targetBox.x));
        const overlapY = Math.max(0, Math.min(elBox.y + elBox.height, targetBox.y + targetBox.height) - Math.max(elBox.y, targetBox.y));
        const overlapArea = overlapX * overlapY;
        const targetArea = targetBox.width * targetBox.height;
        const overlapRatio = overlapArea / targetArea;

        // Check if this element is a good fit (covers most of target, not too much bigger)
        const elArea = elBox.width * elBox.height;
        const sizeRatio = elArea / targetArea;

        if (overlapRatio > 0.7 && sizeRatio < 3 && overlapRatio > bestOverlap) {
          best = current;
          bestOverlap = overlapRatio;
        }

        // Stop if we're getting too big
        if (sizeRatio > 5) break;

        current = current.parentElement!;
      }

      return best;
    }
  }, bbox);
}

/**
 * Crop a base64 screenshot to a bounding box
 * Note: This is a placeholder - actual cropping would need canvas or sharp
 * For now, we'll re-take a screenshot of just that region
 */
export async function captureBlockScreenshot(
  page: Page,
  bbox: BoundingBox
): Promise<string> {
  // Set clip to bounding box and take screenshot
  const screenshotBuffer = await page.screenshot({
    clip: {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
    },
    type: 'png',
  }) as Buffer;

  return screenshotBuffer.toString('base64');
}

/**
 * Helper to call Claude API
 */
async function callClaude(
  imageBase64: string,
  prompt: string,
  config: AnthropicConfig,
  maxTokens: number = 4096
): Promise<string> {
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
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
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
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
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

  return textContent.text;
}
