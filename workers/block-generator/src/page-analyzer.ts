import { Page } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Attempt to dismiss cookie consent banners before taking screenshot
 * Tries multiple strategies: common selectors, text matching, and class patterns
 * Returns true if a banner was likely dismissed
 */
async function dismissCookieBanners(page: Page): Promise<boolean> {
  console.log('Attempting to dismiss cookie consent banners...');

  // Strategy 1: Try common button selectors directly
  const commonSelectors = [
    // OneTrust (very common)
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    // TrustArc
    '.trustarc-agree-btn',
    // Quantcast
    '.qc-cmp2-summary-buttons button[mode="primary"]',
    // Generic patterns
    '[class*="cookie"] [class*="accept"]',
    '[class*="cookie"] [class*="agree"]',
    '[class*="consent"] [class*="accept"]',
    '[class*="consent"] [class*="agree"]',
    '[class*="gdpr"] [class*="accept"]',
    '[data-testid*="cookie"][data-testid*="accept"]',
    '[data-testid*="consent"][data-testid*="accept"]',
    '.cc-accept',
    '.cc-allow',
    '.cc-btn.cc-dismiss',
  ];

  for (const selector of commonSelectors) {
    try {
      const button = await page.$(selector);
      if (button) {
        const isVisible = await button.isIntersectingViewport();
        if (isVisible) {
          await button.click();
          await new Promise(r => setTimeout(r, 500));
          console.log(`Dismissed cookie banner via selector: ${selector}`);
          return true;
        }
      }
    } catch {
      // Continue to next selector
    }
  }

  // Strategy 2: Find buttons by text content within cookie-related containers
  const dismissed = await page.evaluate(() => {
    const acceptTexts = [
      'accept all', 'accept cookies', 'accept', 'agree to all', 'agree',
      'allow all', 'allow cookies', 'allow', 'i agree', 'i accept',
      'got it', 'ok', 'continue', 'dismiss'
    ];

    // Find potential cookie banner containers
    const bannerSelectors = [
      '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
      '[class*="privacy"]', '[id*="cookie"]', '[id*="consent"]',
      '[role="dialog"]', '[role="alertdialog"]',
      '[aria-label*="cookie"]', '[aria-label*="consent"]'
    ];

    for (const containerSelector of bannerSelectors) {
      const containers = document.querySelectorAll(containerSelector);

      for (const container of containers) {
        // Check if container is visible
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // Find clickable elements
        const clickables = container.querySelectorAll('button, a, [role="button"], [class*="btn"]');

        for (const el of clickables) {
          const text = (el.textContent || '').toLowerCase().trim();
          // Check if button text matches accept patterns
          for (const acceptText of acceptTexts) {
            if (text === acceptText || text.includes(acceptText)) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }
      }
    }

    return false;
  });

  if (dismissed) {
    await new Promise(r => setTimeout(r, 500));
    console.log('Dismissed cookie banner via text matching');
    return true;
  }

  // Strategy 3: Try to hide any remaining overlay elements via CSS
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookie-notice"],
      [class*="gdpr-banner"], [class*="consent-banner"], [class*="privacy-banner"],
      [id*="cookie-banner"], [id*="cookie-consent"], [id*="gdpr"],
      .cc-banner, .cc-window, #onetrust-banner-sdk, #CybotCookiebotDialog,
      [class*="CookieConsent"], [class*="cookieConsent"] {
        display: none !important;
        visibility: hidden !important;
      }
    `;
    document.head.appendChild(style);
  });
  console.log('Applied CSS fallback to hide cookie banners');

  return false;
}

/**
 * Scroll down the page incrementally to trigger lazy loading
 * Returns after scrolling to bottom and back to top
 */
async function scrollToLoadLazyContent(page: Page): Promise<void> {
  console.log('Scrolling page to load lazy content...');

  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Multiple scroll passes to ensure lazy content loads
    for (let pass = 0; pass < 2; pass++) {
      const scrollHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const scrollStep = viewportHeight * 0.7; // Scroll 70% of viewport at a time

      // Scroll down incrementally
      let currentPosition = 0;
      while (currentPosition < scrollHeight) {
        window.scrollTo(0, currentPosition);
        await delay(300); // Wait for lazy content to start loading
        currentPosition += scrollStep;
      }

      // Scroll to absolute bottom to ensure everything is triggered
      window.scrollTo(0, scrollHeight);
      await delay(800);
    }

    // Scroll back to top
    window.scrollTo(0, 0);
    await delay(500);
  });

  // Additional wait for images and content to finish loading
  await new Promise(r => setTimeout(r, 2000));
  console.log('Finished scrolling for lazy content');
}

/**
 * Identified section from visual analysis
 * Includes Y-boundaries for locating sections in the DOM during generation
 */
export interface IdentifiedSection {
  index: number;
  name: string;
  description: string;
  type: 'hero' | 'cards' | 'columns' | 'content' | 'cta' | 'news' | 'footer' | 'tabs' | 'carousel' | 'other';
  priority: 'high' | 'medium' | 'low';
  style: string; // e.g., "light", "dark", "grey", "accent"
  yStart: number; // Y position where section starts (pixels from top)
  yEnd: number; // Y position where section ends (pixels from top)
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
  // Set desktop user agent to ensure desktop layout
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Use domcontentloaded + manual wait instead of networkidle0
  // networkidle0 can timeout on heavy sites with lots of tracking/ads
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait a bit for initial content to load
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Try to dismiss cookie consent banners before taking screenshot
  try {
    await dismissCookieBanners(page);
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (e) {
    console.log('Cookie banner dismissal encountered error:', e);
  }

  // Scroll down the page to trigger lazy loading of content below the fold
  try {
    await scrollToLoadLazyContent(page);
  } catch (e) {
    console.log('Scroll for lazy content encountered error:', e);
  }

  const title = await page.title();

  // Get page dimensions AFTER scrolling (page may have grown)
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

The screenshot is ${pageHeight}px tall. You MUST provide accurate Y-coordinates for each section.

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
6. yStart: Y-coordinate in pixels where this section STARTS (from top of page)
7. yEnd: Y-coordinate in pixels where this section ENDS (from top of page)

## Y-COORDINATES - CRITICAL!

You MUST estimate the Y pixel positions for each section:
- The top of the page is Y=0
- The screenshot shows the page from Y=0 to approximately Y=${Math.min(pageHeight, 8000)}
- Look at where sections visually start and end
- Sections should NOT overlap - each section's yStart should equal the previous section's yEnd
- Be as accurate as possible - these coordinates will be used to locate the section in the DOM

## CAROUSEL VS HERO

For the FIRST large full-width banner section at the top of the page:
- **DEFAULT to "carousel"** for corporate/business websites
- Only use "hero" if it's clearly a STATIC image with no possibility of rotation

## IMPORTANT RULES

- Identify TOP-LEVEL sections only (not individual cards within a section)
- Skip navigation/header at the very top (start your first section AFTER the header)
- **SKIP cookie consent banners, GDPR notices, privacy popups, and any overlay modals**
- Include footer if visible
- Make descriptions DETAILED enough to uniquely identify each section visually

Return JSON array:
[
  {
    "index": 1,
    "name": "Hero Carousel",
    "description": "Full-width rotating banner with navigation dots at bottom center, currently showing teal/turquoise gradient background with 'Thoughtful Investment Solutions' headline in white",
    "type": "carousel",
    "priority": "high",
    "style": "accent/teal",
    "yStart": 80,
    "yEnd": 450
  },
  {
    "index": 2,
    "name": "Navigation Tabs",
    "description": "Horizontal row of 4 navigation tabs - Insights, Solutions, Tools, Strategies - on white background with blue accent for active tab",
    "type": "tabs",
    "priority": "high",
    "style": "light",
    "yStart": 450,
    "yEnd": 550
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
      yStart: s.yStart || 0,
      yEnd: s.yEnd || 0,
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
