import { Page } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Candidate block extracted from DOM with real coordinates
 */
export interface CandidateBlock {
  index: number;
  tagName: string;
  className: string;
  id: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  html: string;
  textPreview: string;
  hasImages: boolean;
  hasHeadings: boolean;
}

/**
 * Classified block after Claude analysis
 */
export interface ClassifiedBlock {
  index: number;
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'columns' | 'carousel' | 'tabs' | 'accordion' | 'form' | 'content' | 'navigation' | 'footer' | 'other';
  priority: 'high' | 'medium' | 'low';
  shouldInclude: boolean;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  html: string;
}

/**
 * Result of hybrid detection
 */
export interface HybridDetectionResult {
  title: string;
  blocks: ClassifiedBlock[];
  fullScreenshot: string;
  annotatedScreenshot: string;
  pageWidth: number;
  pageHeight: number;
}

/**
 * Hybrid block detection:
 * 1. Extract candidate blocks from DOM with real coordinates
 * 2. Take screenshot with numbered overlays
 * 3. Claude classifies numbered regions
 */
export async function detectBlocksHybrid(
  page: Page,
  url: string,
  config: AnthropicConfig
): Promise<HybridDetectionResult> {
  // Navigate and wait for page load
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  const title = await page.title();

  // Get page dimensions
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  // Step 1: Extract candidate blocks from DOM
  console.log('Step 1: Extracting candidate blocks from DOM...');
  const candidates = await extractCandidateBlocks(page);
  console.log(`Found ${candidates.length} candidate blocks`);

  // Take clean full page screenshot first (limit height to avoid memory issues)
  const maxHeight = Math.min(dimensions.height, 8000);
  let fullScreenshot: string;
  try {
    const fullScreenshotBuffer = await page.screenshot({
      clip: { x: 0, y: 0, width: dimensions.width, height: maxHeight },
      type: 'png',
    }) as Buffer;
    fullScreenshot = fullScreenshotBuffer.toString('base64');
  } catch (e) {
    console.error('Failed to capture full screenshot, using viewport only:', e);
    const viewportBuffer = await page.screenshot({ type: 'png' }) as Buffer;
    fullScreenshot = viewportBuffer.toString('base64');
  }

  // Step 2: Add numbered overlays to page and take annotated screenshot
  console.log('Step 2: Adding numbered overlays...');
  await addNumberedOverlays(page, candidates);

  let annotatedScreenshot: string;
  try {
    const annotatedScreenshotBuffer = await page.screenshot({
      clip: { x: 0, y: 0, width: dimensions.width, height: maxHeight },
      type: 'png',
    }) as Buffer;
    annotatedScreenshot = annotatedScreenshotBuffer.toString('base64');
  } catch (e) {
    console.error('Failed to capture annotated screenshot:', e);
    annotatedScreenshot = fullScreenshot; // Fallback to clean screenshot
  }

  // Remove overlays
  await removeOverlays(page);

  // Step 3: Have Claude classify the numbered regions
  console.log('Step 3: Claude classifying numbered regions...');
  const classifications = await classifyWithClaude(
    annotatedScreenshot,
    candidates,
    config
  );

  // Merge classifications with candidate data
  const blocks: ClassifiedBlock[] = [];
  for (const classification of classifications) {
    const candidate = candidates.find(c => c.index === classification.index);
    if (candidate && classification.shouldInclude) {
      blocks.push({
        ...classification,
        boundingBox: candidate.boundingBox,
        html: candidate.html,
      });
    }
  }

  console.log(`Final: ${blocks.length} blocks after classification`);

  return {
    title,
    blocks,
    fullScreenshot,
    annotatedScreenshot,
    pageWidth: dimensions.width,
    pageHeight: dimensions.height,
  };
}

/**
 * Extract candidate blocks from DOM with real bounding boxes
 * Simple approach: find all significant elements, let Claude filter
 */
