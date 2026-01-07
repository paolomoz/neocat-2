import { Browser } from '@cloudflare/puppeteer';
import { AnthropicConfig } from './design-analyzer';

/**
 * Block code structure
 */
export interface BlockCode {
  html: string;
  css: string;
  js: string;
  blockName?: string;
}

/**
 * Refinement result
 */
export interface RefinementResult {
  block: BlockCode;
  refinementApplied: boolean;
  refinementNotes?: string;
  generatedScreenshot?: string; // Base64 of the rendered block screenshot
}

/**
 * Compress an image for Claude API (5MB limit)
 * Returns { data: base64, mediaType: 'image/png' | 'image/jpeg' }
 */
async function compressImageForClaude(
  browser: Browser,
  base64Image: string,
  maxSizeBytes: number = 4 * 1024 * 1024
): Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg' }> {
  const approxSize = (base64Image.length * 3) / 4;

  if (approxSize <= maxSizeBytes) {
    return { data: base64Image, mediaType: 'image/png' };
  }

  console.log(`  Compressing image for Claude (${(approxSize / 1024 / 1024).toFixed(2)}MB)...`);

  const page = await browser.newPage();
  try {
    const scaleFactor = Math.sqrt(maxSizeBytes / approxSize) * 0.9;

    const compressedBase64 = await page.evaluate(async (imgData: string, scale: number) => {
      return new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const newWidth = Math.floor(img.width * scale);
          const newHeight = Math.floor(img.height * scale);
          canvas.width = newWidth;
          canvas.height = newHeight;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
          }

          ctx.drawImage(img, 0, 0, newWidth, newHeight);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl.split(',')[1]);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = 'data:image/png;base64,' + imgData;
      });
    }, base64Image, scaleFactor);

    const newSize = (compressedBase64.length * 3) / 4;
    console.log(`  Compressed to ${(newSize / 1024 / 1024).toFixed(2)}MB`);

    return { data: compressedBase64, mediaType: 'image/jpeg' };
  } finally {
    await page.close();
  }
}

/**
 * Render a block (HTML/CSS/JS) in Puppeteer and capture a screenshot
 */
