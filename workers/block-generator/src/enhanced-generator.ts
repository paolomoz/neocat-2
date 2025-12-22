import { parseHTML } from 'linkedom';
import { callLLMWithVision, ImageContent } from './llm-service';
import { Env, LLMModel } from './types';

/**
 * EDS Content Model Type (from content-modeling skill)
 * - standalone: Distinct visual or narrative element (Hero, Blockquote)
 * - collection: Repeating semi-structured content (Cards, Carousel)
 * - configuration: API-driven or dynamic content with key/value config
 * - auto-blocked: Complex structures transformed from sections
 */
export type EDSContentModelType = 'standalone' | 'collection' | 'configuration' | 'auto-blocked';

/**
 * Detailed component description from Claude
 */
export interface ComponentDescription {
  componentType: string;  // e.g., "hero-with-overlay", "card-grid", "feature-columns"
  edsModelType: EDSContentModelType;  // EDS content model classification
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
  env: Env,
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png',
  llmModel: LLMModel = 'claude-sonnet'
): Promise<ComponentDescription> {
  const prompt = `Analyze this web component screenshot in detail for AEM Edge Delivery Services (EDS).

Describe:
1. **Component Type**: What kind of component is this? (e.g., hero-banner, card-grid, feature-section, testimonial-carousel)

2. **EDS Content Model Type**: Classify as one of:
   - "standalone": A distinct, unique visual element that typically appears once (Hero, Blockquote, Banner)
   - "collection": Repeating similar items in a grid/list pattern (Cards, Team Members, Features grid)
   - "configuration": Would need API or dynamic data with key/value config settings
   - "auto-blocked": Complex nested structure that would be better authored as sections

3. **Structure**:
   - Layout: How is content arranged? (e.g., "full-width with centered content", "2-column with image left")
   - Layers: What visual layers exist? (e.g., background image, overlay, content box)
   - Content Hierarchy: What content elements exist in order? (e.g., eyebrow, heading, paragraph, CTA)
   - If it's a grid/cards: How many columns/rows? What's in each item?

4. **Design**:
   - Color scheme: Describe the colors and contrast
   - Background treatment: How is the background styled?
   - Text style: Typography choices (size, weight, color)
   - Spacing: Padding, margins, gaps
   - Effects: Any shadows, rounded corners, gradients, hover states?

5. **Content Elements**: List the actual content visible:
   - Headings (exact text)
   - Paragraphs (first few words)
   - Images (describe each, note if background/icon/photo)
   - CTAs (button/link text and style)

Return as JSON:
{
  "componentType": "hero-with-overlay",
  "edsModelType": "standalone",
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

  const images: ImageContent[] = [{
    base64: screenshotBase64,
    mediaType: imageMediaType,
    label: 'Component screenshot'
  }];

  const response = await callLLMWithVision(images, prompt, { model: llmModel, env });

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
  env: Env,
  extractedCssStyles?: string,
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png',
  llmModel: LLMModel = 'claude-sonnet'
): Promise<EnhancedBlockCode> {
  // Build a rich prompt with all context
  const contentSummary = `
EXTRACTED CONTENT:
- Headings: ${extractedContent.headings.map(h => `H${h.level}: "${h.text}"`).join(', ')}
- Paragraphs: ${extractedContent.paragraphs.map(p => `"${p.substring(0, 50)}..."`).join(', ')}
- Images: ${extractedContent.images.map(i => `${i.role}: ${i.src}`).join('\n  ')}
- CTAs: ${extractedContent.ctas.map(c => `"${c.text}" (${c.style}) -> ${c.href}`).join(', ')}
`;

  // Get EDS model type with fallback
  const edsModelType = description.edsModelType || 'standalone';

  // Generate model-specific guidance
  let modelGuidance = '';
  switch (edsModelType) {
    case 'collection':
      modelGuidance = `
EDS MODEL: Collection Block
- Each row in the block table represents ONE item in the collection
- All items should have the same cell structure (e.g., image | title | description)
- Decoration should iterate over rows to create the visual items
- Example: Cards, Team Members, Feature Grid`;
      break;
    case 'configuration':
      modelGuidance = `
EDS MODEL: Configuration Block
- Use key/value pairs for settings (left column = key, right column = value)
- Block pulls dynamic data based on configuration
- Example: Blog Listing with limit|10, sort|date-desc`;
      break;
    case 'auto-blocked':
      modelGuidance = `
EDS MODEL: Auto-Blocked
- Complex structure transformed from section content
- Authors create normal sections, decoration transforms them
- Example: Tabs from H2 headings, Accordion from sections`;
      break;
    default: // standalone
      modelGuidance = `
EDS MODEL: Standalone Block
- A distinct, unique visual element (typically appears once per page)
- Flexible cell structure - all content in one cell or split across rows/columns
- Decoration transforms the authored structure into final visual layout
- Example: Hero, Blockquote, Banner`;
  }

  const structureSummary = `
COMPONENT ANALYSIS:
- Type: ${description.componentType}
- EDS Model: ${edsModelType}
- Layout: ${description.structure.layout}
- Layers: ${description.structure.layers?.join(' → ') || 'N/A'}
- Content hierarchy: ${description.structure.contentHierarchy.join(' → ')}
${description.structure.gridInfo ? `- Grid: ${description.structure.gridInfo.columns} columns, items have: ${description.structure.gridInfo.itemStructure.join(', ')}` : ''}
${modelGuidance}

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

## EDS Block Structure

EDS blocks use a simple table-based content model that gets rendered as nested divs:

\`\`\`html
<!-- Initial HTML structure (from authored content) -->
<div class="{block-name} block" data-block-name="{block-name}">
  <div><!-- row 1 -->
    <div><!-- cell 1: content --></div>
    <div><!-- cell 2: content --></div>
  </div>
  <div><!-- row 2 -->
    <div><!-- cell content --></div>
  </div>
</div>
\`\`\`

The JS decoration function transforms this into the final rendered structure.

## JavaScript Decoration Guidelines

The decorate function MUST follow these patterns:

\`\`\`javascript
// REQUIRED: Export default async function
export default async function decorate(block) {
  // 1. Query existing content from the block's row/cell structure
  const rows = block.querySelectorAll(':scope > div');
  const firstRow = rows[0];
  const cells = firstRow?.querySelectorAll(':scope > div');

  // 2. Extract content from cells
  const imageCell = cells[0];
  const textCell = cells[1];
  const picture = imageCell?.querySelector('picture');
  const heading = textCell?.querySelector('h1, h2, h3');

  // 3. Create semantic wrapper elements
  const wrapper = document.createElement('div');
  wrapper.className = '{block-name}-content';

  // 4. Move/restructure content (don't clone unless necessary)
  if (picture) wrapper.append(picture);
  if (heading) wrapper.append(heading);

  // 5. Clear and rebuild block structure
  block.textContent = '';
  block.append(wrapper);
}
\`\`\`

**Key JS Rules:**
- Use \`:scope > div\` to select direct children only
- Use \`append()\` to move elements (not clone)
- Create new wrapper elements with \`document.createElement()\`
- Handle variants via \`block.classList.contains('variant-name')\`
- Keep decoration logic simple and focused
- For images, work with the \`<picture>\` element, not \`<img>\` directly

## CSS Styling Guidelines

**CRITICAL: All CSS selectors MUST be scoped to the block:**

\`\`\`css
/* CORRECT: Scoped with main .block-name */
main .{block-name} {
  /* block container styles */
}

main .{block-name} .{block-name}-content {
  /* wrapper styles */
}

main .{block-name} h2 {
  /* heading styles within this block */
}

/* WRONG: Never use unscoped selectors */
.{block-name} { } /* Missing main prefix */
h2 { } /* Completely unscoped */
\`\`\`

**CSS Best Practices:**
1. **Mobile-first**: Base styles for mobile, then use min-width media queries
2. **CSS Custom Properties**: Use existing variables when possible:
   \`\`\`css
   main .{block-name} {
     font-family: var(--body-font-family);
     color: var(--text-color);
     background-color: var(--background-color);
   }
   \`\`\`
3. **Responsive breakpoints**:
   \`\`\`css
   @media (min-width: 600px) { /* tablet */ }
   @media (min-width: 900px) { /* desktop */ }
   \`\`\`
4. **Low specificity**: Avoid !important, keep selectors simple
5. **BEM-like naming**: Use {block-name}-{element} for created wrappers

## Critical Instructions

1. **Match the visual design EXACTLY** - use the screenshot AND the extracted CSS values
2. **Use the EXACT content** from EXTRACTED CONTENT above - real URLs, real text
3. **Follow the structure** described in COMPONENT ANALYSIS
4. **Use the EXACT CSS values** from EXTRACTED CSS STYLES - do not guess colors or fonts
5. **Key visual elements to match**:
   - Is the image ABOVE the text (card layout) or BEHIND the text (overlay layout)?
   - What is the exact heading color? Use it.
   - What is the exact font-size? Use it.
   - Is there a card background or is content directly on the page?
6. **NEVER invent image URLs** - only use URLs from EXTRACTED CONTENT
7. **NEVER use base64 or localhost URLs**
8. **Always scope CSS with \`main .{block-name}\`** - this is mandatory for EDS

## Return Format

Return JSON:
{
  "blockName": "descriptive-block-name",
  "html": "<!-- EDS block markup with rows and cells containing actual content -->",
  "css": "/* Properly scoped CSS starting with main .{block-name} */",
  "js": "/* ES module: export default async function decorate(block) { ... } */"
}

Return ONLY the JSON object.`;

  const images: ImageContent[] = [{
    base64: screenshotBase64,
    mediaType: imageMediaType,
    label: 'Component screenshot'
  }];
  const response = await callLLMWithVision(images, prompt, { model: llmModel, env }, 8192);

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
  env: Env,
  extractedCssStyles?: string,
  liveImages?: LiveImage[],
  imageMediaType: 'image/png' | 'image/jpeg' = 'image/png',
  llmModel: LLMModel = 'claude-sonnet'
): Promise<EnhancedBlockCode> {
  console.log(`generateBlockEnhanced: received imageMediaType=${imageMediaType}, model=${llmModel}`);
  console.log('Step 1: Describing component...');
  const description = await describeComponent(screenshotBase64, env, imageMediaType, llmModel);
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
  const block = await generateCodeEnhanced(screenshotBase64, description, content, env, extractedCssStyles, imageMediaType, llmModel);
  console.log(`  Generated block: ${block.blockName}`);

  // Step 4: Validate and fix image URLs (LLMs sometimes hallucinate URLs)
  if (content.images.length > 0) {
    console.log('Step 4: Validating image URLs...');
    block.html = validateAndFixImageUrls(block.html, content.images);
    block.css = validateAndFixImageUrls(block.css, content.images);
  }

  // Step 5: Validate and fix CSS scoping (ensure all selectors start with main .block-name)
  console.log('Step 5: Validating CSS scoping...');
  block.css = validateAndFixCssScoping(block.css, block.blockName);

  return block;
}

