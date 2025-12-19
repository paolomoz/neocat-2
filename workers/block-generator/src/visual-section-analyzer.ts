import { Page, ElementHandle } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Section candidate extracted from DOM
 */
interface SectionCandidate {
  index: number;
  selector: string;
  tagName: string;
  className: string;
  id: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  screenshot: string; // base64
  html: string;
}

/**
 * Classified section from Claude
 */
export interface AnalyzedSection {
  index: number;
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'columns' | 'content' | 'cta' | 'news' | 'footer' | 'navigation' | 'other';
  priority: 'high' | 'medium' | 'low';
  selector: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  screenshot: string;
  html: string;
}

/**
 * Result of visual section analysis
 */
export interface VisualAnalysisResult {
  title: string;
  sections: AnalyzedSection[];
  screenshot: string; // full page screenshot
  pageWidth: number;
  pageHeight: number;
}

/**
 * Analyze page sections using element-based approach
 *
 * 1. Query DOM for section candidates
 * 2. Take element screenshots directly (no bounding box math)
 * 3. Claude classifies each element screenshot
 */
export async function analyzePageSections(
  page: Page,
  url: string,
  config: AnthropicConfig
): Promise<VisualAnalysisResult> {
  // Navigate and wait for page load
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  const title = await page.title();

  // Get page dimensions
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  // Take full page screenshot for reference
  const maxHeight = Math.min(dimensions.height, 8000);
  let fullScreenshot: string;
  try {
    const screenshotBuffer = await page.screenshot({
      clip: { x: 0, y: 0, width: dimensions.width, height: maxHeight },
      type: 'png',
    }) as Buffer;
    fullScreenshot = screenshotBuffer.toString('base64');
  } catch (e) {
    console.error('Failed to capture full screenshot:', e);
    const viewportBuffer = await page.screenshot({ type: 'png' }) as Buffer;
    fullScreenshot = viewportBuffer.toString('base64');
  }

  // Step 1: Find section candidates from DOM
  console.log('Step 1: Finding section candidates from DOM...');
  const candidates = await findSectionCandidates(page, dimensions);
  console.log(`Found ${candidates.length} section candidates`);

  if (candidates.length === 0) {
    return {
      title,
      sections: [],
      screenshot: fullScreenshot,
      pageWidth: dimensions.width,
      pageHeight: dimensions.height,
    };
  }

  // Step 2: Take screenshots of each candidate
  console.log('Step 2: Taking element screenshots...');
  const candidatesWithScreenshots = await takeElementScreenshots(page, candidates);
  console.log(`Captured ${candidatesWithScreenshots.length} element screenshots`);

  // Step 3: Claude classifies each screenshot
  console.log('Step 3: Claude classifying sections...');
  const classifiedSections = await classifySections(candidatesWithScreenshots, config);
  console.log(`Classified ${classifiedSections.length} sections`);

  return {
    title,
    sections: classifiedSections,
    screenshot: fullScreenshot,
    pageWidth: dimensions.width,
    pageHeight: dimensions.height,
  };
}

/**
 * Find section candidates from DOM structure
 */