export async function renderBlockToScreenshot(
  browser: Browser,
  block: BlockCode,
  viewport: { width: number; height: number } = { width: 1440, height: 900 }
): Promise<string> {
  const page = await browser.newPage();

  try {
    await page.setViewport(viewport);

    // Create an HTML page that renders the block
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    ${block.css}
  </style>
</head>
<body>
  ${block.html}
  <script type="module">
    ${block.js}
    // Auto-run decorate if it exists
    if (typeof decorate === 'function') {
      const block = document.querySelector('[class]');
      if (block) decorate(block);
    }
  </script>
</body>
</html>`;

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    // Wait for all images to load
    await page.evaluate(async () => {
      const images = Array.from(document.querySelectorAll('img'));
      await Promise.all(images.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve; // Don't fail on broken images
          // Timeout after 5 seconds
          setTimeout(resolve, 5000);
        });
      }));
    });

    // Wait a bit for any animations/transitions to settle
    await new Promise(resolve => setTimeout(resolve, 500));

    // Take screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height }
    });

    // Convert to base64
    const base64 = Buffer.from(screenshot).toString('base64');
    return base64;

  } finally {
    await page.close();
  }
}

/**
 * Extract all URLs from HTML (src, href attributes)
 */
function extractUrlsFromHtml(html: string): Map<string, string[]> {
  const urlMap = new Map<string, string[]>();

  // Extract src attributes (images, videos, etc.)
  const srcMatches = html.matchAll(/src=["']([^"']+)["']/gi);
  for (const match of srcMatches) {
    if (!urlMap.has('src')) urlMap.set('src', []);
    urlMap.get('src')!.push(match[1]);
  }

  // Extract href attributes (links)
  const hrefMatches = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of hrefMatches) {
    if (!urlMap.has('href')) urlMap.set('href', []);
    urlMap.get('href')!.push(match[1]);
  }

  // Extract background-image URLs from inline styles
  const bgMatches = html.matchAll(/url\(["']?([^"')]+)["']?\)/gi);
  for (const match of bgMatches) {
    if (!urlMap.has('bg')) urlMap.set('bg', []);
    urlMap.get('bg')!.push(match[1]);
  }

  return urlMap;
}

/**
 * Restore original URLs in refined HTML
 */
function restoreOriginalUrls(refinedHtml: string, originalHtml: string): string {
  const originalUrls = extractUrlsFromHtml(originalHtml);
  let result = refinedHtml;

  // Get original src URLs
  const originalSrcs = originalUrls.get('src') || [];
  let srcIndex = 0;

  // Replace src attributes with original URLs in order
  result = result.replace(/src=["']([^"']+)["']/gi, (match, currentUrl) => {
    // If this URL is already one of the originals, keep it
    if (originalSrcs.includes(currentUrl)) {
      return match;
    }
    // Otherwise, replace with the next original URL
    if (srcIndex < originalSrcs.length) {
      const originalUrl = originalSrcs[srcIndex++];
      console.log(`Restored URL: "${currentUrl.substring(0, 50)}..." → "${originalUrl.substring(0, 50)}..."`);
      return `src="${originalUrl}"`;
    }
    return match;
  });

  // Get original href URLs
  const originalHrefs = originalUrls.get('href') || [];
  let hrefIndex = 0;

  // Replace href attributes with original URLs in order
  result = result.replace(/href=["']([^"']+)["']/gi, (match, currentUrl) => {
    if (originalHrefs.includes(currentUrl)) {
      return match;
    }
    if (hrefIndex < originalHrefs.length) {
      const originalUrl = originalHrefs[hrefIndex++];
      return `href="${originalUrl}"`;
    }
    return match;
  });

  return result;
}

/**
 * Analyze visual differences and suggest refinements using Claude Vision
 */
export async function analyzeAndRefine(
  originalScreenshotBase64: string,
  generatedScreenshotBase64: string,
  currentBlock: BlockCode,
  config: AnthropicConfig,
  userPrompt?: string,
  originalMediaType: 'image/png' | 'image/jpeg' = 'image/png',
  generatedMediaType: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<BlockCode> {
  let focusInstructions = `Focus on:
- Colors (backgrounds, text, borders)
- Spacing (padding, margins, gaps)
- Typography (font sizes, weights, line heights)
- Layout (flexbox/grid properties, alignment)
- Dimensions (widths, heights)`;

  if (userPrompt) {
    focusInstructions = `IMPORTANT USER INSTRUCTIONS:
${userPrompt}

Also consider:
- Colors (backgrounds, text, borders)
- Spacing (padding, margins, gaps)
- Typography (font sizes, weights, line heights)
- Layout (flexbox/grid properties, alignment)
- Dimensions (widths, heights)`;
  }

  const prompt = `You are an expert CSS developer. I'm showing you two images:
1. The ORIGINAL design (target) - this is what we want to match
2. The GENERATED block (current attempt) - this is what we've created so far

Compare these two images visually and identify the differences.

The current block code is:

HTML:
\`\`\`html
${currentBlock.html}
\`\`\`

CSS:
\`\`\`css
${currentBlock.css}
\`\`\`

JavaScript:
\`\`\`javascript
${currentBlock.js}
\`\`\`

Analyze the visual differences and provide REFINED code that will make the generated block look MORE like the original.

## CRITICAL RULES - DO NOT VIOLATE

1. **NEVER change any URLs** - Keep ALL src="..." and href="..." values EXACTLY as they are
2. **NEVER change image URLs** - The image sources must remain identical
3. **NEVER change link URLs** - All href values must stay the same
4. **Only modify CSS and HTML structure** - Fix styling, not content
5. **BACKGROUND COLORS - ABSOLUTELY CRITICAL**:
   - NEVER add background-color or background to the block container (.{block-name}) - THIS WILL BREAK THE DESIGN
   - The colored section background (light blue, green, gray, etc.) in the original is NOT part of the block
   - Section backgrounds are controlled by AEM section metadata - do NOT replicate them in block CSS
   - For internal card/item elements: use background-color: #fff (white) ONLY if needed for visual separation
   - If you think "the section needs a light green background" - STOP, that is WRONG
6. **INTERACTIVE ELEMENTS**:
   - If the original has carousel navigation (arrows, dots), ensure the JS makes them functional
   - Navigation must use click handlers, not just visual elements
   - Carousel should use translateX() transforms for smooth sliding
7. **IMAGE SIZING - CRITICAL**:
   - Images must display at their ORIGINAL/NATURAL size to match the source design
   - Use CSS: max-width: none; width: auto; height: auto; to preserve original dimensions
   - DO NOT force aspect-ratio or object-fit: cover unless the design clearly crops images
   - For logos, badges, icons: let them render at natural size
   - If an image appears at a specific size in the original, match that exact width
8. **BACKGROUND IMAGES (decorative patterns/shapes)**:
   - Decorative background images (waves, shapes, patterns) should be <img> elements, NOT CSS background-image
   - Position them absolutely with z-index: 0 or -1 to place behind content
   - Match the original background-size and background-position from the source design
   - Parent container needs position: relative

${focusInstructions}

Return ONLY a JSON object with the refined code:
{
  "html": "refined HTML with EXACT SAME URLs",
  "css": "refined CSS here",
  "js": "refined JavaScript here",
  "notes": "brief description of what was changed"
}

Make targeted changes to fix the visual differences you observe. DO NOT CHANGE ANY URLs.`;

  const response = await callClaudeWithImages(
    [originalScreenshotBase64, generatedScreenshotBase64],
    ['Original design (target)', 'Generated block (current)'],
    [originalMediaType, generatedMediaType],
    prompt,
    config
  );

  // Parse response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse refinement response from Claude');
  }

  const refined = JSON.parse(jsonMatch[0]) as {
    html: string;
    css: string;
    js: string;
    notes?: string;
  };

  // CRITICAL: Restore original URLs - Claude might have changed them despite instructions
  const restoredHtml = restoreOriginalUrls(refined.html, currentBlock.html);

  return {
    html: restoredHtml,
    css: refined.css,
    js: refined.js,
    blockName: currentBlock.blockName
  };
}