async function extractCandidateBlocks(page: Page): Promise<CandidateBlock[]> {
  return await page.evaluate(() => {
    const candidates: CandidateBlock[] = [];
    const minHeight = 80;
    const maxElements = 20;

    const viewportWidth = window.innerWidth;
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    // Collect ALL potential block elements
    const allElements = document.querySelectorAll('section, article, div[class], main > *');
    const potentialBlocks: Array<{el: Element, rect: DOMRect, score: number}> = [];

    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const className = (el.className || '').toString().toLowerCase();

      // Skip hidden elements
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (rect.height < minHeight || rect.width < 200) continue;

      // Skip obvious non-content
      if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'script' || tag === 'style') continue;
      if (className.includes('cookie') || className.includes('modal') || className.includes('popup')) continue;

      // Calculate a "section score" based on characteristics
      let score = 0;

      // Prefer wider elements (likely sections)
      if (rect.width >= viewportWidth * 0.9) score += 30;
      else if (rect.width >= viewportWidth * 0.7) score += 20;
      else if (rect.width >= viewportWidth * 0.5) score += 10;

      // Prefer taller elements
      if (rect.height >= 300) score += 20;
      else if (rect.height >= 150) score += 10;

      // Prefer semantic elements
      if (tag === 'section' || tag === 'article') score += 25;

      // Prefer section-like class names
      if (className.includes('section')) score += 20;
      if (className.includes('hero') || className.includes('banner')) score += 20;
      if (className.includes('container') && !className.includes('card')) score += 10;
      if (className.includes('block') && !className.includes('card')) score += 10;

      // Penalize card-like elements
      if (className.includes('card') && !className.includes('cards')) score -= 15;
      if (className.includes('item') && !className.includes('items')) score -= 15;
      if (className.includes('teaser')) score -= 15;

      // Penalize nav/footer-like
      if (className.includes('nav') || className.includes('menu')) score -= 30;
      if (className.includes('footer')) score -= 30;
      if (className.includes('header') && !className.includes('hero')) score -= 20;

      // Need minimum score to be considered
      if (score < 10) continue;

      potentialBlocks.push({ el, rect, score });
    }

    // Sort by vertical position, then by score
    potentialBlocks.sort((a, b) => {
      const yDiff = a.rect.top - b.rect.top;
      if (Math.abs(yDiff) > 50) return yDiff;  // Different vertical position
      return b.score - a.score;  // Same position, prefer higher score
    });

    // Filter to non-overlapping blocks
    const selected: Array<{el: Element, rect: DOMRect}> = [];

    for (const block of potentialBlocks) {
      if (selected.length >= maxElements) break;

      // Check for significant overlap with already selected
      const hasOverlap = selected.some(s => {
        const overlapX = Math.max(0, Math.min(s.rect.right, block.rect.right) - Math.max(s.rect.left, block.rect.left));
        const overlapY = Math.max(0, Math.min(s.rect.bottom, block.rect.bottom) - Math.max(s.rect.top, block.rect.top));
        const overlapArea = overlapX * overlapY;
        const blockArea = block.rect.width * block.rect.height;
        const selectedArea = s.rect.width * s.rect.height;
        // Significant overlap = more than 50% of the smaller element
        return overlapArea > Math.min(blockArea, selectedArea) * 0.5;
      });

      if (!hasOverlap) {
        selected.push(block);
      }
    }

    // Build candidate list
    let index = 1;
    for (const { el, rect } of selected) {
      el.setAttribute('data-candidate-index', String(index));

      const textContent = (el.textContent || '').trim();

      candidates.push({
        index,
        tagName: el.tagName.toLowerCase(),
        className: (el.className || '').toString(),
        id: el.id || '',
        boundingBox: {
          x: Math.round(rect.left + scrollX),
          y: Math.round(rect.top + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        html: el.outerHTML,
        textPreview: textContent.substring(0, 200),
        hasImages: el.querySelectorAll('img').length > 0,
        hasHeadings: el.querySelectorAll('h1, h2, h3, h4').length > 0,
      });

      index++;
    }

    // Sort final list by vertical position
    candidates.sort((a, b) => a.boundingBox.y - b.boundingBox.y);
    candidates.forEach((c, i) => { c.index = i + 1; });

    return candidates;
  });
}

