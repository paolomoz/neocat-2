import {
  BlockRequest,
  BlockResponse,
  ErrorResponse,
  BlockGeneratorError,
  Env,
} from './types';
import { fetchPage } from './fetcher';
import { parseHTMLDocument, getElement } from './parser';
import { extractContent } from './content-extractor';
import { buildBlock } from './block-builder';
import { captureElementScreenshot, extractLiveImages, ExtractedImage } from './screenshot';
import { analyzeDesign, generateBlockCode, analyzePageBlocks, nameDetectedBlocks, DesignTokens, AnthropicConfig, GeneratedBlockCode, IdentifiedBlock, NamedBlock } from './design-analyzer';
import { detectBlocksInBrowser, DetectedBlock, PageDetectionResult } from './block-detector';
import { detectBlocksVisually, VisualDetectionResult } from './visual-block-detector';
import { detectBlocksAnnotated, AnnotatedDetectionResult } from './annotated-detector';
import { detectBlocksSmart, SmartDetectionResult } from './smart-detector';
import { generateBlockEnhanced, EnhancedBlockCode } from './enhanced-generator';
import { extractComputedStyles, formatStylesForPrompt } from './style-extractor';
import { detectBlocks, captureBlockScreenshot, DetectedBlock as BBoxBlock, BoundingBox } from './bbox-detector';
import { detectBlocksHybrid, ClassifiedBlock, HybridDetectionResult } from './hybrid-detector';
import { analyzePage, PageAnalysisResult, IdentifiedSection } from './page-analyzer';
import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(env);
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', version: '1.0.0' });
    }

    // Test UI endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      return handleTestUI(env);
    }

    // Batch generation UI
    if (url.pathname === '/batch' && request.method === 'GET') {
      return handleBatchUI(env);
    }

    // Debug: View bbox screenshots
    if (url.pathname === '/debug/bboxes' && request.method === 'POST') {
      return handleDebugBboxes(request, env);
    }

    // Analyze page to identify blocks
    if (url.pathname === '/analyze' && request.method === 'POST') {
      return handleAnalyze(request, env);
    }

    // Main generation endpoint (JSON response)
    if (url.pathname === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    // Preview endpoint (HTML page for browser)
    if (url.pathname === '/preview' && request.method === 'POST') {
      return handlePreview(request, env);
    }

    // 404 for unknown routes
    return Response.json(
      { success: false, error: 'Not found', code: 'NOT_FOUND' },
      { status: 404, headers: corsHeaders(env) }
    );
  },
};

/**
 * Build Anthropic config from environment
 */
function getAnthropicConfig(env: Env): AnthropicConfig | undefined {
  // Check for Bedrock config
  if (env.ANTHROPIC_USE_BEDROCK === '1' && env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK) {
    return {
      useBedrock: true,
      bedrockToken: env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK,
      bedrockRegion: env.ANTHROPIC_AWS_REGION || 'us-east-1',
      bedrockModel: env.ANTHROPIC_MODEL,
    };
  }

  // Check for direct Anthropic API key
  if (env.ANTHROPIC_API_KEY) {
    return {
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }

  return undefined;
}

/**
 * Capture screenshot and analyze design using Claude Vision (legacy - extracts tokens only)
 */
async function analyzeDesignFromScreenshot(
  url: string,
  selector: string,
  env: Env
): Promise<DesignTokens | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const { screenshot } = await captureElementScreenshot(browser, url, selector);
      const designTokens = await analyzeDesign(screenshot, anthropicConfig);
      return designTokens;
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Design analysis failed:', error);
    return undefined;
  }
}

/**
 * Generate block from a visual description
 * Claude sees the full page and uses the description to find and generate the block
 */
async function generateBlockFromDescription(
  url: string,
  sectionDescription: string,
  sectionName: string,
  env: Env,
  maxRetries: number = 3
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        // Get page dimensions and take full screenshot
        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));

        const maxHeight = Math.min(dimensions.height, 8000);
        console.log(`Taking screenshot: ${dimensions.width}x${maxHeight}`);

        const screenshotBuffer = await page.screenshot({
          clip: { x: 0, y: 0, width: dimensions.width, height: maxHeight },
          type: 'png',
        }) as Buffer;
        const screenshot = screenshotBuffer.toString('base64');

        // Extract all images from the page for reference
        let liveImages: ExtractedImage[] = [];
        try {
          liveImages = await extractLiveImages(page, 'body', url);
          console.log(`Found ${liveImages.length} images on page`);
        } catch (e) {
          console.warn('Image extraction failed:', e);
        }

        await page.close();

        // Generate block using description-based approach
        console.log(`Generating block for: ${sectionName}`);
        const block = await generateBlockFromDescriptionWithClaude(
          screenshot,
          sectionDescription,
          sectionName,
          url,
          liveImages,
          anthropicConfig
        );

        return block;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000;
        console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error('Description-based generation failed:', error);
      return undefined;
    }
  }

  console.error('Generation failed after retries:', lastError);
  return undefined;
}

/**
 * Use Claude to find and generate block from description
 */