/**
 * Validate image URLs in generated code and replace hallucinated ones with real extracted URLs
 */
function validateAndFixImageUrls(
  code: string,
  extractedImages: Array<{ src: string; alt: string; role: string }>
): string {
  if (!code || extractedImages.length === 0) return code;

  const validUrls = new Set(extractedImages.map(img => img.src));

  // Find all URLs in the code (both in src attributes and CSS url())
  const urlPatterns = [
    // HTML src/href attributes
    /(src|href)=["']([^"']+\.(jpg|jpeg|png|gif|webp|svg)[^"']*)["']/gi,
    // CSS url()
    /url\(["']?([^"')]+\.(jpg|jpeg|png|gif|webp|svg)[^"')]*)["']?\)/gi,
    // CSS background-image
    /background(-image)?:\s*url\(["']?([^"')]+)["']?\)/gi,
  ];

  let fixedCode = code;
  let replacementsMade = 0;

  // Extract all image URLs from the code
  const foundUrls: string[] = [];
  for (const pattern of urlPatterns) {
    const matches = code.matchAll(pattern);
    for (const match of matches) {
      // Get the URL part (different capture group positions for different patterns)
      const url = match[2] || match[1];
      if (url && !url.startsWith('data:')) {
        foundUrls.push(url);
      }
    }
  }

  // Check each found URL and replace if not in our valid list
  for (const url of foundUrls) {
    if (!validUrls.has(url)) {
      // This URL was hallucinated - find the best replacement
      const replacement = findBestImageMatch(url, extractedImages);
      if (replacement && replacement !== url) {
        console.log(`  Replacing hallucinated URL: ${url.substring(0, 60)}...`);
        console.log(`  With extracted URL: ${replacement.substring(0, 60)}...`);
        // Escape special regex characters in the URL
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        fixedCode = fixedCode.replace(new RegExp(escapedUrl, 'g'), replacement);
        replacementsMade++;
      }
    }
  }

  if (replacementsMade > 0) {
    console.log(`  Fixed ${replacementsMade} hallucinated image URL(s)`);
  }

  return fixedCode;
}