/**
 * Add numbered overlay badges to the page
 */
async function addNumberedOverlays(page: Page, candidates: CandidateBlock[]): Promise<void> {
  await page.evaluate((blocks) => {
    // Add overlay container
    const container = document.createElement('div');
    container.id = 'block-detector-overlays';
    container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 999999;';
    document.body.appendChild(container);

    for (const block of blocks) {
      // Create border overlay
      const border = document.createElement('div');
      border.style.cssText = `
        position: absolute;
        left: ${block.boundingBox.x}px;
        top: ${block.boundingBox.y}px;
        width: ${block.boundingBox.width}px;
        height: ${block.boundingBox.height}px;
        border: 3px solid #e63946;
        background: rgba(230, 57, 70, 0.1);
        box-sizing: border-box;
      `;
      container.appendChild(border);

      // Create number badge
      const badge = document.createElement('div');
      badge.style.cssText = `
        position: absolute;
        left: ${block.boundingBox.x}px;
        top: ${block.boundingBox.y}px;
        background: #e63946;
        color: white;
        font-family: Arial, sans-serif;
        font-size: 24px;
        font-weight: bold;
        padding: 8px 16px;
        border-radius: 0 0 8px 0;
        z-index: 1000000;
      `;
      badge.textContent = String(block.index);
      container.appendChild(badge);
    }
  }, candidates);
}

/**
 * Remove overlay elements from page
 */
async function removeOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.getElementById('block-detector-overlays');
    if (container) container.remove();

    // Remove data attributes
    document.querySelectorAll('[data-candidate-index]').forEach(el => {
      el.removeAttribute('data-candidate-index');
    });
  });
}

/**
 * Have Claude classify the numbered regions
 */
async function classifyWithClaude(
  screenshotBase64: string,
  candidates: CandidateBlock[],
  config: AnthropicConfig
): Promise<Array<{
  index: number;
  name: string;
  description: string;
  type: string;
  priority: string;
  shouldInclude: boolean;
}>> {
  const candidateList = candidates.map(c =>
    `${c.index}. ${c.tagName} (${c.boundingBox.width}x${c.boundingBox.height}px) - ${c.hasImages ? 'has images' : 'no images'}, ${c.hasHeadings ? 'has headings' : 'no headings'}`
  ).join('\n');

  const prompt = `Look at this webpage screenshot with numbered red boxes marking potential content blocks.

NUMBERED REGIONS:
${candidateList}

For each numbered region, classify it:

1. **Name**: Descriptive name (e.g., "Hero Banner", "Product Cards Grid")
2. **Description**: Brief description of contents
3. **Type**: hero, cards, columns, carousel, tabs, accordion, form, content, navigation, footer, other
4. **Priority**: high (above fold, key content), medium (secondary), low (footer, minor)
5. **shouldInclude**: true if this is a meaningful content block worth converting to an EDS block, false if it's navigation, footer, duplicated, or not useful

Return JSON array:
[
  {
    "index": 1,
    "name": "Hero Banner",
    "description": "Full-width hero with holiday messaging",
    "type": "hero",
    "priority": "high",
    "shouldInclude": true
  },
  {
    "index": 2,
    "name": "Main Navigation",
    "description": "Site navigation menu",
    "type": "navigation",
    "priority": "low",
    "shouldInclude": false
  }
]

Important:
- Set shouldInclude=false for navigation, headers, footers, cookie banners, and duplicated content
- Set shouldInclude=true for hero sections, card grids, feature sections, content blocks worth migrating
- Look at what's INSIDE each numbered box to determine what it contains

Return ONLY the JSON array.`;

  const response = await callClaude(screenshotBase64, prompt, config);

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('No JSON array found in Claude response');
      return [];
    }

    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Failed to parse Claude classification:', e);
    return [];
  }
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
