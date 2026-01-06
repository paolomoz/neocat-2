import { parseHTML } from 'linkedom';
import { AnthropicConfig } from './design-analyzer';

/**
 * Detailed component description from Claude
 */
export interface ComponentDescription {
  componentType: string;  // e.g., "hero-with-overlay", "card-grid", "feature-columns"
  structure: {
    layout: string;       // e.g., "full-width image with left-aligned text overlay"
    layers?: string[];    // e.g., ["background-image", "overlay", "text-content"]
    contentHierarchy: string[];  // e.g., ["heading", "subheading", "paragraph", "cta"]
    gridInfo?: {
      columns: number;
      rows: number;
      itemStructure: string[];  // e.g., ["image", "title", "description"]
    };
  };
  design: {
    colorScheme: string;      // e.g., "dark overlay on light image"
    backgroundTreatment?: string;  // e.g., "full-bleed image with gradient overlay"
    textStyle: string;        // e.g., "white text on dark, large bold heading"
    spacing: string;          // e.g., "generous padding, tight line height"
    effects?: string[];       // e.g., ["box-shadow", "rounded-corners", "hover-scale"]
  };
  contentElements: {
    headings: string[];
    paragraphs: string[];
    images: Array<{ description: string; role: string }>;  // role: "background", "icon", "photo"
    ctas: Array<{ text: string; style: string }>;  // style: "primary-button", "text-link"
  };
}

/**
 * Enhanced generated block with richer metadata
 */
export interface EnhancedBlockCode {
  blockName: string;
  componentType: string;
  html: string;
  css: string;
  js: string;
  description: ComponentDescription;
}

/**
 * Step 1: Describe the component in detail
 */
export async function describeComponent(
  screenshotBase64: string,
  config: AnthropicConfig,
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<ComponentDescription> {
  const prompt = `Analyze this web component screenshot in detail.

Describe:
1. **Component Type**: What kind of component is this? (e.g., hero-banner, card-grid, feature-section, testimonial-carousel)

2. **Structure**:
   - Layout: How is content arranged? (e.g., "full-width with centered content", "2-column with image left")
   - Layers: What visual layers exist? (e.g., background image, overlay, content box)
   - Content Hierarchy: What content elements exist in order? (e.g., eyebrow, heading, paragraph, CTA)
   - If it's a grid/cards: How many columns/rows? What's in each item?

3. **Design**:
   - Color scheme: Describe the colors and contrast
   - Background treatment: How is the background styled?
   - Text style: Typography choices (size, weight, color)
   - Spacing: Padding, margins, gaps
   - Effects: Any shadows, rounded corners, gradients, hover states?

4. **Content Elements**: List the actual content visible:
   - Headings (exact text)
   - Paragraphs (first few words)
   - Images (describe each, note if background/icon/photo)
   - CTAs (button/link text and style)

Return as JSON:
{
  "componentType": "hero-with-overlay",
  "structure": {
    "layout": "full-width background image with text content in semi-transparent box on left",
    "layers": ["full-bleed-background-image", "left-aligned-overlay-box", "text-content"],
    "contentHierarchy": ["main-heading", "paragraph", "expand-link"]
  },
  "design": {
    "colorScheme": "colorful image background, dark semi-transparent overlay, white text",
    "backgroundTreatment": "full-bleed industrial image with colorful pipes",
    "textStyle": "large serif heading (48px+), regular sans-serif body, all white",
    "spacing": "large padding in overlay box (40px+), comfortable line-height",
    "effects": ["semi-transparent-background rgba(0,0,0,0.7)"]
  },
  "contentElements": {
    "headings": ["Sherwin-Williams Industrial Coatings"],
    "paragraphs": ["Operating in more than 120 countries..."],
    "images": [{"description": "Colorful industrial pipes", "role": "background"}],
    "ctas": [{"text": "Expand to read more", "style": "text-link-with-icon"}]
  }
}

Return ONLY the JSON object.`;

  const response = await callClaude(screenshotBase64, prompt, config, imageMediaType);

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');
    return JSON.parse(match[0]) as ComponentDescription;
  } catch (e) {
    console.error('Failed to parse component description:', response);
    throw new Error('Failed to parse component description');
  }
}

/**
 * Step 2: Extract content guided by the description
 */