async function generateBlockFromDescriptionWithClaude(
  screenshotBase64: string,
  sectionDescription: string,
  sectionName: string,
  baseUrl: string,
  liveImages: ExtractedImage[],
  config: AnthropicConfig
): Promise<EnhancedBlockCode> {
  const imageList = liveImages.length > 0
    ? `\n\nAVAILABLE IMAGES FROM PAGE:\n${liveImages.map(img => `- ${img.src} (${img.role})`).join('\n')}`
    : '';

  const prompt = `Look at this webpage screenshot. Find the section matching this description:

SECTION NAME: ${sectionName}
DESCRIPTION: ${sectionDescription}

Generate an AEM Edge Delivery Services (EDS) block that recreates this specific section.

## EDS Block Requirements

HTML structure:
\`\`\`html
<div class="{block-name} block">
  <div><!-- row 1 -->
    <div><!-- cell 1 --></div>
    <div><!-- cell 2 --></div>
  </div>
</div>
\`\`\`

The JS decoration function transforms this into the final rendered structure.
${imageList}

## Critical Instructions

1. **Find the section** in the screenshot that matches the description
2. **Match the visual design EXACTLY** - colors, fonts, layout, spacing
3. **Use REAL image URLs** from the AVAILABLE IMAGES list above - NEVER use placeholder or invented URLs
4. **Extract actual text content** visible in that section
5. **Generate working CSS** that recreates the exact appearance
6. **Generate JS decoration** that transforms the EDS markup into the rendered HTML

## Return Format

Return JSON:
{
  "blockName": "descriptive-block-name",
  "componentType": "hero|cards|columns|etc",
  "html": "<!-- EDS block markup with actual content and real image URLs -->",
  "css": "/* Complete CSS to match the visual design */",
  "js": "/* ES module: export default function decorate(block) { ... } */"
}

Return ONLY the JSON object.`;

  const response = await callClaudeForGeneration(screenshotBase64, prompt, config, 8192);

  try {
    let jsonStr: string | null = null;
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      const jsonMatch = response.match(/\{[\s\S]*"blockName"[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }

    if (!jsonStr) throw new Error('No JSON found in response');

    const parsed = JSON.parse(jsonStr);

    return {
      blockName: parsed.blockName || 'generated-block',
      componentType: parsed.componentType || 'content',
      html: parsed.html || '',
      css: parsed.css || '',
      js: parsed.js || '',
      description: {
        componentType: parsed.componentType || 'content',
        structure: { layout: '', contentHierarchy: [] },
        design: { colorScheme: '', textStyle: '', spacing: '' },
        contentElements: { headings: [], paragraphs: [], images: [], ctas: [] },
      },
    };
  } catch (e) {
    console.error('Failed to parse generation response:', response.substring(0, 500));
    throw new Error('Failed to parse generation response');
  }
}

/**
 * Call Claude API for generation
 */
async function callClaudeForGeneration(
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

/**
 * Enhanced block generation using the describe-first approach:
 * 1. Extract computed CSS styles from the live page
 * 2. Describe component (structure, design)
 * 3. Extract content guided by description
 * 4. Generate code with full context including real CSS values
 */
async function generateBlockFromScreenshotEnhanced(
  url: string,
  selector: string,
  elementHtml: string,
  env: Env,
  maxRetries: number = 3
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        // Create a page to reuse for multiple operations
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        console.log(`Capturing screenshot for selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: 10000 });
        const element = await page.$(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }
        const screenshotBuffer = await element.screenshot({ type: 'png', encoding: 'base64' });
        const boundingBox = await element.boundingBox();
        const screenshot = screenshotBuffer as string;
        console.log(`Screenshot captured: ${boundingBox?.width}x${boundingBox?.height}, base64 length: ${screenshot.length}`);

        // Extract live images from the rendered page (includes lazy-loaded and CSS background images)
        let liveImages: ExtractedImage[] = [];
        try {
          console.log('Extracting live images from rendered page...');
          liveImages = await extractLiveImages(page, selector, url);
          console.log(`Found ${liveImages.length} live images`);
        } catch (imgError) {
          console.warn('Live image extraction failed:', imgError);
        }

        // Extract computed styles from the live page
        let extractedCssStyles: string | undefined;
        try {
          console.log('Extracting computed CSS styles...');
          const styles = await extractComputedStyles(browser, url, selector);
          extractedCssStyles = formatStylesForPrompt(styles);
          console.log(`Extracted styles for: container, ${styles.cards.length} cards, ${styles.headings.length} headings`);
        } catch (styleError) {
          console.warn('Style extraction failed, continuing without:', styleError);
        }

        await page.close();

        const generatedBlock = await generateBlockEnhanced(screenshot, elementHtml, url, anthropicConfig, extractedCssStyles, liveImages);
        return generatedBlock;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      // Check if it's a rate limit error (429)
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`Browser rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For other errors, don't retry
      console.error('Enhanced block generation failed:', error);
      return undefined;
    }
  }

  console.error('Enhanced block generation failed after retries:', lastError);
  return undefined;
}

/**
 * Legacy: Capture screenshot and generate complete block code using Claude Vision
 * Includes retry logic for Browser Rendering rate limits
 */
async function generateBlockFromScreenshot(
  url: string,
  selector: string,
  extracted: ReturnType<typeof extractContent>,
  env: Env,
  maxRetries: number = 3
): Promise<GeneratedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const { screenshot } = await captureElementScreenshot(browser, url, selector);
        const generatedBlock = await generateBlockCode(screenshot, extracted, anthropicConfig);
        return generatedBlock;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      // Check if it's a rate limit error (429)
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`Browser rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For other errors, don't retry
      console.error('Block code generation failed:', error);
      return undefined;
    }
  }

  console.error('Block code generation failed after retries:', lastError);
  return undefined;
}

/**
 * Generate block from bounding box coordinates (new simplified approach)
 * 1. Navigate to page
 * 2. Capture screenshot of bounding box region
 * 3. Extract HTML from that region
 * 4. Generate block code
 */
async function generateBlockFromBoundingBox(
  url: string,
  bbox: BoundingBox,
  env: Env
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Capture screenshot of just the bounding box region
      console.log(`Capturing screenshot for bbox: ${bbox.x},${bbox.y} ${bbox.width}x${bbox.height}`);
      const screenshotBuffer = await page.screenshot({
        clip: {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
        },
        type: 'png',
      }) as Buffer;
      const screenshot = screenshotBuffer.toString('base64');
      console.log(`Screenshot captured: ${bbox.width}x${bbox.height}, base64 length: ${screenshot.length}`);

      // Extract HTML from the bounding box region
      const html = await page.evaluate((box: BoundingBox) => {
        // Find element at center of bounding box
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        // Scroll to position
        window.scrollTo(0, Math.max(0, box.y - 100));

        const element = document.elementFromPoint(
          centerX - window.scrollX,
          Math.min(centerY - window.scrollY + 100, window.innerHeight - 10)
        );

        if (!element) return null;

        // Walk up to find best container
        let current: Element | null = element;
        let best = element;

        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const elBox = {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          };

          // Check overlap with target box
          const overlapX = Math.max(0, Math.min(elBox.x + elBox.width, box.x + box.width) - Math.max(elBox.x, box.x));
          const overlapY = Math.max(0, Math.min(elBox.y + elBox.height, box.y + box.height) - Math.max(elBox.y, box.y));
          const overlapRatio = (overlapX * overlapY) / (box.width * box.height);

          if (overlapRatio > 0.6) {
            best = current;
          }

          if (elBox.width > box.width * 2 || elBox.height > box.height * 2) break;
          current = current.parentElement;
        }

        return best.outerHTML;
      }, bbox);

      if (!html) {
        console.error('Could not extract HTML from bounding box');
        return undefined;
      }

      console.log(`Extracted ${html.length} chars of HTML`);

      // Generate block using enhanced generator
      const generatedBlock = await generateBlockEnhanced(screenshot, html, url, anthropicConfig);
      return generatedBlock;
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Bounding box generation failed:', error);
    return undefined;
  }
}

/**
 * Handles the page analysis request - identifies blocks on a page
 * Uses visual-first approach (like identify-page-structure skill):
 * 1. Take full page screenshot
 * 2. Claude identifies visual sections with Y-boundaries
 * 3. Map Y-boundaries to DOM elements
 */
async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      return Response.json(
        { success: false, error: 'Content-Type must be application/json', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const body = await request.json() as { url?: string };
    const url = body?.url;

    if (typeof url !== 'string' || !url.trim()) {
      return Response.json(
        { success: false, error: 'Missing or invalid "url" field', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Check if Browser Rendering is available
    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const anthropicConfig = getAnthropicConfig(env);

    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Claude API not configured - required for block detection', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Visual-first detection (like identify-page-structure skill):
    // 1. Take full-page screenshot
    // 2. Claude identifies visual sections with descriptions
    // No CSS selectors - generator will use descriptions to locate sections
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      const result = await analyzePage(page, url.trim(), anthropicConfig);

      // Return sections with descriptions only - generator will use description to find section
      return Response.json(
        {
          success: true,
          url: url.trim(),
          title: result.title,
          blocks: result.sections.map(s => ({
            index: s.index,
            name: s.name,
            description: s.description,
            type: s.type,
            priority: s.priority,
            style: s.style,
          })),
          screenshot: result.screenshot,
          pageWidth: result.pageWidth,
          pageHeight: result.pageHeight,
        },
        { status: 200, headers: corsHeaders(env) }
      );
    } finally {
      if (browser) await browser.close();
    }
  } catch (error) {
    console.error('Page analysis failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: message, code: 'ANALYSIS_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Infer a basic block name from detected content
 */
function inferBlockName(block: DetectedBlock): string {
  if (block.classes.some(c => c.includes('hero') || c.includes('banner'))) {
    return 'Hero Section';
  }
  if (block.classes.some(c => c.includes('carousel') || c.includes('slider'))) {
    return 'Carousel';
  }
  if (block.classes.some(c => c.includes('card'))) {
    return 'Cards Section';
  }
  if (block.hasImages && block.hasHeadings) {
    return 'Content Section';
  }
  if (block.hasImages) {
    return 'Media Section';
  }
  if (block.hasHeadings) {
    return 'Text Section';
  }
  return 'Content Block';
}

/**
 * Infer block type from detected content
 */
function inferBlockType(block: DetectedBlock): NamedBlock['type'] {
  const classStr = block.classes.join(' ').toLowerCase();
  if (classStr.includes('hero') || classStr.includes('banner')) return 'hero';
  if (classStr.includes('carousel') || classStr.includes('slider')) return 'carousel';
  if (classStr.includes('card')) return 'cards';
  if (classStr.includes('column') || classStr.includes('grid')) return 'columns';
  if (classStr.includes('tab')) return 'tabs';
  if (classStr.includes('accordion') || classStr.includes('faq')) return 'accordion';
  if (classStr.includes('form')) return 'form';
  return 'content';
}

/**
 * Handles the block generation request
 * Supports both bounding box (new) and selector (legacy) approaches
 */
async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseRequestBody(request);

    let blockName: string;
    let blockHtml: string;
    let blockJs: string;
    let blockCss: string;
    let componentType: string | undefined;

    // NEW: Bounding box approach (preferred)
    if (body.boundingBox) {
      console.log('Using bounding box approach');
      const enhancedBlock = await generateBlockFromBoundingBox(body.url, body.boundingBox, env);

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHtml = enhancedBlock.html;
      blockJs = enhancedBlock.js;
      blockCss = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // LEGACY: Selector approach
    else if (body.selector) {
      console.log('Using selector approach (legacy)');
      const html = await fetchPage(body.url);
      const document = parseHTMLDocument(html);
      const element = getElement(document, body.selector);

      let combinedHtml = element.outerHTML;
      if (body.siblingSelectors && body.siblingSelectors.length > 0) {
        const siblingHtmlParts: string[] = [];
        for (const sibSel of body.siblingSelectors) {
          try {
            const sibEl = getElement(document, sibSel);
            siblingHtmlParts.push(sibEl.innerHTML);
          } catch (e) {
            console.log(`Could not get sibling element: ${sibSel}`);
          }
        }
        if (siblingHtmlParts.length > 0) {
          combinedHtml = `<div class="merged-content">${element.innerHTML}${siblingHtmlParts.join('')}</div>`;
        }
      }

      const extracted = extractContent(combinedHtml, body.url);
      const enhancedBlock = await generateBlockFromScreenshotEnhanced(body.url, body.selector, combinedHtml, env);

      if (enhancedBlock) {
        blockName = enhancedBlock.blockName;
        blockHtml = enhancedBlock.html;
        blockJs = enhancedBlock.js;
        blockCss = enhancedBlock.css;
        componentType = enhancedBlock.componentType;
      } else {
        const legacyBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);
        if (legacyBlock) {
          blockName = legacyBlock.blockName;
          blockHtml = legacyBlock.html;
          blockJs = legacyBlock.js;
          blockCss = legacyBlock.css;
        } else {
          const block = buildBlock(extracted);
          blockName = block.blockName;
          blockHtml = block.html;
          blockJs = block.js;
          blockCss = block.css;
        }
      }
    } else {
      return Response.json(
        { success: false, error: 'Either boundingBox or selector is required', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const response: BlockResponse = {
      success: true,
      blockName,
      layoutPattern: componentType as any || 'unknown',
      html: blockHtml,
      js: blockJs,
      css: blockCss,
      metadata: {
        elementCount: 0,
        hasImages: true,
        hasHeadings: true,
        hasLinks: true,
        rowCount: 1,
        columnCount: 1,
      },
    };

    return Response.json(response, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles the preview request - returns a full HTML page
 * Supports both bounding box (new) and selector (legacy) approaches
 */
async function handlePreview(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseRequestBody(request);

    let blockName: string;
    let blockHTML: string;
    let blockJS: string;
    let blockCSS: string;
    let componentType: string | undefined;

    // NEW: Description-based approach (from /analyze)
    if (body.sectionDescription && body.sectionName) {
      console.log(`Preview: Using description-based approach for "${body.sectionName}"`);
      const enhancedBlock = await generateBlockFromDescription(body.url, body.sectionDescription, body.sectionName, env);

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHTML = enhancedBlock.html;
      blockJS = enhancedBlock.js;
      blockCSS = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // Bounding box approach
    else if (body.boundingBox) {
      console.log('Preview: Using bounding box approach');
      const enhancedBlock = await generateBlockFromBoundingBox(body.url, body.boundingBox, env);

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHTML = enhancedBlock.html;
      blockJS = enhancedBlock.js;
      blockCSS = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // LEGACY: Selector approach
    else if (body.selector) {
      console.log('Preview: Using selector approach (legacy)');
      const html = await fetchPage(body.url);
      const document = parseHTMLDocument(html);
      const element = getElement(document, body.selector);

      let combinedHtml = element.outerHTML;
      if (body.siblingSelectors && body.siblingSelectors.length > 0) {
        const siblingHtmlParts: string[] = [];
        for (const sibSel of body.siblingSelectors) {
          try {
            const sibEl = getElement(document, sibSel);
            siblingHtmlParts.push(sibEl.innerHTML);
          } catch (e) {
            console.log(`Could not get sibling element: ${sibSel}`);
          }
        }
        if (siblingHtmlParts.length > 0) {
          combinedHtml = `<div class="merged-content">${element.innerHTML}${siblingHtmlParts.join('')}</div>`;
        }
      }

      const extracted = extractContent(combinedHtml, body.url);
      const enhancedBlock = await generateBlockFromScreenshotEnhanced(body.url, body.selector, combinedHtml, env);

      if (enhancedBlock) {
        blockName = enhancedBlock.blockName;
        blockHTML = enhancedBlock.html;
        blockJS = enhancedBlock.js;
        blockCSS = enhancedBlock.css;
        componentType = enhancedBlock.componentType;
      } else {
        const legacyBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);
        if (legacyBlock) {
          blockName = legacyBlock.blockName;
          blockHTML = legacyBlock.html;
          blockJS = legacyBlock.js;
          blockCSS = legacyBlock.css;
        } else {
          const block = buildBlock(extracted);
          blockName = block.blockName;
          blockHTML = block.html;
          blockJS = block.js;
          blockCSS = block.css;
        }
      }
    } else {
      return Response.json(
        { success: false, error: 'sectionDescription+sectionName, boundingBox, or selector is required', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const previewHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Preview: ${blockName}</title>
  <style>
    /* Reset and base styles */
    *, *::before, *::after {
      box-sizing: border-box;
    }

    :root {
      --background-color: #fff;
      --light-color: #f8f8f8;
      --dark-color: #505050;
      --text-color: #131313;
      --link-color: #3b63fb;
      --link-hover-color: #1d3ecf;
      --heading-font-size-xxl: 48px;
      --heading-font-size-xl: 40px;
      --heading-font-size-l: 32px;
      --heading-font-size-m: 24px;
      --heading-font-size-s: 20px;
      --body-font-size-m: 18px;
      --body-font-size-s: 16px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      color: var(--text-color);
      line-height: 1.5;
    }

    .preview-header {
      background: #fff;
      padding: 20px;
      margin: -20px -20px 20px;
      border-bottom: 1px solid #ddd;
    }

    .preview-header h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    .preview-header .meta {
      color: #666;
      font-size: 14px;
    }

    .preview-header code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    .preview-container {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .preview-content {
      padding: 0 20px;
    }

    /* Generated block CSS */
    ${blockCSS}
  </style>
</head>
<body>
  <div class="preview-header">
    <h1>Block Preview</h1>
    <p class="meta">
      Block: <code>${blockName}</code> |
      Pattern: <code>${componentType || 'unknown'}</code> |
      Source: <code>${body.url}</code>
    </p>
  </div>

  <div class="preview-container">
    <div class="preview-content">
      ${blockHTML}
    </div>
  </div>

  <script type="module">
    // Simulated aem.js utilities
    function createOptimizedPicture(src, alt = '', eager = false, breakpoints = [{ width: '750' }]) {
      const picture = document.createElement('picture');
      breakpoints.forEach((bp, i) => {
        const source = document.createElement('source');
        source.type = 'image/webp';
        source.srcset = src;
        if (bp.media) source.media = bp.media;
        picture.appendChild(source);
      });
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      img.loading = eager ? 'eager' : 'lazy';
      picture.appendChild(img);
      return picture;
    }

    // Make it available globally for the block script
    window.createOptimizedPicture = createOptimizedPicture;

    // Block decoration function
    ${blockJS.replace(/import\s*{[^}]*}\s*from\s*['"][^'"]*['"];?\s*/g, '')}

    // Run decoration
    const blockEl = document.querySelector('.${blockName}');
    if (blockEl && typeof decorate === 'function') {
      decorate(blockEl);
    }
  </script>
</body>
</html>`;

    return new Response(previewHTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      },
    });
  } catch (error) {
    // Return JSON errors so API clients can parse them
    if (error instanceof BlockGeneratorError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.statusCode, headers: corsHeaders(env) }
      );
    }
    return Response.json(
      { success: false, error: 'An unexpected error occurred', code: 'INTERNAL_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Returns the test UI HTML page
 */
function handleTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EDS Block Generator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f5f5f5;
    }
    h1 { margin: 0 0 8px; }
    .subtitle { color: #666; margin: 0 0 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    input[type="text"] {
      width: 100%;
      padding: 12px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 6px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #3b63fb;
      box-shadow: 0 0 0 3px rgba(59, 99, 251, 0.1);
    }
    .buttons { display: flex; gap: 12px; margin-top: 24px; }
    button {
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn-primary {
      background: #3b63fb;
      color: white;
    }
    .btn-primary:hover { background: #1d3ecf; }
    .btn-secondary {
      background: #e0e0e0;
      color: #333;
    }
    .btn-secondary:hover { background: #d0d0d0; }
    .hint {
      font-size: 13px;
      color: #888;
      margin-top: 6px;
    }
    .loading {
      display: none;
      color: #666;
      margin-top: 20px;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 6px;
      margin-top: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <h1>EDS Block Generator</h1>
  <p class="subtitle">Generate AEM Edge Delivery Services blocks from any webpage</p>

  <form id="generateForm">
    <div class="form-group">
      <label for="url">Page URL</label>
      <input type="text" id="url" name="url" placeholder="https://example.com" required>
      <p class="hint">The webpage to extract content from</p>
    </div>

    <div class="form-group">
      <label for="selector">CSS Selector</label>
      <input type="text" id="selector" name="selector" placeholder=".hero, #main-content, article" required>
      <p class="hint">CSS selector for the content block to convert</p>
    </div>

    <div class="buttons">
      <button type="submit" class="btn-primary" id="previewBtn">Preview in Browser</button>
      <button type="button" class="btn-secondary" id="jsonBtn">Get JSON</button>
    </div>
  </form>

  <p class="loading" id="loading">Generating block...</p>
  <div class="error" id="error"></div>

  <script>
    const form = document.getElementById('generateForm');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await makeRequest('/preview', true);
    });

    document.getElementById('jsonBtn').addEventListener('click', async () => {
      await makeRequest('/generate', false);
    });

    async function makeRequest(endpoint, openInNewTab) {
      const url = document.getElementById('url').value;
      const selector = document.getElementById('selector').value;

      loading.style.display = 'block';
      error.style.display = 'none';

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, selector })
        });

        if (endpoint === '/preview') {
          const html = await response.text();
          if (!response.ok) {
            throw new Error('Failed to generate preview');
          }
          const newWindow = window.open('', '_blank');
          if (!newWindow) {
            throw new Error('Popup blocked. Please allow popups for this site.');
          }
          newWindow.document.write(html);
          newWindow.document.close();
        } else {
          const json = await response.json();
          if (json.success) {
            const newWindow = window.open('', '_blank');
            if (!newWindow) {
              throw new Error('Popup blocked. Please allow popups for this site.');
            }
            newWindow.document.write('<pre>' + JSON.stringify(json, null, 2) + '</pre>');
            newWindow.document.close();
          } else {
            throw new Error(json.error);
          }
        }
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Debug endpoint to view visual section analysis results
 * Shows Claude's visual section identification with Y-boundaries and CSS selectors
 */