async function findSectionCandidates(
  page: Page,
  dimensions: { width: number; height: number }
): Promise<Omit<SectionCandidate, 'screenshot'>[]> {
  const minHeight = 80; // Minimum section height
  const minWidth = dimensions.width * 0.7; // At least 70% page width for full-width sections

  const candidates = await page.evaluate((params: { minHeight: number; minWidth: number }) => {
    const { minHeight, minWidth } = params;
    const results: Array<{
      selector: string;
      tagName: string;
      className: string;
      id: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      html: string;
    }> = [];

    // Selectors for likely section containers
    // Focus on full-width content blocks
    const selectors = [
      // Active carousel items (current slide)
      '.cmp-carousel__item--active',
      '[class*="carousel"] [class*="active"]',
      // Direct children of main content container
      '#content > .section',
      '#content > div.section',
      '#content > div[class*="carousel"]',
      '#content > div[class*="panel"]',
      '#content > div[class*="book"]',
      '#content > div[class*="text"]',
      // Semantic elements
      'main > section',
      'main > article',
      'section',
      'article',
      // Common class patterns for full-width sections
      '.section',
      'div.cargo-carousel',
      'div.bookpanel',
      'div.textandasset',
      // Footer
      'footer',
      '.footer',
    ];

    const seen = new Set<Element>();
    const seenRects = new Map<Element, DOMRect>();
    const debugLog: string[] = [];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        debugLog.push(`Selector "${selector}" matched ${elements.length} elements`);
      }

      for (const el of elements) {
        // Skip if already seen
        if (seen.has(el)) continue;

        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const className = (el.className || '').toString().substring(0, 50);

        // Skip elements that are too small or hidden
        if (rect.height < minHeight || rect.width < minWidth) {
          debugLog.push(`  SKIP (too small): ${tag}.${className} - ${rect.width}x${rect.height}`);
          continue;
        }
        if (rect.height === 0 || rect.width === 0) continue;

        // Skip if we already have an element at roughly the same position
        let duplicate = false;
        for (const [seenEl, seenRect] of seenRects) {
          // Same approximate position and size = duplicate
          const sameY = Math.abs(rect.top - seenRect.top) < 20;
          const sameHeight = Math.abs(rect.height - seenRect.height) < 50;
          if (sameY && sameHeight) {
            duplicate = true;
            debugLog.push(`  SKIP (duplicate): ${tag}.${className}`);
            break;
          }
        }
        if (duplicate) continue;

        // Skip navigation elements (usually at top, small height)
        if (tag === 'nav' || (tag === 'header' && rect.height < 150)) continue;

        // Generate a unique selector for this element
        let uniqueSelector = '';
        if (el.id) {
          uniqueSelector = `#${el.id}`;
        } else if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (classes) {
            uniqueSelector = `${tag}.${classes}`;
          }
        }
        if (!uniqueSelector) {
          // Use nth-child
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(el) + 1;
            uniqueSelector = `${parent.tagName.toLowerCase()} > ${tag}:nth-child(${index})`;
          } else {
            uniqueSelector = tag;
          }
        }

        seen.add(el);
        seenRects.set(el, rect);
        results.push({
          selector: uniqueSelector,
          tagName: tag,
          className: (el.className || '').toString(),
          id: el.id || '',
          boundingBox: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          html: el.outerHTML,
        });
      }
    }

    // Sort by Y position
    results.sort((a, b) => a.boundingBox.y - b.boundingBox.y);

    // Filter out overlapping sections (keep the one that appears first)
    const filtered: typeof results = [];
    for (const candidate of results) {
      const overlaps = filtered.some(existing => {
        const overlapY = Math.max(0,
          Math.min(existing.boundingBox.y + existing.boundingBox.height, candidate.boundingBox.y + candidate.boundingBox.height) -
          Math.max(existing.boundingBox.y, candidate.boundingBox.y)
        );
        const minHeight = Math.min(existing.boundingBox.height, candidate.boundingBox.height);
        return overlapY > minHeight * 0.5; // More than 50% overlap
      });
      if (!overlaps) {
        filtered.push(candidate);
      }
    }

    return { filtered, debugLog: debugLog.slice(0, 100) };
  }, { minHeight, minWidth });

  // Log debug info
  if (candidates.debugLog && candidates.debugLog.length > 0) {
    console.log('DOM candidate debug:');
    candidates.debugLog.forEach((line: string) => console.log('  ' + line));
  }

  return candidates.filtered.map((c, i) => ({ ...c, index: i + 1 }));
}

/**
 * Take screenshots of each candidate element
 */