/**
 * Helper to call Claude API with multiple images
 */
async function callClaudeWithImages(
  imagesBase64: string[],
  imageLabels: string[],
  imageMediaTypes: Array<'image/png' | 'image/jpeg'>,
  prompt: string,
  config: AnthropicConfig,
  maxTokens: number = 8192
): Promise<string> {
  // Build content array with all images
  const content: Array<{ type: string; source?: any; text?: string }> = [];

  for (let i = 0; i < imagesBase64.length; i++) {
    content.push({
      type: 'text',
      text: `Image ${i + 1}: ${imageLabels[i]}`
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMediaTypes[i] || 'image/png',
        data: imagesBase64[i]
      }
    });
  }

  content.push({
    type: 'text',
    text: prompt
  });

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

/**
 * Full refinement pipeline: render, analyze with Claude Vision, refine
 */
export async function refineBlock(
  browser: Browser,
  originalScreenshotBase64: string,
  currentBlock: BlockCode,
  config: AnthropicConfig,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
  userPrompt?: string
): Promise<RefinementResult> {
  // Step 1: Render current block
  console.log('Rendering generated block...');
  const generatedScreenshot = await renderBlockToScreenshot(browser, currentBlock, viewport);

  // Step 2: Compress images for Claude API (5MB limit)
  console.log('Preparing images for Claude Vision...');
  const compressedOriginal = await compressImageForClaude(browser, originalScreenshotBase64);
  const compressedGenerated = await compressImageForClaude(browser, generatedScreenshot);

  // Step 3: Analyze and refine using Claude Vision
  console.log('Analyzing differences with Claude Vision...');
  if (userPrompt) {
    console.log(`  User prompt: ${userPrompt.substring(0, 100)}...`);
  }

  const refinedBlock = await analyzeAndRefine(
    compressedOriginal.data,
    compressedGenerated.data,
    currentBlock,
    config,
    userPrompt,
    compressedOriginal.mediaType,
    compressedGenerated.mediaType
  );

  // Step 4: Re-render refined block for preview
  console.log('Re-rendering refined block...');
  const refinedScreenshot = await renderBlockToScreenshot(browser, refinedBlock, viewport);

  return {
    block: refinedBlock,
    refinementApplied: true,
    refinementNotes: 'Refined using Claude Vision analysis',
    generatedScreenshot: refinedScreenshot
  };
}