export function extractContentGuided(
  elementHtml: string,
  description: ComponentDescription,
  baseUrl: string
): ExtractedContent {
  // Parse the HTML using linkedom
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${elementHtml}</body></html>`);
  const root = document.body.firstElementChild || document.body;

  const content: ExtractedContent = {
    headings: [],
    paragraphs: [],
    images: [],
    ctas: [],
    structure: description.structure,
  };

  // Extract headings in hierarchy order
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h: any) => {
    const text = (h.textContent || '').trim();
    if (text) {
      content.headings.push({
        level: parseInt(h.tagName[1]),
        text,
      });
    }
  });

  // Extract paragraphs
  root.querySelectorAll('p').forEach((p: any) => {
    const text = (p.textContent || '').trim();
    if (text && text.length > 10) {
      content.paragraphs.push(text);
    }
  });

  // Extract images with role hints from description
  // Helper to check if URL is a placeholder/spacer image
  function isPlaceholderImage(url: string): boolean {
    if (!url) return true;
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes('clear.gif') ||
           lowerUrl.includes('spacer.gif') ||
           lowerUrl.includes('blank.gif') ||
           lowerUrl.includes('pixel.gif') ||
           lowerUrl.includes('1x1') ||
           lowerUrl.includes('placeholder') ||
           lowerUrl.startsWith('data:image/gif;base64,R0lGOD') || // 1x1 transparent GIF
           (lowerUrl.startsWith('data:') && lowerUrl.length < 100); // Very small data URI
  }

  // Helper to resolve URL
  function resolveUrl(src: string): string {
    if (!src) return '';
    if (src.startsWith('http')) return src;
    if (src.startsWith('data:')) return src;
    if (src.startsWith('//')) return 'https:' + src;
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return '';
    }
  }

  // Helper to find best image source from an img element
  function getBestImageSrc(img: any): string {
    // Priority order for finding real image URL:
    // 1. data-src, data-lazy-src, data-original (lazy loading patterns)
    // 2. srcset (responsive images) - extract first/largest URL
    // 3. data-srcset
    // 4. src (only if not a placeholder)

    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-image'];
    for (const attr of lazyAttrs) {
      const val = img.getAttribute(attr);
      if (val && !isPlaceholderImage(val)) {
        return resolveUrl(val);
      }
    }

    // Check srcset - extract highest resolution image
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      const srcsetParts = srcset.split(',').map((s: string) => s.trim().split(/\s+/)[0]);
      for (const srcPart of srcsetParts) {
        if (srcPart && !isPlaceholderImage(srcPart)) {
          return resolveUrl(srcPart);
        }
      }
    }

    // Finally try src, but skip if it's a placeholder
    const src = img.getAttribute('src');
    if (src && !isPlaceholderImage(src)) {
      return resolveUrl(src);
    }

    return '';
  }

  root.querySelectorAll('img').forEach((img: any) => {
    const src = getBestImageSrc(img);

    if (src && !isPlaceholderImage(src)) {
      const alt = img.getAttribute('alt') || '';
      const parentClasses = (img.parentElement?.className || '').toLowerCase();
      let role = 'photo';

      // Determine role from context
      if (parentClasses.includes('background') || parentClasses.includes('hero') || parentClasses.includes('banner')) {
        role = 'background';
      } else if (parentClasses.includes('icon') || (img.getAttribute('width') && parseInt(img.getAttribute('width')) < 100)) {
        role = 'icon';
      }

      content.images.push({ src, alt, role });
    }
  });

  // Also check picture elements for source tags
  root.querySelectorAll('picture source').forEach((source: any) => {
    const srcset = source.getAttribute('srcset');
    if (srcset) {
      const srcPart = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (srcPart && !isPlaceholderImage(srcPart)) {
        const src = resolveUrl(srcPart);
        if (src && !content.images.some(i => i.src === src)) {
          content.images.push({ src, alt: '', role: 'photo' });
        }
      }
    }
  });

  // Also check for background images in style attributes and data attributes
  root.querySelectorAll('*').forEach((el: any) => {
    // Check inline style for background-image
    const style = el.getAttribute('style') || '';
    if (style.includes('background')) {
      const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
      if (urlMatch) {
        const src = resolveUrl(urlMatch[1]);
        if (src && !isPlaceholderImage(src) && !content.images.some(i => i.src === src)) {
          content.images.push({ src, alt: 'Background', role: 'background' });
        }
      }
    }

    // Check data-background attributes (common lazy-loading pattern)
    const bgAttrs = ['data-background', 'data-bg', 'data-background-image', 'data-image-src'];
    for (const attr of bgAttrs) {
      const bgSrc = el.getAttribute(attr);
      if (bgSrc) {
        const src = resolveUrl(bgSrc);
        if (src && !isPlaceholderImage(src) && !content.images.some(i => i.src === src)) {
          content.images.push({ src, alt: 'Background', role: 'background' });
        }
      }
    }
  });

  // Extract CTAs (buttons and prominent links)
  root.querySelectorAll('a, button').forEach((el: any) => {
    const text = (el.textContent || '').trim();
    if (text && text.length > 1 && text.length < 50) {
      const href = el.getAttribute('href') || '';
      const className = (el.className || '').toLowerCase();
      const isButton = el.tagName === 'BUTTON' || className.includes('btn') || className.includes('button');

      let fullHref = '';
      if (href && href !== '#') {
        try {
          fullHref = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        } catch {}
      }

      content.ctas.push({
        text,
        href: fullHref,
        style: isButton ? 'button' : 'link',
      });
    }
  });

  return content;
}

interface ExtractedContent {
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  images: Array<{ src: string; alt: string; role: string }>;
  ctas: Array<{ text: string; href: string; style: string }>;
  structure: ComponentDescription['structure'];
}

/**
 * Step 3: Generate code with full context
 */
export async function generateCodeEnhanced(
  screenshotBase64: string,
  description: ComponentDescription,
  extractedContent: ExtractedContent,
  config: AnthropicConfig,
  extractedCssStyles?: string,
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<EnhancedBlockCode> {
  // Build numbered image reference list - Claude will use these by index
  const imageRefList = extractedContent.images.length > 0
    ? `
AVAILABLE IMAGES (use ONLY these by reference number):
${extractedContent.images.map((img, i) => `[IMG_${i + 1}] - ${img.alt || 'image'} (${img.role})`).join('\n')}

CRITICAL: When you need an image in your HTML, use data-img-ref attribute with the number:
  <img data-img-ref="1" alt="description">
DO NOT write any src attribute. I will inject the real URLs automatically.
DO NOT invent or guess image URLs. ONLY use the numbered references above.
`
    : '';

  // Build a rich prompt with all context
  const contentSummary = `
EXTRACTED CONTENT:
- Headings: ${extractedContent.headings.map(h => `H${h.level}: "${h.text}"`).join(', ')}
- Paragraphs: ${extractedContent.paragraphs.map(p => `"${p.substring(0, 50)}..."`).join(', ')}
- CTAs: ${extractedContent.ctas.map(c => `"${c.text}" (${c.style}) -> ${c.href}`).join(', ')}
${imageRefList}`;

  const structureSummary = `
COMPONENT ANALYSIS:
- Type: ${description.componentType}
- Layout: ${description.structure.layout}
- Layers: ${description.structure.layers?.join(' → ') || 'N/A'}
- Content hierarchy: ${description.structure.contentHierarchy.join(' → ')}
${description.structure.gridInfo ? `- Grid: ${description.structure.gridInfo.columns} columns, items have: ${description.structure.gridInfo.itemStructure.join(', ')}` : ''}

DESIGN NOTES:
- Colors: ${description.design.colorScheme}
- Background: ${description.design.backgroundTreatment || 'N/A'}
- Typography: ${description.design.textStyle}
- Spacing: ${description.design.spacing}
- Effects: ${description.design.effects?.join(', ') || 'none'}
`;

  // Include extracted CSS if available
  const cssSection = extractedCssStyles ? `
${extractedCssStyles}

IMPORTANT: Use the EXACT CSS values above. These are the actual computed styles from the original page.
Do not guess colors, fonts, or spacing - use these values directly in your CSS.
` : '';

  const prompt = `Generate an AEM Edge Delivery Services (EDS) block that recreates this component.

${structureSummary}

${contentSummary}
${cssSection}
## EDS Block Requirements

HTML structure - ONE ROW = ONE ITEM (card, slide, etc.):
\`\`\`html
<div class="{block-name}">
  <div><!-- row 1 = item 1 -->
    <div><!-- cell 1: image --></div>
    <div><!-- cell 2: title --></div>
    <div><!-- cell 3: description --></div>
    <div><!-- cell 4: link --></div>
  </div>
  <div><!-- row 2 = item 2 -->
    <div><!-- cell 1 --></div>
    <div><!-- cell 2 --></div>
    <div><!-- cell 3 --></div>
    <div><!-- cell 4 --></div>
  </div>
</div>
\`\`\`

CRITICAL: Each row is ONE complete content item. Cells within a row are that item's properties.
The JS decorate function iterates block.children as ROWS, each row.children are CELLS.

JS Pattern (MUST follow this):
\`\`\`js
export default function decorate(block) {
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    // cells[0] = first property (e.g., image)
    // cells[1] = second property (e.g., title)
    row.classList.add('item');
    if (cells[0]) cells[0].classList.add('item-image');
    if (cells[1]) cells[1].classList.add('item-title');
  });
}
\`\`\`
DO NOT clear innerHTML. DO NOT expect multiple rows per item. DO NOT use type/value pairs.

## Critical Instructions

1. **Match the visual design EXACTLY** - use the screenshot AND the extracted CSS values
2. **Use the EXACT content** from EXTRACTED CONTENT above - real text, real CTAs
3. **Follow the structure** described in COMPONENT ANALYSIS
4. **Use the EXACT CSS values** from EXTRACTED CSS STYLES - do not guess colors or fonts
5. **Key visual elements to match**:
   - Is the image ABOVE the text (card layout) or BEHIND the text (overlay layout)?
   - What is the exact heading color? Use it.
   - What is the exact font-size? Use it.
   - Is there a card background or is content directly on the page?
6. **IMAGES: Use data-img-ref="N" attribute ONLY** - reference images by their [IMG_N] number
   - Example: <img data-img-ref="1" alt="Logo">
   - NEVER write src="..." - I will inject real URLs
   - NEVER invent, guess, or use placeholder URLs
7. **CTA/LINK STYLING - CRITICAL**: EDS renders isolated <a> tags as buttons by default (with background, padding, border-radius).
   - Look at the original screenshot: are CTAs styled as BUTTONS or TEXT LINKS?
   - If the original shows TEXT LINKS (no background, just colored text with maybe an arrow):
     Your CSS MUST override EDS defaults: background: none; border: none; padding: 0; border-radius: 0;
   - If the original shows BUTTONS with backgrounds, match that exact background color.
   - ALWAYS match the original visual appearance, not EDS defaults.
8. **BACKGROUND COLORS - CRITICAL**: Be conservative with backgrounds.
   - If the section background appears WHITE or very light/neutral in the screenshot, use: background-color: white; or background: transparent;
   - Do NOT add tinted backgrounds (lavender, pink, cream) unless they are CLEARLY visible in the original.
   - When in doubt, use white or transparent - not a guessed color.

## Return Format

Return JSON:
{
  "blockName": "descriptive-block-name",
  "html": "<!-- EDS block markup with actual content -->",
  "css": "/* Complete CSS using the EXACT extracted values */",
  "js": "/* ES module: export default function decorate(block) { ... } */"
}

Return ONLY the JSON object.`;

  const response = await callClaude(screenshotBase64, prompt, config, imageMediaType, 8192);

  try {
    // Try code block first
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
      blockName: parsed.blockName,
      componentType: description.componentType,
      html: parsed.html,
      css: parsed.css,
      js: parsed.js,
      description,
    };
  } catch (e) {
    console.error('Failed to parse generated code:', response.substring(0, 500));
    throw new Error('Failed to parse generated code');
  }
}