async function takeElementScreenshots(
  page: Page,
  candidates: Omit<SectionCandidate, 'screenshot'>[]
): Promise<SectionCandidate[]> {
  const results: SectionCandidate[] = [];
  const maxScreenshotHeight = 800; // Limit screenshot height

  for (const candidate of candidates) {
    try {
      // Find the element
      const element = await page.$(candidate.selector);
      if (!element) {
        console.log(`  Could not find element: ${candidate.selector}`);
        continue;
      }

      // Scroll element into view
      await element.evaluate((el: Element) => {
        el.scrollIntoView({ block: 'center' });
      });
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for scroll

      // Get actual bounding box
      const box = await element.boundingBox();
      if (!box) {
        console.log(`  No bounding box for: ${candidate.selector}`);
        continue;
      }

      // Take element screenshot (clip if too tall)
      let screenshotBuffer: Buffer;
      if (box.height > maxScreenshotHeight) {
        // Clip to max height
        screenshotBuffer = await page.screenshot({
          clip: {
            x: box.x,
            y: box.y,
            width: box.width,
            height: maxScreenshotHeight,
          },
          type: 'png',
        }) as Buffer;
      } else {
        screenshotBuffer = await element.screenshot({ type: 'png' }) as Buffer;
      }

      const screenshot = screenshotBuffer.toString('base64');
      console.log(`  Captured: ${candidate.selector} (${Math.round(box.width)}x${Math.round(box.height)})`);

      results.push({
        ...candidate,
        boundingBox: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        screenshot,
      });
    } catch (e) {
      console.error(`  Failed to screenshot ${candidate.selector}:`, e);
    }
  }

  return results;
}

/**
 * Have Claude classify each section screenshot
 */
async function classifySections(
  candidates: SectionCandidate[],
  config: AnthropicConfig
): Promise<AnalyzedSection[]> {
  if (candidates.length === 0) return [];

  // Build the prompt with all screenshots
  const imageContents: Array<{ type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }> = [];
  let textPrompt = `I'm showing you ${candidates.length} screenshots of webpage sections. For each section, classify it.

`;

  for (let i = 0; i < candidates.length; i++) {
    imageContents.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: candidates[i].screenshot },
    });
    textPrompt += `Image ${i + 1}: Section at y=${candidates[i].boundingBox.y}px\n`;
  }

  textPrompt += `
For EACH section image, provide:
1. name: Short descriptive name (e.g., "Hero Banner", "Product Cards", "Latest News")
2. description: Brief description of content
3. type: One of: hero, cards, columns, content, cta, news, footer, navigation, other
4. priority: high (above fold, key content), medium (secondary), low (footer, etc.)
5. skip: true if this should be skipped (navigation, empty, duplicate, or not a real section)

Return JSON array with one object per image:
[
  { "index": 1, "name": "...", "description": "...", "type": "...", "priority": "...", "skip": false },
  { "index": 2, "name": "...", "description": "...", "type": "...", "priority": "...", "skip": true },
  ...
]

Return ONLY the JSON array.`;

  // Call Claude with all images
  const response = await callClaudeMultiImage(imageContents, textPrompt, config);

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('No JSON array found in Claude response');
      return [];
    }

    const classifications = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      name: string;
      description: string;
      type: string;
      priority: string;
      skip?: boolean;
    }>;

    // Merge classifications with candidates
    const results: AnalyzedSection[] = [];
    for (const classification of classifications) {
      if (classification.skip) continue;

      const candidate = candidates[classification.index - 1];
      if (!candidate) continue;

      results.push({
        index: classification.index,
        name: classification.name || `Section ${classification.index}`,
        description: classification.description || '',
        type: (classification.type as AnalyzedSection['type']) || 'content',
        priority: (classification.priority as AnalyzedSection['priority']) || 'medium',
        selector: candidate.selector,
        boundingBox: candidate.boundingBox,
        screenshot: candidate.screenshot,
        html: candidate.html,
      });
    }

    return results;
  } catch (e) {
    console.error('Failed to parse classifications:', e);
    return [];
  }
}

/**
 * Call Claude API with multiple images
 */
async function callClaudeMultiImage(
  images: Array<{ type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }>,
  prompt: string,
  config: AnthropicConfig,
  maxTokens: number = 4096
): Promise<string> {
  const content: Array<{ type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } } | { type: 'text'; text: string }> = [
    ...images,
    { type: 'text', text: prompt },
  ];

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
        messages: [{ role: 'user', content }],
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
        messages: [{ role: 'user', content }],
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
