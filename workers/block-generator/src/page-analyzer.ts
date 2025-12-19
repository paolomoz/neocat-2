import { Page } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Identified section from visual analysis
 * Just descriptions - Claude will use these to locate sections when generating
 */
export interface IdentifiedSection {
  index: number;
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'columns' | 'content' | 'cta' | 'news' | 'footer' | 'tabs' | 'carousel' | 'other';
  priority: 'high' | 'medium' | 'low';
  style: string; // e.g., "light", "dark", "grey", "accent"
}

/**
 * Result of page analysis
 */
export interface PageAnalysisResult {
  url: string;
  title: string;
  sections: IdentifiedSection[];
  screenshot: string; // base64 full page screenshot
  pageWidth: number;
  pageHeight: number;
}

/**
 * Analyze a page to identify sections visually
 * No CSS selectors - just descriptions that can be used to locate sections later
 *
 * Flow:
 * 1. Navigate and take full-page screenshot
 * 2. Claude analyzes screenshot to identify visual sections with descriptions
 */
export async function analyzePage(
  page: Page,
  url: string,
  config: AnthropicConfig
): Promise<PageAnalysisResult> {
  // Navigate and wait for page load
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  const title = await page.title();

  // Get page dimensions
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  // Take full page screenshot (limit height for very long pages)
  const maxHeight = Math.min(dimensions.height, 8000);
  console.log(`Page dimensions: ${dimensions.width}x${dimensions.height}, capturing up to ${maxHeight}px`);

  let screenshot: string;
  try {
    const screenshotBuffer = await page.screenshot({
      clip: { x: 0, y: 0, width: dimensions.width, height: maxHeight },
      type: 'png',
    }) as Buffer;
    screenshot = screenshotBuffer.toString('base64');
  } catch (e) {
    console.error('Failed to capture full screenshot:', e);
    const viewportBuffer = await page.screenshot({ type: 'png' }) as Buffer;
    screenshot = viewportBuffer.toString('base64');
  }

  // Claude identifies visual sections from screenshot
  console.log('Claude identifying visual sections...');
  const sections = await identifyVisualSections(screenshot, dimensions.height, config);
  console.log(`Identified ${sections.length} visual sections`);

  return {
    url,
    title,
    sections,
    screenshot,
    pageWidth: dimensions.width,
    pageHeight: dimensions.height,
  };
}

/**
 * Have Claude identify visual sections by analyzing the screenshot
 * Returns detailed descriptions that can be used to locate sections when generating
 */
async function identifyVisualSections(
  screenshotBase64: string,
  pageHeight: number,
  config: AnthropicConfig
): Promise<IdentifiedSection[]> {
  const prompt = `Analyze this webpage screenshot to identify distinct visual SECTIONS.

Look for visual cues that indicate section boundaries:
- Background color changes (white → grey → dark → accent colors)
- Clear horizontal visual breaks
- Spacing/padding changes
- Thematic content shifts

For EACH section you identify, provide:
1. name: Short descriptive name (e.g., "Hero Carousel", "Product Cards", "Latest News")
2. description: DETAILED description including visual elements, colors, content visible, layout structure
3. type: One of: hero, carousel, cards, columns, content, cta, news, footer, tabs, other
4. priority: high (above fold, key content), medium (secondary), low (footer)
5. style: Visual style (e.g., "light", "dark", "grey", "accent/red")

## CAROUSEL VS HERO - CRITICAL!

For the FIRST large full-width banner section at the top of the page:
- **DEFAULT to "carousel"** for corporate/business websites
- Only use "hero" if it's clearly a STATIC image with no possibility of rotation

Why: Most corporate websites use rotating carousels for their main banner, even if the navigation controls (dots, arrows, numbers) are too small to see clearly in a screenshot.

Signs it's definitely a carousel:
- Any dots, numbers, arrows, or navigation at bottom/sides
- Multiple messages or CTAs that seem to rotate
- Corporate/business website (airlines, cargo, financial, etc.)

Signs it might be a static hero:
- Personal blog or simple landing page
- Single clear message with no navigation hints
- Marketing campaign with one focused message

IMPORTANT:
- Identify TOP-LEVEL sections only (not individual cards within a section)
- Skip navigation/header at the very top
- Include footer if visible
- Make descriptions DETAILED enough to uniquely identify each section visually
- ALWAYS mention carousel indicators in description if present (dots, arrows, etc.)

Return JSON array:
[
  {
    "index": 1,
    "name": "Hero Carousel",
    "description": "Full-width rotating banner with navigation dots at bottom center (5 dots, first active), left/right arrow buttons on sides, currently showing red/burgundy background with Christmas sleigh illustration",
    "type": "carousel",
    "priority": "high",
    "style": "accent/red"
  },
  {
    "index": 2,
    "name": "Quick Actions",
    "description": "Horizontal row of 4 action buttons with icons - Book online, Track cargo, Contact us, Flight schedules - on white background",
    "type": "cta",
    "priority": "high",
    "style": "light"
  }
]

Return ONLY the JSON array.`;

  const response = await callClaude(screenshotBase64, prompt, config);

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('No JSON array found in Claude response');
      return [];
    }

    const sections = JSON.parse(jsonMatch[0]) as IdentifiedSection[];

    // Validate and clean up
    return sections.map((s, i) => ({
      index: i + 1,
      name: s.name || `Section ${i + 1}`,
      description: s.description || '',
      type: s.type || 'content',
      priority: s.priority || 'medium',
      style: s.style || 'light',
    }));
  } catch (e) {
    console.error('Failed to parse visual sections:', e);
    return [];
  }
}

/**
 * Call Claude API with image
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