/**
 * Post-process generated HTML to inject real image URLs
 * Replaces data-img-ref="N" attributes with actual src URLs
 */
function injectImageUrls(
  html: string,
  images: Array<{ src: string; alt: string; role: string }>
): string {
  if (!images.length) return html;

  let result = html;
  let injectedCount = 0;

  // Replace data-img-ref="N" with src="actual-url"
  // Matches: <img data-img-ref="1" ...> or <img ... data-img-ref="1" ...>
  result = result.replace(
    /<img([^>]*?)data-img-ref=["'](\d+)["']([^>]*?)>/gi,
    (match, before, refNum, after) => {
      const index = parseInt(refNum, 10) - 1; // Convert 1-based to 0-based
      if (index >= 0 && index < images.length) {
        const img = images[index];
        injectedCount++;
        // Remove data-img-ref and add src
        const cleanBefore = before.replace(/\s*src=["'][^"']*["']/gi, '');
        const cleanAfter = after.replace(/\s*src=["'][^"']*["']/gi, '');
        return `<img${cleanBefore} src="${img.src}"${cleanAfter}>`;
      }
      console.warn(`Image reference ${refNum} out of bounds (have ${images.length} images)`);
      return match;
    }
  );

  // Also handle case where Claude wrote src="" or src="placeholder"
  // Replace any remaining placeholder/empty src with first unused image
  const usedIndices = new Set<number>();
  result.replace(/data-img-ref=["'](\d+)["']/gi, (_, num) => {
    usedIndices.add(parseInt(num, 10) - 1);
    return '';
  });

  // Find images with placeholder URLs and replace them
  let unusedImageIndex = 0;
  result = result.replace(
    /<img([^>]*?)src=["']([^"']*)["']([^>]*?)>/gi,
    (match, before, currentSrc, after) => {
      // Skip if it's already a real URL from our images
      if (images.some(img => img.src === currentSrc)) {
        return match;
      }

      // Skip if it looks like a valid external URL (not placeholder)
      if (currentSrc.startsWith('http') &&
          !currentSrc.includes('placeholder') &&
          !currentSrc.includes('example.com') &&
          !currentSrc.includes('via.placeholder') &&
          !currentSrc.includes('picsum') &&
          !currentSrc.includes('unsplash.it')) {
        return match;
      }

      // Find next unused image
      while (unusedImageIndex < images.length && usedIndices.has(unusedImageIndex)) {
        unusedImageIndex++;
      }

      if (unusedImageIndex < images.length) {
        const img = images[unusedImageIndex];
        usedIndices.add(unusedImageIndex);
        unusedImageIndex++;
        injectedCount++;
        console.log(`Replaced placeholder "${currentSrc}" with "${img.src}"`);
        return `<img${before} src="${img.src}"${after}>`;
      }

      return match;
    }
  );

  console.log(`Injected ${injectedCount} image URLs into generated HTML`);
  return result;
}

/**
 * Live image extracted from rendered page
 */
export interface LiveImage {
  src: string;
  alt: string;
  role: 'photo' | 'background' | 'icon';
}

/**
 * Full enhanced generation pipeline
 */
export async function generateBlockEnhanced(
  screenshotBase64: string,
  elementHtml: string,
  baseUrl: string,
  config: AnthropicConfig,
  extractedCssStyles?: string,
  liveImages?: LiveImage[],
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<EnhancedBlockCode> {
  console.log(`generateBlockEnhanced: received imageMediaType=${imageMediaType}`);
  console.log('Step 1: Describing component...');
  const description = await describeComponent(screenshotBase64, config, imageMediaType);
  console.log(`  Component type: ${description.componentType}`);
  console.log(`  Layout: ${description.structure.layout}`);

  console.log('Step 2: Extracting content with guidance...');
  const content = extractContentGuided(elementHtml, description, baseUrl);

  // Merge live images with extracted images (live images take priority - they're the real URLs)
  if (liveImages && liveImages.length > 0) {
    console.log(`  Merging ${liveImages.length} live images with extracted content`);
    const seenUrls = new Set(liveImages.map(i => i.src));

    // Replace extracted images with live images (which have the real URLs, not placeholders)
    content.images = liveImages.map(img => ({
      src: img.src,
      alt: img.alt,
      role: img.role,
    }));

    // Add any additional images from extraction that weren't found live (unlikely but possible)
    // This is commented out because live images should be the authoritative source
    // for (const img of extractedImages) {
    //   if (!seenUrls.has(img.src)) {
    //     content.images.push(img);
    //   }
    // }
  }

  console.log(`  Found: ${content.headings.length} headings, ${content.images.length} images, ${content.ctas.length} CTAs`);

  console.log('Step 3: Generating code...');
  if (extractedCssStyles) {
    console.log('  Including extracted CSS styles in generation');
  }
  const block = await generateCodeEnhanced(screenshotBase64, description, content, config, extractedCssStyles, imageMediaType);
  console.log(`  Generated block: ${block.blockName}`);

  // Step 4: Post-process to inject real image URLs
  console.log('Step 4: Injecting real image URLs...');
  block.html = injectImageUrls(block.html, content.images);

  return block;
}

/**
 * Helper to call Claude API
 */
async function callClaude(
  imageBase64: string,
  prompt: string,
  config: AnthropicConfig,
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png',
  maxTokens: number = 4096
): Promise<string> {
  console.log(`callClaude: using media type ${imageMediaType}, image length ${imageBase64.length}`);
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
              { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
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
              { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
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