/**
 * Find the best matching image from extracted images based on context clues
 */
function findBestImageMatch(
  hallucinatedUrl: string,
  extractedImages: Array<{ src: string; alt: string; role: string }>
): string | null {
  if (extractedImages.length === 0) return null;

  // Try to match by role based on URL hints
  const urlLower = hallucinatedUrl.toLowerCase();

  // Check for background/hero hints
  if (urlLower.includes('hero') || urlLower.includes('background') || urlLower.includes('banner') || urlLower.includes('bg')) {
    const bgImage = extractedImages.find(img => img.role === 'background');
    if (bgImage) return bgImage.src;
  }

  // Check for icon hints
  if (urlLower.includes('icon') || urlLower.includes('logo')) {
    const iconImage = extractedImages.find(img => img.role === 'icon');
    if (iconImage) return iconImage.src;
  }

  // Default: return the first background image, or first image overall
  const bgImage = extractedImages.find(img => img.role === 'background');
  if (bgImage) return bgImage.src;

  return extractedImages[0]?.src || null;
}

/**
 * Validate and fix CSS scoping to ensure all selectors start with `main .{block-name}`
 * This is critical for EDS compatibility - unscoped styles will leak to other blocks
 */
function validateAndFixCssScoping(css: string, blockName: string): string {
  if (!css || !blockName) return css;

  // Split CSS into rule blocks (handling media queries and nested rules)
  const lines = css.split('\n');
  const fixedLines: string[] = [];
  let insideMediaQuery = false;
  let mediaQueryDepth = 0;
  let fixCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track media query depth
    if (trimmed.startsWith('@media')) {
      insideMediaQuery = true;
      mediaQueryDepth++;
      fixedLines.push(line);
      continue;
    }

    // Track closing braces for media queries
    if (insideMediaQuery) {
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      mediaQueryDepth += openBraces - closeBraces;
      if (mediaQueryDepth <= 0) {
        insideMediaQuery = false;
        mediaQueryDepth = 0;
      }
    }

    // Skip empty lines, comments, and closing braces
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '}' || trimmed === '{') {
      fixedLines.push(line);
      continue;
    }

    // Skip @keyframes, @font-face, and other at-rules
    if (trimmed.startsWith('@')) {
      fixedLines.push(line);
      continue;
    }

    // Check if this line looks like a selector (contains { at end or is followed by {)
    if (trimmed.includes('{') || (trimmed.match(/^[.#a-zA-Z\[\]:*]/) && !trimmed.includes(':'))) {
      // Extract the selector part (before the {)
      const selectorPart = trimmed.split('{')[0].trim();

      if (selectorPart) {
        // Check if selector is properly scoped
        const isProperlyScoped = selectorPart.startsWith('main ') ||
                                  selectorPart.startsWith('main.') ||
                                  selectorPart.includes('main .') ||
                                  selectorPart.startsWith(':root') ||
                                  selectorPart.startsWith('@');

        if (!isProperlyScoped) {
          // Fix the scoping
          const selectors = selectorPart.split(',').map(s => s.trim());
          const fixedSelectors = selectors.map(selector => {
            // Already has block class reference
            if (selector.includes(`.${blockName}`)) {
              // Just needs main prefix
              return `main ${selector}`;
            }
            // Needs full scoping
            return `main .${blockName} ${selector}`;
          });

          const fixedSelector = fixedSelectors.join(',\n');
          const restOfLine = trimmed.includes('{') ? ' {' + trimmed.split('{').slice(1).join('{') : '';

          // Preserve original indentation
          const indent = line.match(/^(\s*)/)?.[1] || '';
          fixedLines.push(`${indent}${fixedSelector}${restOfLine}`);
          fixCount++;
          continue;
        }
      }
    }

    fixedLines.push(line);
  }

  if (fixCount > 0) {
    console.log(`  Fixed ${fixCount} unscoped CSS selector(s) to use main .${blockName}`);
  }

  return fixedLines.join('\n');
}