async function handleDebugBboxes(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { url?: string };
    const url = body?.url;

    if (typeof url !== 'string' || !url.trim()) {
      return Response.json(
        { success: false, error: 'Missing or invalid "url" field', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Claude API not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();

      // Use visual-first section analysis (like identify-page-structure skill)
      const result = await analyzePage(page, url.trim(), anthropicConfig);

      const colors = ['#e63946', '#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#9b5de5'];

      // Return HTML page showing sections (description-based, no coordinates)
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Visual Section Analysis: ${url}</title>
  <style>
    body { font-family: system-ui; padding: 20px; background: #f5f5f5; }
    h1 { margin-bottom: 8px; }
    .url { color: #666; margin-bottom: 20px; font-size: 14px; word-break: break-all; }
    .page-info { background: #fff; padding: 16px; margin-bottom: 20px; border-radius: 8px; }
    .screenshot-container { position: relative; display: inline-block; margin-bottom: 30px; }
    .screenshot-container img { max-width: 100%; border: 2px solid #333; }
    .blocks-section { margin-top: 30px; }
    .section-card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .section-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .section-name { font-size: 18px; font-weight: 600; margin: 0; }
    .section-badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 4px 10px; border-radius: 4px; font-size: 12px; }
    .badge.type { background: #e0e0e0; }
    .badge.style { background: #17a2b8; color: white; }
    .badge.high { background: #dc3545; color: white; }
    .badge.medium { background: #ffc107; color: #333; }
    .badge.low { background: #6c757d; color: white; }
    .section-desc { color: #333; font-size: 14px; line-height: 1.5; background: #f9f9f9; padding: 12px; border-radius: 6px; border-left: 4px solid #17a2b8; }
  </style>
</head>
<body>
  <h1>Visual Section Analysis</h1>
  <p class="url">${url}</p>

  <div class="page-info">
    <strong>Page Dimensions:</strong> ${result.pageWidth}px × ${result.pageHeight}px<br>
    <strong>Sections Identified:</strong> ${result.sections.length}<br>
    <strong>Method:</strong> Description-based (Claude identifies sections by visual description)
  </div>

  <h2>Full Page Screenshot</h2>
  <div class="screenshot-container">
    <img src="data:image/png;base64,${result.screenshot}" />
  </div>

  <div class="blocks-section">
    <h2>Identified Sections (${result.sections.length})</h2>
    ${result.sections.map((s, i) => `
      <div class="section-card">
        <div class="section-header">
          <h3 class="section-name">${i + 1}. ${s.name}</h3>
          <div class="section-badges">
            <span class="badge type">${s.type}</span>
            <span class="badge style">${s.style}</span>
            <span class="badge ${s.priority}">${s.priority}</span>
          </div>
        </div>
        <p class="section-desc">${s.description}</p>
      </div>
    `).join('')}
  </div>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Debug visual analysis failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: message, code: 'DEBUG_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Batch generation UI for multiple blocks
 */
function handleBatchUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Batch Block Generator</title>
  <style>
    body { font-family: system-ui; padding: 40px; max-width: 900px; margin: 0 auto; background: #f5f5f5; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .url-input { margin-bottom: 16px; display: flex; gap: 12px; }
    .url-input input { flex: 1; padding: 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 6px; }
    #analyzeBtn { padding: 12px 24px; font-size: 16px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; }
    #analyzeBtn:hover { background: #5a6268; }
    #analyzeBtn:disabled { background: #ccc; cursor: not-allowed; }
    .block-item { padding: 16px; margin: 8px 0; background: #fff; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .block-item.loading { background: #fff3cd; }
    .block-item.success { background: #d4edda; }
    .block-item.error { background: #f8d7da; }
    .block-item.analyzing { background: #cce5ff; }
    .block-info { flex: 1; }
    .block-info strong { display: block; margin-bottom: 4px; }
    .selector { font-family: monospace; font-size: 12px; color: #666; }
    .description { font-size: 13px; color: #555; margin-top: 4px; }
    .badge { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 4px; margin-left: 8px; }
    .badge.high { background: #dc3545; color: white; }
    .badge.medium { background: #ffc107; color: #333; }
    .badge.low { background: #6c757d; color: white; }
    .siblings { font-size: 12px; color: #28a745; font-weight: 500; margin-top: 2px; }
    .status { font-weight: 600; min-width: 100px; text-align: right; }
    button { padding: 8px 16px; cursor: pointer; }
    #startAll { font-size: 18px; padding: 14px 28px; background: #3b63fb; color: white; border: none; border-radius: 6px; margin-bottom: 24px; }
    #startAll:hover { background: #1d3ecf; }
    #startAll:disabled { background: #ccc; cursor: not-allowed; }
    .note { font-size: 13px; color: #888; margin-top: 20px; }
    .analyzing-msg { padding: 20px; text-align: center; color: #666; }
    #blocksContainer { margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>Batch Block Generator</h1>
  <p class="subtitle">Analyze any webpage to identify blocks, then generate them using Claude Vision</p>

  <div class="url-input">
    <input type="text" id="pageUrl" value="https://www.virginatlanticcargo.com/gb/en.html" placeholder="Page URL">
    <button id="analyzeBtn">Analyze Page</button>
  </div>

  <div id="blocksContainer">
    <div class="analyzing-msg">Enter a URL and click "Analyze Page" to identify content blocks</div>
  </div>

  <button id="startAll" style="display: none;">Generate All Blocks</button>
  <div id="blocks"></div>
  <p class="note" id="noteText" style="display: none;">All blocks run in parallel (Workers Paid: 30 concurrent browsers). ~20-40 seconds total.</p>

  <script>
    let identifiedBlocks = [];
    const blocksContainer = document.getElementById('blocksContainer');
    const blocksDiv = document.getElementById('blocks');
    const startAllBtn = document.getElementById('startAll');
    const noteText = document.getElementById('noteText');

    // Analyze page to identify blocks
    document.getElementById('analyzeBtn').onclick = async () => {
      const pageUrl = document.getElementById('pageUrl').value;
      const analyzeBtn = document.getElementById('analyzeBtn');

      analyzeBtn.disabled = true;
      analyzeBtn.textContent = 'Analyzing...';
      blocksContainer.innerHTML = '<div class="analyzing-msg">Analyzing page structure with Claude...</div>';
      startAllBtn.style.display = 'none';
      noteText.style.display = 'none';
      blocksDiv.innerHTML = '';

      try {
        const response = await fetch('/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: pageUrl })
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || 'Analysis failed');
        }

        identifiedBlocks = result.blocks || [];

        if (identifiedBlocks.length === 0) {
          blocksContainer.innerHTML = '<div class="analyzing-msg">No content blocks identified on this page</div>';
          return;
        }

        // Show identified blocks
        blocksContainer.innerHTML = '<h3>Identified Blocks (' + identifiedBlocks.length + ')</h3>';

        identifiedBlocks.forEach((block, i) => {
          const div = document.createElement('div');
          div.className = 'block-item';
          div.id = 'block-' + i;
          div.innerHTML = \`
            <div class="block-info">
              <strong>\${block.name} <span class="badge \${block.priority}">\${block.priority}</span> <span class="badge type">\${block.type}</span></strong>
              <div class="description">\${block.description}</div>
              <span class="selector" style="color: #17a2b8;">style: \${block.style}</span>
            </div>
            <span class="status">Ready</span>
          \`;
          blocksContainer.appendChild(div);
        });

        startAllBtn.style.display = 'block';
        noteText.style.display = 'block';

      } catch (err) {
        blocksContainer.innerHTML = '<div class="block-item error"><div>' + err.message + '</div></div>';
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = 'Analyze Page';
      }
    };

    // Concurrency limiter
    async function runWithConcurrency(tasks, limit) {
      const results = [];
      const executing = [];

      for (const task of tasks) {
        const p = task().then(r => {
          executing.splice(executing.indexOf(p), 1);
          return r;
        });
        results.push(p);
        executing.push(p);

        if (executing.length >= limit) {
          await Promise.race(executing);
        }
      }

      return Promise.all(results);
    }

    // Generate all identified blocks
    startAllBtn.onclick = async () => {
      const pageUrl = document.getElementById('pageUrl').value;
      startAllBtn.disabled = true;

      // Create task functions for each block
      const tasks = identifiedBlocks.map((block, i) => async () => {
        const div = document.getElementById('block-' + i);
        div.className = 'block-item loading';
        div.querySelector('.status').textContent = 'Generating...';

        try {
          const requestBody = {
            url: pageUrl,
            sectionDescription: block.description,
            sectionName: block.name
          };
          const response = await fetch('/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(err.error || 'Generation failed');
          }

          const html = await response.text();
          div.className = 'block-item success';
          div.querySelector('.status').textContent = 'Opening...';

          const newWindow = window.open('', '_blank');
          if (newWindow) {
            newWindow.document.write(html);
            newWindow.document.close();
            div.querySelector('.status').textContent = 'Done!';
          } else {
            div.querySelector('.status').textContent = 'Done (popup blocked)';
          }
        } catch (err) {
          div.className = 'block-item error';
          div.querySelector('.status').textContent = err.message;
        }
      });

      // Run with max 10 concurrent browser sessions
      await runWithConcurrency(tasks, 10);
      startAllBtn.disabled = false;
    };
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Parses and validates the request body
 * Supports both boundingBox (new) and selector (legacy)
 */
async function parseRequestBody(request: Request): Promise<BlockRequest> {
  const contentType = request.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    throw new BlockGeneratorError(
      'Content-Type must be application/json',
      'INVALID_REQUEST'
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BlockGeneratorError(
      'Invalid JSON in request body',
      'INVALID_REQUEST'
    );
  }

  if (!body || typeof body !== 'object') {
    throw new BlockGeneratorError(
      'Request body must be an object',
      'INVALID_REQUEST'
    );
  }

  const { url, selector, boundingBox, siblingSelectors, sectionDescription, sectionName } = body as Record<string, unknown>;

  if (typeof url !== 'string' || !url.trim()) {
    throw new BlockGeneratorError(
      'Missing or invalid "url" field',
      'INVALID_REQUEST'
    );
  }

  // Parse description-based approach (from /analyze)
  let parsedSectionDescription: string | undefined;
  let parsedSectionName: string | undefined;
  if (typeof sectionDescription === 'string' && sectionDescription.trim() &&
      typeof sectionName === 'string' && sectionName.trim()) {
    parsedSectionDescription = sectionDescription.trim();
    parsedSectionName = sectionName.trim();
  }

  // Parse bounding box if provided (new approach)
  let parsedBbox: { x: number; y: number; width: number; height: number } | undefined;
  if (boundingBox && typeof boundingBox === 'object') {
    const bbox = boundingBox as Record<string, unknown>;
    if (typeof bbox.x === 'number' && typeof bbox.y === 'number' &&
        typeof bbox.width === 'number' && typeof bbox.height === 'number') {
      parsedBbox = {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      };
    }
  }

  // Parse selector if provided (legacy approach)
  let parsedSelector: string | undefined;
  if (typeof selector === 'string' && selector.trim()) {
    parsedSelector = selector.trim();
  }

  // Require either sectionDescription+sectionName, boundingBox, or selector
  if (!parsedSectionDescription && !parsedBbox && !parsedSelector) {
    throw new BlockGeneratorError(
      'Either "sectionDescription"+"sectionName", "boundingBox", or "selector" is required',
      'INVALID_REQUEST'
    );
  }

  // Parse sibling selectors if provided (legacy)
  let parsedSiblings: string[] | undefined;
  if (Array.isArray(siblingSelectors)) {
    parsedSiblings = siblingSelectors.filter(s => typeof s === 'string' && s.trim()).map(s => (s as string).trim());
    if (parsedSiblings.length === 0) parsedSiblings = undefined;
  }

  return {
    url: url.trim(),
    selector: parsedSelector,
    boundingBox: parsedBbox,
    siblingSelectors: parsedSiblings,
    sectionDescription: parsedSectionDescription,
    sectionName: parsedSectionName,
  };
}

/**
 * Handles errors and returns appropriate response
 */
function handleError(error: unknown, env: Env): Response {
  if (error instanceof BlockGeneratorError) {
    const response: ErrorResponse = {
      success: false,
      error: error.message,
      code: error.code,
    };

    return Response.json(response, {
      status: error.statusCode,
      headers: corsHeaders(env),
    });
  }

  // Unknown error
  console.error('Unexpected error:', error);

  const response: ErrorResponse = {
    success: false,
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  };

  return Response.json(response, {
    status: 500,
    headers: corsHeaders(env),
  });
}

/**
 * Returns CORS headers
 */
function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

/**
 * Handles CORS preflight requests
 */
function handleCORS(env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
