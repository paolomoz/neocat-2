/**
 * Design System Extractor
 * Extracts design tokens from external websites and generates EDS-compatible stylesheets
 */

import type { Page } from '@cloudflare/puppeteer';
import type {
  ComputedDesign,
  ParsedCSS,
  ExtractedDesign,
  ExtractedColors,
  ExtractedTypography,
  ExtractedButtonStyles,
  ExtractedLayout,
  DownloadedFont,
  Env,
} from './types';

// =============================================================================
// Step 1: Browser Extraction (Puppeteer)
// =============================================================================

/**
 * Extract computed styles from the live page using Puppeteer
 */
export async function extractComputedStyles(page: Page): Promise<ComputedDesign> {
  return page.evaluate(() => {
    const getStyle = (el: Element | null, props: string[]): Record<string, string> => {
      if (!el) return {};
      const style = window.getComputedStyle(el);
      return Object.fromEntries(props.map(p => [p, style.getPropertyValue(p)]));
    };

    // Body & base styles
    const body = document.body;
    const bodyStyles = getStyle(body, [
      'font-family', 'font-size', 'line-height', 'color', 'background-color'
    ]);

    // Heading hierarchy
    const headings: Record<string, Record<string, string>> = {};
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const el = document.querySelector(tag);
      headings[tag] = getStyle(el, [
        'font-family', 'font-size', 'font-weight', 'line-height', 'color'
      ]);
    }

    // Links
    const link = document.querySelector('a');
    const linkStyles = getStyle(link, ['color', 'text-decoration']);

    // Buttons - find primary and secondary variants
    const buttons: {
      primary: Record<string, string> | null;
      secondary: Record<string, string> | null;
      linkButton: Record<string, string> | null;
    } = {
      primary: null,
      secondary: null,
      linkButton: null,
    };

    // Look for common button patterns
    const primarySelectors = [
      'button.primary', '.btn-primary', 'button[type="submit"]', '.cta',
      'a.button', '.button', '[class*="btn-primary"]', '[class*="button-primary"]',
      'button:not(.secondary):not(.outline)', 'a[class*="cta"]'
    ];
    const secondarySelectors = [
      'button.secondary', '.btn-secondary', '.btn-outline', 'button.outline',
      '[class*="btn-secondary"]', '[class*="button-secondary"]', '[class*="btn-outline"]'
    ];
    const linkButtonSelectors = [
      'a.link-button', '.text-link', '[class*="link-button"]', 'a[class*="arrow"]'
    ];

    const buttonProps = [
      'background-color', 'color', 'border-radius', 'padding',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border', 'border-color', 'font-size', 'font-weight'
    ];

    for (const sel of primarySelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        buttons.primary = getStyle(btn, buttonProps);
        break;
      }
    }

    for (const sel of secondarySelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        buttons.secondary = getStyle(btn, buttonProps);
        break;
      }
    }

    for (const sel of linkButtonSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        buttons.linkButton = getStyle(btn, buttonProps);
        break;
      }
    }

    // Layout - container max-width
    const containerSelectors = [
      'main', '.container', '[class*="container"]', '.wrapper',
      '[class*="wrapper"]', '.content', 'article'
    ];
    let containerStyles: Record<string, string> = {};
    for (const sel of containerSelectors) {
      const container = document.querySelector(sel);
      if (container) {
        containerStyles = getStyle(container, ['max-width', 'padding-left', 'padding-right', 'width']);
        if (containerStyles['max-width'] && containerStyles['max-width'] !== 'none') {
          break;
        }
      }
    }

    // Nav height
    const navSelectors = ['header', 'nav', '[role="banner"]', '.header', '.navbar'];
    let navStyles: Record<string, string> = {};
    for (const sel of navSelectors) {
      const nav = document.querySelector(sel);
      if (nav) {
        navStyles = getStyle(nav, ['height', 'min-height']);
        if (navStyles['height'] && navStyles['height'] !== 'auto') {
          break;
        }
      }
    }

    return {
      body: bodyStyles,
      headings,
      link: linkStyles,
      buttons,
      container: containerStyles,
      nav: navStyles,
    };
  });
}

// =============================================================================
// Step 2: Stylesheet Parsing
// =============================================================================

/**
 * Parse stylesheets from the page to extract CSS variables and @font-face declarations
 */
export async function parseStylesheets(html: string, baseUrl: string): Promise<ParsedCSS> {
  // Extract <link rel="stylesheet"> URLs
  const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
  const hrefFirstRegex = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi;

  const cssUrls: string[] = [];
  const googleFontsUrls: string[] = [];

  for (const match of html.matchAll(linkRegex)) {
    try {
      const url = new URL(match[1], baseUrl).href;
      if (url.includes('fonts.googleapis.com')) {
        googleFontsUrls.push(url);
      } else {
        cssUrls.push(url);
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  for (const match of html.matchAll(hrefFirstRegex)) {
    try {
      const url = new URL(match[1], baseUrl).href;
      if (url.includes('fonts.googleapis.com')) {
        if (!googleFontsUrls.includes(url)) {
          googleFontsUrls.push(url);
        }
      } else if (!cssUrls.includes(url)) {
        cssUrls.push(url);
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  // Also extract inline <style> content
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const inlineStyles: string[] = [];
  for (const match of html.matchAll(styleRegex)) {
    inlineStyles.push(match[1]);
  }

  // Fetch each stylesheet (with timeout and error handling)
  const cssContents: string[] = [...inlineStyles];

  for (const url of cssUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        cssContents.push(text);
      }
    } catch (e) {
      // Failed to fetch stylesheet, continue
    }
  }

  // Fetch Google Fonts CSS (with woff2 user agent to get modern format)
  for (const url of googleFontsUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // Use modern user agent to get woff2 format
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        cssContents.push(text);
      }
    } catch (e) {
      // Failed to fetch Google Fonts, continue
    }
  }

  // Extract :root variables
  const rootVars: Record<string, string> = {};
  const rootRegex = /:root\s*\{([^}]+)\}/g;

  for (const css of cssContents) {
    for (const match of css.matchAll(rootRegex)) {
      const varsRegex = /--([^:]+):\s*([^;]+);/g;
      for (const v of match[1].matchAll(varsRegex)) {
        rootVars[`--${v[1].trim()}`] = v[2].trim();
      }
    }
  }

  // Extract @font-face declarations
  // Parse all URL alternatives and prefer modern formats (woff2 > woff > ttf > otf)
  // Also extract Base64-embedded fonts from data URIs
  const fontFaces: Array<{ family: string; src: string; weight: number; style: string; format?: string; base64Data?: string }> = [];
  // Use a more robust regex that handles large base64 data (non-greedy match up to closing brace followed by end or next rule)
  const fontRegex = /@font-face\s*\{([\s\S]*?)\}(?=\s*(?:@|[a-zA-Z#.*\[]|$))/g;

  // Format preference order (higher = better)
  // Data URIs get highest priority since they're definitely modern formats
  const formatPriority: Record<string, number> = {
    'woff2': 100,
    'woff': 90,
    'x-font-woff': 90,  // Alternative MIME type for woff
    'truetype': 80,
    'ttf': 80,
    'opentype': 70,
    'otf': 70,
    'svg': 10,
    'eot': 0,  // Lowest priority - not supported by modern browsers
    'embedded-opentype': 0,
  };

  // Helper to detect format from data URI MIME type
  const getFormatFromMimeType = (mimeType: string): string => {
    const mime = mimeType.toLowerCase();
    if (mime.includes('woff2')) return 'woff2';
    if (mime.includes('woff') || mime.includes('x-font-woff')) return 'woff';
    if (mime.includes('truetype') || mime.includes('ttf')) return 'truetype';
    if (mime.includes('opentype') || mime.includes('otf')) return 'opentype';
    if (mime.includes('eot')) return 'eot';
    return 'woff'; // Default assumption for data URIs
  };

  for (const css of cssContents) {
    for (const match of css.matchAll(fontRegex)) {
      const block = match[1];
      const familyMatch = block.match(/font-family:\s*["']?([^"';]+)/);
      const weightMatch = block.match(/font-weight:\s*(\d+)/);
      const styleMatch = block.match(/font-style:\s*(\w+)/);

      if (!familyMatch) continue;

      // Extract ALL url() declarations from src property (may span multiple lines)
      // Handle both single src: and multiple src: declarations
      // NOTE: Can't use simple [^;]+ because data URIs contain semicolons
      // Instead, match until we hit a property name (font-weight, font-style, etc.) or end of block
      const srcMatches = [...block.matchAll(/src:\s*((?:[^;]|;(?!base64))+?)(?=\s*(?:font-|$|}|src:))/gi)];
      // If that doesn't work well, fall back to extracting everything after "src:" up to next property
      let allSrcContent = srcMatches.map(m => m[1]).join(',');

      // Simpler approach: extract the full block content after src: and parse URLs from it
      // This handles data URIs with embedded semicolons
      // A data URI block with embedded WOFF font will be 20KB+, so if allSrcContent is
      // much smaller than the block, the regex likely failed to capture the data URI
      if (block.includes('data:') && allSrcContent.length < block.length / 2) {
        // The regex failed to capture the full data URI, try a different approach
        // Find all content between src: and the next property declaration
        const srcStartIdx = block.indexOf('src:');
        if (srcStartIdx >= 0) {
          // Find end - either font-weight:, font-style:, font-display:, } or another src:
          const afterSrc = block.substring(srcStartIdx + 4);
          const endMatch = afterSrc.match(/\s*(?:font-(?:weight|style|display)|unicode-range):/i);
          if (endMatch && endMatch.index !== undefined) {
            allSrcContent = afterSrc.substring(0, endMatch.index);
          } else {
            // No end found, use the whole rest (minus any trailing })
            allSrcContent = afterSrc.replace(/\s*\}\s*$/, '');
          }
        }
      }

      // Debug: log first @font-face src content to understand format
      if (fontFaces.length === 0) {
        console.log(`First @font-face block (${block.length} chars), src count: ${srcMatches.length}`);
        console.log(`First src content (first 200 chars): ${allSrcContent.substring(0, 200)}...`);
        if (allSrcContent.includes('data:')) {
          console.log('  -> Contains data URI!');
        }
      }

      // Extract URLs from src - handle both regular URLs and data URIs
      // Data URIs are very large (10KB+) so we extract them separately to avoid regex issues
      type UrlMatch = { url: string; format: string };
      const extractedUrls: UrlMatch[] = [];

      // First, extract data URIs (they can be huge, so handle them specially)
      // Find all data URI start positions and extract them manually
      let searchPos = 0;

      // Debug: check if allSrcContent contains data URI
      if (fontFaces.length === 0 && allSrcContent.includes('data:')) {
        const dataIdx = allSrcContent.indexOf('url(data:');
        console.log(`Data URI search: indexOf('url(data:') = ${dataIdx}, allSrcContent length = ${allSrcContent.length}`);
        if (dataIdx >= 0) {
          console.log(`  Context around data URI: ...${allSrcContent.substring(Math.max(0, dataIdx - 20), dataIdx + 50)}...`);
        }
      }

      while (true) {
        const dataStart = allSrcContent.indexOf('url(data:', searchPos);
        if (dataStart === -1) break;

        // Find the closing ) for this url() - need to find matching paren
        const urlStart = dataStart + 4; // After "url("
        let parenDepth = 1;
        let urlEnd = urlStart;
        while (urlEnd < allSrcContent.length && parenDepth > 0) {
          if (allSrcContent[urlEnd] === '(') parenDepth++;
          else if (allSrcContent[urlEnd] === ')') parenDepth--;
          urlEnd++;
        }

        if (parenDepth === 0) {
          const dataUri = allSrcContent.substring(urlStart, urlEnd - 1); // Exclude closing )

          // Extract format from following format() declaration if present
          const afterUrl = allSrcContent.substring(urlEnd, urlEnd + 50);
          const formatMatch = afterUrl.match(/^\s*format\(["']?([^"')]+)["']?\)/);
          const formatHint = formatMatch?.[1]?.toLowerCase() || '';

          // Parse the data URI to get MIME type
          const mimeMatch = dataUri.match(/^data:([^;,]+)/);
          const mimeType = mimeMatch?.[1] || '';
          const format = formatHint || getFormatFromMimeType(mimeType);

          extractedUrls.push({ url: dataUri, format });
        }

        searchPos = urlEnd;
      }

      // Then extract regular URLs (non-data URIs)
      const regularUrlRegex = /url\(["']?([^"')]+?)["']?\)\s*(?:format\(["']?([^"')]+)["']?\))?/g;
      let urlMatch;
      while ((urlMatch = regularUrlRegex.exec(allSrcContent)) !== null) {
        // Skip data URIs (already handled above) and local()
        if (urlMatch[1].startsWith('data:') || urlMatch[0].startsWith('local(')) continue;
        extractedUrls.push({
          url: urlMatch[1],
          format: urlMatch[2]?.toLowerCase() || ''
        });
      }

      // Debug: log if we find any data URIs
      const dataUriCount = extractedUrls.filter(u => u.url.startsWith('data:')).length;
      if (dataUriCount > 0) {
        console.log(`Found ${dataUriCount} data URI(s) for font "${familyMatch[1].trim()}" (${extractedUrls.length} total URLs)`);
      }

      // Find the best format - check for data URIs first (highest priority)
      let bestUrl = '';
      let bestPriority = -1;
      let bestFormat = '';
      let bestBase64Data: string | undefined;

      // Debug first font
      if (fontFaces.length === 0) {
        console.log(`URL matches found: ${extractedUrls.length}`);
        extractedUrls.forEach((u, i) => {
          const isData = u.url.startsWith('data:');
          console.log(`  URL ${i}: ${isData ? 'DATA URI (' + u.url.length + ' chars)' : u.url.substring(0, 60)}..., format: ${u.format || 'none'}`);
        });
      }

      for (const extracted of extractedUrls) {
        const url = extracted.url;
        let format = extracted.format;

        // Check if this is a data URI
        if (url.startsWith('data:')) {
          const dataUriMatch = url.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/i);
          if (dataUriMatch) {
            const mimeType = dataUriMatch[1];
            const base64Data = dataUriMatch[2];
            if (!format) {
              format = getFormatFromMimeType(mimeType);
            }

            // Data URIs with woff/woff2 get very high priority
            const priority = formatPriority[format] ?? 85;

            if (priority > bestPriority) {
              bestPriority = priority;
              bestUrl = `data-uri:${format}`; // Marker for data URI source
              bestFormat = format;
              bestBase64Data = base64Data;
            }
          }
        } else {
          // Regular URL - detect format from extension if not specified
          if (!format) {
            const ext = url.match(/\.(woff2|woff|ttf|otf|eot|svg)(\?|$)/i)?.[1]?.toLowerCase();
            format = ext || '';
          }

          const priority = formatPriority[format] ?? 50;

          if (priority > bestPriority) {
            bestPriority = priority;
            bestUrl = url;
            bestFormat = format;
            bestBase64Data = undefined;
          }
        }
      }

      // Fall back to first URL if no format detected
      if (!bestUrl) {
        const firstUrlMatch = block.match(/url\(["']?([^"')]+)/);
        if (firstUrlMatch) {
          bestUrl = firstUrlMatch[1];
        }
      }

      if (bestUrl) {
        // Handle data URIs vs regular URLs
        if (bestBase64Data) {
          // Embedded font via data URI
          console.log(`Found embedded ${bestFormat} font for "${familyMatch[1].trim()}" (${bestBase64Data.length} chars base64)`);
          fontFaces.push({
            family: familyMatch[1].trim(),
            src: bestUrl, // "data-uri:woff" marker
            weight: weightMatch ? parseInt(weightMatch[1]) : 400,
            style: styleMatch ? styleMatch[1] : 'normal',
            format: bestFormat,
            base64Data: bestBase64Data,
          });
        } else {
          // Regular URL
          try {
            const srcUrl = new URL(bestUrl, baseUrl).href;
            fontFaces.push({
              family: familyMatch[1].trim(),
              src: srcUrl,
              weight: weightMatch ? parseInt(weightMatch[1]) : 400,
              style: styleMatch ? styleMatch[1] : 'normal',
              format: bestFormat,
            });
          } catch (e) {
            // Invalid URL, skip
          }
        }
      }
    }
  }

  return { rootVars, fontFaces };
}

// =============================================================================
// Step 3: Font Download
// =============================================================================

/**
 * Slugify a font family name for use in filenames
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Determine font format from URL or content-type
 */
function getFontFormat(url: string, contentType?: string): string {
  const ext = url.match(/\.(woff2|woff|ttf|otf|eot)(\?|$)/i)?.[1]?.toLowerCase();
  if (ext) {
    if (ext === 'ttf') return 'truetype';
    if (ext === 'otf') return 'opentype';
    return ext;
  }

  if (contentType) {
    if (contentType.includes('woff2')) return 'woff2';
    if (contentType.includes('woff')) return 'woff';
    if (contentType.includes('truetype')) return 'truetype';
    if (contentType.includes('opentype')) return 'opentype';
  }

  return 'woff2'; // Default
}

/**
 * Decode a Base64 string to an ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Handle both browser and Node/CF Worker environments
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Download font files and prepare them for upload
 * Handles both regular URLs and pre-extracted Base64 data URIs
 * Also returns skipped font family names (for Google Fonts fallback detection)
 */
export async function downloadFonts(
  fontFaces: Array<{ family: string; src: string; weight: number; style: string; format?: string; base64Data?: string }>
): Promise<{ fonts: DownloadedFont[]; fontBuffers: Map<string, ArrayBuffer>; skippedFamilies: string[] }> {
  const downloaded: DownloadedFont[] = [];
  const fontBuffers = new Map<string, ArrayBuffer>();
  const seen = new Set<string>();
  const skippedFamilies: string[] = [];

  for (const font of fontFaces) {
    // Create unique key to avoid duplicates
    const key = `${font.family}-${font.weight}-${font.style}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Handle embedded Base64 fonts (from data URIs)
    if (font.base64Data) {
      try {
        const format = font.format || 'woff';
        const ext = format === 'truetype' ? 'ttf' : format === 'opentype' ? 'otf' : format;
        const styleSuffix = font.style !== 'normal' ? `-${font.style}` : '';
        const filename = `${slugify(font.family)}-${font.weight}${styleSuffix}.${ext}`;
        const localPath = `styles/fonts/${filename}`;

        // Decode Base64 to ArrayBuffer
        const buffer = base64ToArrayBuffer(font.base64Data);
        console.log(`Decoded embedded ${format} font: ${font.family} (${font.weight}) - ${buffer.byteLength} bytes`);

        downloaded.push({
          family: font.family,
          weight: font.weight,
          style: font.style,
          sourceUrl: font.src, // "data-uri:woff" marker
          localPath,
          format,
        });

        fontBuffers.set(localPath, buffer);
      } catch (e) {
        console.log(`Failed to decode Base64 font for ${font.family}: ${e}`);
      }
      continue;
    }

    // Skip EOT files - they're only supported by old IE
    if (font.src.toLowerCase().includes('.eot')) {
      console.log(`Skipping EOT font (not supported by modern browsers): ${font.src}`);
      if (!skippedFamilies.includes(font.family)) {
        skippedFamilies.push(font.family);
      }
      continue;
    }

    // Download from URL
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(font.src, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || '';
      const format = font.format || getFontFormat(font.src, contentType);

      // Skip if format is EOT (detected from content-type)
      if (format === 'eot' || contentType.includes('ms-fontobject')) {
        console.log(`Skipping EOT font (detected from content-type): ${font.src}`);
        if (!skippedFamilies.includes(font.family)) {
          skippedFamilies.push(font.family);
        }
        continue;
      }

      // Generate filename
      const ext = format === 'truetype' ? 'ttf' : format === 'opentype' ? 'otf' : format;
      const styleSuffix = font.style !== 'normal' ? `-${font.style}` : '';
      const filename = `${slugify(font.family)}-${font.weight}${styleSuffix}.${ext}`;
      const localPath = `styles/fonts/${filename}`;

      downloaded.push({
        family: font.family,
        weight: font.weight,
        style: font.style,
        sourceUrl: font.src,
        localPath,
        format,
      });

      fontBuffers.set(localPath, buffer);
    } catch (e) {
      // Failed to download font, continue
    }
  }

  return { fonts: downloaded, fontBuffers, skippedFamilies };
}

// =============================================================================
// Step 4: Claude Vision Analysis
// =============================================================================

/**
 * Analyze screenshot with Claude Vision to extract design tokens
 */
export async function analyzeDesignWithClaude(
  screenshotBase64: string,
  anthropicConfig: { model: string; apiKey?: string; bedrockToken?: string; region?: string },
  env: Env
): Promise<Partial<ExtractedDesign>> {
  const prompt = `Analyze this website screenshot and extract the design system. Return ONLY valid JSON matching this exact structure (no markdown, no explanation):

{
  "colors": {
    "background": "#ffffff",
    "text": "#000000",
    "link": "#0066cc",
    "linkHover": "#004499",
    "primary": "#007bff",
    "secondary": "#6c757d",
    "light": "#f8f9fa",
    "dark": "#343a40"
  },
  "typography": {
    "bodyFont": "system-ui, sans-serif",
    "headingFont": "system-ui, sans-serif",
    "bodySizes": { "m": "16px", "s": "14px", "xs": "12px" },
    "headingSizes": { "xxl": "48px", "xl": "40px", "l": "32px", "m": "24px", "s": "20px", "xs": "18px" },
    "lineHeight": "1.5"
  },
  "buttons": {
    "borderRadius": "4px",
    "padding": "12px 24px",
    "primary": { "background": "#007bff", "color": "#ffffff", "hoverBackground": "#0056b3" },
    "secondary": { "background": "transparent", "color": "#007bff", "border": "#007bff" }
  },
  "layout": {
    "maxWidth": "1200px",
    "navHeight": "64px",
    "sectionPadding": "40px"
  }
}

Instructions:
1. Identify the primary brand color (usually used for buttons, links, accents)
2. Identify the text and background colors
3. Try to identify the font families used (name them if recognizable like "Inter", "Roboto", etc.)
4. Estimate font sizes based on visual hierarchy
5. Look at buttons: identify primary (filled) and secondary (outline/ghost) styles
6. Estimate layout metrics like max content width and header height`;

  try {
    let response: Response;

    if (anthropicConfig.bedrockToken) {
      // Use Bedrock
      const region = anthropicConfig.region || 'us-west-2';
      response = await fetch(
        `https://bedrock-runtime.${region}.amazonaws.com/model/${anthropicConfig.model}/invoke`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${anthropicConfig.bedrockToken}`,
          },
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 2000,
            messages: [{
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
                { type: 'text', text: prompt },
              ],
            }],
          }),
        }
      );
    } else if (anthropicConfig.apiKey) {
      // Use direct Anthropic API
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicConfig.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: anthropicConfig.model || 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{
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
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
    } else {
      throw new Error('No Anthropic API key or Bedrock token configured');
    }

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text || '';

    // Extract JSON from response (handle potential markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const parsed = JSON.parse(jsonStr.trim());
    return parsed as Partial<ExtractedDesign>;
  } catch (e) {
    console.error('Claude analysis failed:', e);
    return {};
  }
}

// =============================================================================
// Step 5: Merge Extracted Design
// =============================================================================

/**
 * Clean and normalize a CSS color value
 */
function normalizeColor(color: string | undefined): string {
  if (!color) return '';
  // Convert rgb/rgba to hex if needed, or return as-is
  return color.trim();
}

/**
 * Clean and normalize a font family string
 */
function normalizeFontFamily(font: string | undefined): string {
  if (!font) return 'system-ui, sans-serif';
  // Remove quotes and extra whitespace
  return font.replace(/["']/g, '').trim();
}

/**
 * Parse padding shorthand to get a single padding value
 */
function normalizePadding(computed: Record<string, string> | null): string {
  if (!computed) return '12px 24px';

  const top = computed['padding-top'] || computed['padding'] || '12px';
  const right = computed['padding-right'] || computed['padding'] || '24px';

  // Simplify to shorthand if possible
  const topNum = parseFloat(top);
  const rightNum = parseFloat(right);

  if (!isNaN(topNum) && !isNaN(rightNum)) {
    return `${topNum}px ${rightNum}px`;
  }

  return '12px 24px';
}

/**
 * Merge computed styles, parsed CSS, and Claude analysis into final design
 */
export function mergeExtractedDesign(
  computed: ComputedDesign,
  parsed: ParsedCSS,
  claude: Partial<ExtractedDesign>
): ExtractedDesign {
  // Default values
  const defaults: ExtractedDesign = {
    colors: {
      background: '#ffffff',
      text: '#131313',
      link: '#3b63fb',
      linkHover: '#1d3ecf',
      primary: '#3b63fb',
      secondary: '#6c757d',
      light: '#f8f8f8',
      dark: '#505050',
    },
    typography: {
      bodyFont: 'system-ui, sans-serif',
      headingFont: 'system-ui, sans-serif',
      bodySizes: { m: '18px', s: '16px', xs: '14px' },
      headingSizes: { xxl: '48px', xl: '40px', l: '32px', m: '24px', s: '20px', xs: '18px' },
      lineHeight: '1.6',
    },
    buttons: {
      borderRadius: '4px',
      padding: '12px 24px',
      primary: { background: '#3b63fb', color: '#ffffff', hoverBackground: '#1d3ecf' },
      secondary: { background: 'transparent', color: '#131313', border: '#131313' },
    },
    layout: {
      maxWidth: '1200px',
      navHeight: '64px',
      sectionPadding: '40px',
    },
    fonts: [],
  };

  // Merge colors (prefer Claude > computed > CSS vars > defaults)
  const colors: ExtractedColors = {
    background: claude.colors?.background || normalizeColor(computed.body['background-color']) || parsed.rootVars['--background-color'] || defaults.colors.background,
    text: claude.colors?.text || normalizeColor(computed.body['color']) || parsed.rootVars['--text-color'] || defaults.colors.text,
    link: claude.colors?.link || normalizeColor(computed.link['color']) || parsed.rootVars['--link-color'] || defaults.colors.link,
    linkHover: claude.colors?.linkHover || parsed.rootVars['--link-hover-color'] || defaults.colors.linkHover,
    primary: claude.colors?.primary || normalizeColor(computed.buttons.primary?.['background-color']) || parsed.rootVars['--primary-color'] || defaults.colors.primary,
    secondary: claude.colors?.secondary || normalizeColor(computed.buttons.secondary?.['border-color']) || parsed.rootVars['--secondary-color'] || defaults.colors.secondary,
    light: claude.colors?.light || parsed.rootVars['--light-color'] || defaults.colors.light,
    dark: claude.colors?.dark || parsed.rootVars['--dark-color'] || defaults.colors.dark,
  };

  // Merge typography
  const typography: ExtractedTypography = {
    bodyFont: claude.typography?.bodyFont || normalizeFontFamily(computed.body['font-family']) || defaults.typography.bodyFont,
    headingFont: claude.typography?.headingFont || normalizeFontFamily(computed.headings['h1']?.['font-family']) || defaults.typography.headingFont,
    bodySizes: claude.typography?.bodySizes || {
      m: computed.body['font-size'] || defaults.typography.bodySizes.m,
      s: defaults.typography.bodySizes.s,
      xs: defaults.typography.bodySizes.xs,
    },
    headingSizes: claude.typography?.headingSizes || {
      xxl: computed.headings['h1']?.['font-size'] || defaults.typography.headingSizes.xxl,
      xl: computed.headings['h2']?.['font-size'] || defaults.typography.headingSizes.xl,
      l: computed.headings['h3']?.['font-size'] || defaults.typography.headingSizes.l,
      m: computed.headings['h4']?.['font-size'] || defaults.typography.headingSizes.m,
      s: computed.headings['h5']?.['font-size'] || defaults.typography.headingSizes.s,
      xs: computed.headings['h6']?.['font-size'] || defaults.typography.headingSizes.xs,
    },
    lineHeight: claude.typography?.lineHeight || computed.body['line-height'] || defaults.typography.lineHeight,
    headingFontWeight: claude.typography?.headingFontWeight || computed.headings['h1']?.['font-weight'] || '600',
  };

  // Merge buttons
  const buttons: ExtractedButtonStyles = {
    borderRadius: claude.buttons?.borderRadius || computed.buttons.primary?.['border-radius'] || defaults.buttons.borderRadius,
    padding: claude.buttons?.padding || normalizePadding(computed.buttons.primary) || defaults.buttons.padding,
    primary: claude.buttons?.primary || {
      background: normalizeColor(computed.buttons.primary?.['background-color']) || colors.primary,
      color: normalizeColor(computed.buttons.primary?.['color']) || '#ffffff',
      hoverBackground: colors.linkHover,
    },
    secondary: claude.buttons?.secondary || {
      background: normalizeColor(computed.buttons.secondary?.['background-color']) || 'transparent',
      color: normalizeColor(computed.buttons.secondary?.['color']) || colors.text,
      border: normalizeColor(computed.buttons.secondary?.['border-color']) || colors.text,
    },
  };

  // Merge layout
  const layout: ExtractedLayout = {
    maxWidth: claude.layout?.maxWidth || computed.container['max-width'] || defaults.layout.maxWidth,
    navHeight: claude.layout?.navHeight || computed.nav['height'] || defaults.layout.navHeight,
    sectionPadding: claude.layout?.sectionPadding || defaults.layout.sectionPadding,
  };

  return {
    colors,
    typography,
    buttons,
    layout,
    fonts: [], // Will be populated separately
  };
}

// =============================================================================
// Step 6: Generate styles.css
// =============================================================================

/**
 * Generate a complete EDS-compatible styles.css
 */
export function generateStylesCSS(design: ExtractedDesign): string {
  return `/*
 * Design System - Auto-generated from source website
 * This file is licensed under the Apache License, Version 2.0
 */

@import url('fonts.css');
@import url('style-guide.css');

:root {
  /* colors */
  --background-color: ${design.colors.background};
  --light-color: ${design.colors.light};
  --dark-color: ${design.colors.dark};
  --text-color: ${design.colors.text};
  --link-color: ${design.colors.link};
  --link-hover-color: ${design.colors.linkHover};

  /* fonts */
  --body-font-family: ${design.typography.bodyFont};
  --heading-font-family: ${design.typography.headingFont};

  /* body sizes */
  --body-font-size-m: ${design.typography.bodySizes.m};
  --body-font-size-s: ${design.typography.bodySizes.s};
  --body-font-size-xs: ${design.typography.bodySizes.xs};

  /* heading sizes */
  --heading-font-size-xxl: ${design.typography.headingSizes.xxl};
  --heading-font-size-xl: ${design.typography.headingSizes.xl};
  --heading-font-size-l: ${design.typography.headingSizes.l};
  --heading-font-size-m: ${design.typography.headingSizes.m};
  --heading-font-size-s: ${design.typography.headingSizes.s};
  --heading-font-size-xs: ${design.typography.headingSizes.xs};

  /* nav height */
  --nav-height: ${design.layout.navHeight};
}

@media (width >= 900px) {
  :root {
    /* body sizes - slightly smaller on desktop */
    --body-font-size-m: 18px;
    --body-font-size-s: 16px;
    --body-font-size-xs: 14px;
  }
}

body {
  display: none;
  margin: 0;
  background-color: var(--background-color);
  color: var(--text-color);
  font-family: var(--body-font-family);
  font-size: var(--body-font-size-m);
  line-height: ${design.typography.lineHeight};
}

body.appear {
  display: block;
}

header {
  height: var(--nav-height);
}

header .header,
footer .footer {
  visibility: hidden;
}

header .header[data-block-status="loaded"],
footer .footer[data-block-status="loaded"] {
  visibility: visible;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  margin-top: 0.8em;
  margin-bottom: 0.25em;
  font-family: var(--heading-font-family);
  font-weight: ${design.typography.headingFontWeight || '600'};
  line-height: 1.25;
  scroll-margin: 40px;
}

h1 { font-size: var(--heading-font-size-xxl); }
h2 { font-size: var(--heading-font-size-xl); }
h3 { font-size: var(--heading-font-size-l); }
h4 { font-size: var(--heading-font-size-m); }
h5 { font-size: var(--heading-font-size-s); }
h6 { font-size: var(--heading-font-size-xs); }

p,
dl,
ol,
ul,
pre,
blockquote {
  margin-top: 0.8em;
  margin-bottom: 0.25em;
}

code,
pre {
  font-size: var(--body-font-size-s);
}

pre {
  padding: 16px;
  border-radius: 8px;
  background-color: var(--light-color);
  overflow-x: auto;
  white-space: pre;
}

main > div {
  margin: 40px 16px;
}

input,
textarea,
select,
button {
  font: inherit;
}

/* links */
a:any-link {
  color: var(--link-color);
  text-decoration: none;
  overflow-wrap: break-word;
}

a:hover {
  color: var(--link-hover-color);
  text-decoration: underline;
}

/* buttons */
a.button:any-link,
button {
  box-sizing: border-box;
  display: inline-block;
  max-width: 100%;
  margin: 12px 0;
  border: 2px solid transparent;
  border-radius: ${design.buttons.borderRadius};
  padding: ${design.buttons.padding};
  font-family: var(--body-font-family);
  font-style: normal;
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  text-decoration: none;
  background-color: ${design.buttons.primary.background};
  color: ${design.buttons.primary.color};
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.button:hover,
a.button:focus,
button:hover,
button:focus {
  background-color: ${design.buttons.primary.hoverBackground};
  cursor: pointer;
}

button:disabled,
button:disabled:hover {
  background-color: var(--light-color);
  cursor: unset;
}

a.button.secondary,
button.secondary {
  background-color: ${design.buttons.secondary.background};
  border: 2px solid ${design.buttons.secondary.border};
  color: ${design.buttons.secondary.color};
}

main img {
  max-width: 100%;
  width: auto;
  height: auto;
}

.icon {
  display: inline-block;
  height: 24px;
  width: 24px;
}

.icon img {
  height: 100%;
  width: 100%;
}

/* sections */
main > .section {
  margin: ${design.layout.sectionPadding} 0;
}

main > .section > div {
  max-width: ${design.layout.maxWidth};
  margin: auto;
  padding: 0 24px;
}

main > .section:first-of-type {
  margin-top: 0;
}

@media (width >= 900px) {
  main > .section > div {
    padding: 0 32px;
  }
}

/* section metadata */
main .section.light,
main .section.highlight {
  background-color: var(--light-color);
  margin: 0;
  padding: ${design.layout.sectionPadding} 0;
}
`;
}

// =============================================================================
// Step 7: Generate fonts.css
// =============================================================================

/**
 * Mapping of proprietary/licensed fonts to similar Google Fonts alternatives
 * Keys are lowercase font names (partial matches supported)
 */
const GOOGLE_FONTS_ALTERNATIVES: Record<string, { googleFont: string; weights: number[]; category: string }> = {
  // Geometric sans-serif fonts
  'gotham': { googleFont: 'Montserrat', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'proxima nova': { googleFont: 'Montserrat', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'proxima-nova': { googleFont: 'Montserrat', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'futura': { googleFont: 'Jost', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'century gothic': { googleFont: 'Poppins', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'avenir': { googleFont: 'Nunito', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'brandon': { googleFont: 'Raleway', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'gilroy': { googleFont: 'Poppins', weights: [300, 400, 500, 600, 700], category: 'geometric' },
  'circular': { googleFont: 'DM Sans', weights: [400, 500, 700], category: 'geometric' },
  'product sans': { googleFont: 'DM Sans', weights: [400, 500, 700], category: 'geometric' },

  // Humanist sans-serif fonts
  'helvetica': { googleFont: 'Inter', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'helvetica neue': { googleFont: 'Inter', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'arial': { googleFont: 'Inter', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'san francisco': { googleFont: 'Inter', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'sf pro': { googleFont: 'Inter', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'segoe': { googleFont: 'Open Sans', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'frutiger': { googleFont: 'Source Sans 3', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'myriad': { googleFont: 'Source Sans 3', weights: [300, 400, 500, 600, 700], category: 'humanist' },
  'trebuchet': { googleFont: 'Rubik', weights: [300, 400, 500, 600, 700], category: 'humanist' },

  // Serif fonts
  'times': { googleFont: 'Merriweather', weights: [300, 400, 700], category: 'serif' },
  'georgia': { googleFont: 'Lora', weights: [400, 500, 600, 700], category: 'serif' },
  'garamond': { googleFont: 'EB Garamond', weights: [400, 500, 600, 700], category: 'serif' },
  'baskerville': { googleFont: 'Libre Baskerville', weights: [400, 700], category: 'serif' },
  'minion': { googleFont: 'Crimson Pro', weights: [400, 500, 600, 700], category: 'serif' },
  'caslon': { googleFont: 'Libre Caslon Text', weights: [400, 700], category: 'serif' },
  'palatino': { googleFont: 'Crimson Pro', weights: [400, 500, 600, 700], category: 'serif' },

  // Slab serif fonts
  'rockwell': { googleFont: 'Roboto Slab', weights: [300, 400, 500, 700], category: 'slab' },
  'clarendon': { googleFont: 'Roboto Slab', weights: [300, 400, 500, 700], category: 'slab' },
  'museo slab': { googleFont: 'Roboto Slab', weights: [300, 400, 500, 700], category: 'slab' },

  // Monospace fonts
  'consolas': { googleFont: 'Fira Code', weights: [400, 500, 700], category: 'mono' },
  'monaco': { googleFont: 'JetBrains Mono', weights: [400, 500, 700], category: 'mono' },
  'menlo': { googleFont: 'JetBrains Mono', weights: [400, 500, 700], category: 'mono' },
};

/**
 * Find a Google Fonts alternative for a proprietary font
 */
function findGoogleFontAlternative(fontName: string): { googleFont: string; weights: number[]; category: string } | null {
  const lowerName = fontName.toLowerCase();

  // Direct match
  if (GOOGLE_FONTS_ALTERNATIVES[lowerName]) {
    return GOOGLE_FONTS_ALTERNATIVES[lowerName];
  }

  // Partial match (e.g., "Virgin Atlantic" might use "gotham" internally)
  for (const [key, value] of Object.entries(GOOGLE_FONTS_ALTERNATIVES)) {
    if (lowerName.includes(key) || key.includes(lowerName)) {
      return value;
    }
  }

  return null;
}

/**
 * Generate Google Fonts @import URL
 */
function generateGoogleFontsImport(googleFont: string, weights: number[]): string {
  const weightStr = weights.join(';');
  const fontParam = googleFont.replace(/\s+/g, '+');
  return `https://fonts.googleapis.com/css2?family=${fontParam}:wght@${weightStr}&display=swap`;
}

/**
 * Generate style-guide CSS for visual design system blocks
 * Creates styles for color-swatch, type-scale, spacing, cards, etc.
 */
export function generateStyleGuideCSS(design: ExtractedDesign): string {
  // Helper to determine if color is light
  const isLightColor = (hex: string): boolean => {
    try {
      const c = hex.replace('#', '');
      const r = parseInt(c.substring(0, 2), 16);
      const g = parseInt(c.substring(2, 4), 16);
      const b = parseInt(c.substring(4, 6), 16);
      return (r * 299 + g * 587 + b * 114) / 1000 > 128;
    } catch {
      return true;
    }
  };

  return `/* Style Guide Blocks - Auto-generated */

/* Color Swatch Block */
.color-swatch {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 24px;
}

.color-swatch > div {
  flex: 0 0 150px;
}

.color-swatch > div > div {
  height: 100px;
  border-radius: 8px;
  margin-bottom: 8px;
  border: 1px solid rgba(0,0,0,0.1);
  display: flex;
  align-items: flex-end;
  padding: 8px;
  font-size: 12px;
  font-family: monospace;
}

.color-swatch > div > div:first-child {
  background-color: var(--swatch-color, #ccc);
  color: var(--swatch-text, #000);
}

.color-swatch > div p {
  margin: 4px 0;
  font-size: 14px;
}

.color-swatch > div p:first-of-type {
  font-weight: 600;
}

.color-swatch > div p:last-of-type {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-color);
  opacity: 0.7;
}

/* Color values from design system */
.color-swatch [data-color="primary"] { background-color: ${design.colors.primary}; color: ${isLightColor(design.colors.primary) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="secondary"] { background-color: ${design.colors.secondary}; color: ${isLightColor(design.colors.secondary) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="link"] { background-color: ${design.colors.link}; color: ${isLightColor(design.colors.link) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="text"] { background-color: ${design.colors.text}; color: ${isLightColor(design.colors.text) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="background"] { background-color: ${design.colors.background}; color: ${isLightColor(design.colors.background) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="dark"] { background-color: ${design.colors.dark}; color: ${isLightColor(design.colors.dark) ? design.colors.text : '#fff'}; }
.color-swatch [data-color="light"] { background-color: ${design.colors.light}; color: ${isLightColor(design.colors.light) ? design.colors.text : '#fff'}; }

/* Type Scale Block */
.type-scale {
  margin-bottom: 24px;
}

.type-scale > div {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
}

.type-scale > div > div {
  flex: 1;
  min-width: 100px;
  text-align: center;
  padding: 16px;
  background: var(--light-color, #f5f5f5);
  border-radius: 8px;
}

.type-scale > div > div p:first-child {
  font-weight: 600;
  margin-bottom: 4px;
}

.type-scale > div > div p:last-child {
  font-family: monospace;
  font-size: 12px;
  opacity: 0.7;
}

/* Spacing Block */
.spacing {
  margin-bottom: 24px;
}

.spacing > div {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.spacing > div > div {
  flex: 1;
  min-width: 120px;
  padding: 16px;
  background: var(--light-color, #f5f5f5);
  border-radius: 8px;
  text-align: center;
}

.spacing > div > div p:first-child {
  font-weight: 600;
  font-size: 14px;
}

.spacing > div > div p:last-child {
  font-family: monospace;
  font-size: 14px;
  color: var(--primary-color, ${design.colors.primary});
}

/* Border Radius Block */
.border-radius {
  margin-bottom: 24px;
}

.border-radius > div > div {
  display: inline-flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--light-color, #f5f5f5);
  border-radius: 8px;
}

.border-radius > div > div::before {
  content: '';
  width: 60px;
  height: 60px;
  background: var(--primary-color, ${design.colors.primary});
  border-radius: ${design.buttons.borderRadius};
}

/* Cards Block Enhancement */
.cards {
  margin-bottom: 24px;
}

.cards > div {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 24px;
}

.cards > div > div {
  background: var(--background-color, #fff);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}

.cards > div > div p:first-child strong {
  font-size: 18px;
}

/* Columns Block Enhancement */
.columns {
  margin-bottom: 24px;
}

.columns > div {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 24px;
}

.columns > div > div {
  padding: 16px;
  background: var(--light-color, #f5f5f5);
  border-radius: 8px;
}

/* Dark Section Style */
main .section.dark {
  background-color: ${design.colors.dark};
  color: ${isLightColor(design.colors.dark) ? design.colors.text : '#fff'};
  margin: 0;
  padding: 48px 0;
}

main .section.dark a:any-link {
  color: ${isLightColor(design.colors.dark) ? design.colors.link : '#fff'};
}

main .section.dark a.button:any-link {
  background-color: ${design.colors.primary};
  color: ${isLightColor(design.colors.primary) ? design.colors.text : '#fff'};
}

/* Text Buttons Section - plain link-style buttons without background */
main .section.text-buttons a.button:any-link {
  background-color: transparent !important;
  color: ${design.colors.link} !important;
  padding: 0 !important;
  margin: 8px 0 !important;
  border: none !important;
  border-radius: 0 !important;
  font-weight: 500 !important;
  text-decoration: none !important;
  white-space: normal !important;
}

main .section.text-buttons a.button:hover {
  background-color: transparent !important;
  color: ${design.colors.linkHover} !important;
  text-decoration: underline !important;
}
`;
}

/**
 * Generate @font-face declarations for downloaded fonts
 * @param fonts - Downloaded font files
 * @param bodyFont - Full font-family stack for body (e.g., "Virgin Atlantic, Helvetica, sans-serif")
 * @param headingFont - Full font-family stack for headings
 * @param skippedFamilies - Font family names that were skipped (e.g., due to EOT format)
 */
export function generateFontsCSS(
  fonts: DownloadedFont[],
  bodyFont?: string,
  headingFont?: string,
  skippedFamilies?: string[]
): string {
  // Extract the primary font names from the font-family stacks
  const bodyFontName = bodyFont?.split(',')[0]?.trim().replace(/["']/g, '') || '';
  const headingFontName = headingFont?.split(',')[0]?.trim().replace(/["']/g, '') || '';

  if (fonts.length === 0) {
    // Try to find Google Fonts alternatives
    // First check skipped families (e.g., "gotham-light" from @font-face declarations)
    let bodyAlt: { googleFont: string; weights: number[]; category: string } | null = null;
    let detectedFrom = '';

    // Check skipped font families first (more accurate - these are the actual fonts the site uses)
    if (skippedFamilies && skippedFamilies.length > 0) {
      for (const family of skippedFamilies) {
        const alt = findGoogleFontAlternative(family);
        if (alt) {
          bodyAlt = alt;
          detectedFrom = family;
          break;
        }
      }
    }

    // Fall back to checking body font name
    if (!bodyAlt && bodyFontName) {
      bodyAlt = findGoogleFontAlternative(bodyFontName);
      if (bodyAlt) detectedFrom = bodyFontName;
    }

    const headingAlt = headingFontName && headingFontName !== bodyFontName
      ? findGoogleFontAlternative(headingFontName)
      : null;

    // If we found alternatives, generate Google Fonts fallback
    if (bodyAlt || headingAlt) {
      const skippedInfo = skippedFamilies && skippedFamilies.length > 0
        ? `\n *   Skipped fonts (EOT): ${skippedFamilies.join(', ')}`
        : '';
      let css = `/*
 * Google Fonts fallback for proprietary fonts
 *
 * Original fonts detected:
 *   Body font-family: ${bodyFontName || 'system font'}
 *   Detected as: ${detectedFrom || bodyFontName} → Using ${bodyAlt?.googleFont || 'system font'}${skippedInfo}
 */

`;
      // Generate @import statements
      const imports: string[] = [];
      if (bodyAlt) {
        imports.push(`@import url('${generateGoogleFontsImport(bodyAlt.googleFont, bodyAlt.weights)}');`);
      }
      if (headingAlt && headingAlt.googleFont !== bodyAlt?.googleFont) {
        imports.push(`@import url('${generateGoogleFontsImport(headingAlt.googleFont, headingAlt.weights)}');`);
      }
      css += imports.join('\n') + '\n\n';

      // Generate @font-face declarations to map Google Font to original font-family name
      if (bodyAlt && bodyFontName) {
        css += `/* Map ${bodyAlt.googleFont} to "${bodyFontName}" for body text */\n`;
        for (const weight of bodyAlt.weights) {
          css += `@font-face {
  font-family: '${bodyFontName}';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: local('${bodyAlt.googleFont}');
}

`;
        }
      }

      if (headingAlt && headingFontName && headingFontName !== bodyFontName) {
        css += `/* Map ${headingAlt.googleFont} to "${headingFontName}" for headings */\n`;
        for (const weight of headingAlt.weights) {
          css += `@font-face {
  font-family: '${headingFontName}';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: local('${headingAlt.googleFont}');
}

`;
        }
      }

      return css;
    }

    // No alternatives found - return informational comment
    return `/*
 * No downloadable fonts were found.
 *
 * The source site uses:
 *   Body: ${bodyFontName || 'system font'}
 *   Headings: ${headingFontName || 'system font'}
 *
 * These may be licensed fonts (Adobe Fonts, proprietary fonts) that cannot be downloaded.
 * The design will fall back to system fonts specified in styles.css.
 *
 * To use custom fonts, you can:
 * 1. Add @font-face declarations here pointing to your own font files
 * 2. Use Google Fonts by adding @import url('https://fonts.googleapis.com/css2?family=...')
 * 3. Add font files to /styles/fonts/ and reference them here
 */
`;
  }

  // Group fonts by weight to assign appropriate weights
  const fontsByWeight = new Map<number, DownloadedFont[]>();
  for (const font of fonts) {
    const existing = fontsByWeight.get(font.weight) || [];
    existing.push(font);
    fontsByWeight.set(font.weight, existing);
  }

  // Determine which font-family name to use
  // Use the detected body font name if available, otherwise use the original @font-face name
  const targetFontFamily = bodyFontName || fonts[0]?.family || 'custom-font';

  // Map font filenames that suggest weight to actual font-weight values
  const weightFromFilename = (filename: string): number => {
    const lower = filename.toLowerCase();
    if (lower.includes('thin') || lower.includes('hairline')) return 100;
    if (lower.includes('extralight') || lower.includes('ultralight') || lower.includes('xlight')) return 200;
    if (lower.includes('light')) return 300;
    if (lower.includes('regular') || lower.includes('normal')) return 400;
    if (lower.includes('medium')) return 500;
    if (lower.includes('semibold') || lower.includes('demibold')) return 600;
    if (lower.includes('bold') && !lower.includes('extra') && !lower.includes('ultra')) return 700;
    if (lower.includes('extrabold') || lower.includes('ultrabold')) return 800;
    if (lower.includes('black') || lower.includes('heavy')) return 900;
    return 400; // default
  };

  const declarations = fonts.map(font => {
    const formatMap: Record<string, string> = {
      'woff2': 'woff2',
      'woff': 'woff',
      'ttf': 'truetype',
      'truetype': 'truetype',
      'otf': 'opentype',
      'opentype': 'opentype',
      'eot': 'embedded-opentype',
    };
    const format = formatMap[font.format] || font.format;
    const filename = font.localPath.split('/').pop() || '';

    // Determine the actual font-weight from filename if the stored weight is generic (400)
    const actualWeight = font.weight === 400 ? weightFromFilename(filename) : font.weight;

    return `@font-face {
  font-family: '${targetFontFamily}';
  font-style: ${font.style};
  font-weight: ${actualWeight};
  font-display: swap;
  src: url('fonts/${filename}') format('${format}');
}`;
  });

  return `/* stylelint-disable max-line-length */
${declarations.join('\n\n')}
`;
}

/**
 * Generate fallback font-face declarations for system fonts
 */
export function generateFallbackFonts(bodyFont: string, headingFont: string): string {
  const fallbacks: string[] = [];

  // Create fallback for body font
  const bodyFontName = bodyFont.split(',')[0].trim().replace(/["']/g, '');
  if (bodyFontName && bodyFontName !== 'system-ui') {
    fallbacks.push(`@font-face {
  font-family: ${bodyFontName}-fallback;
  size-adjust: 100%;
  src: local('Arial');
}`);
  }

  // Create fallback for heading font if different
  const headingFontName = headingFont.split(',')[0].trim().replace(/["']/g, '');
  if (headingFontName && headingFontName !== bodyFontName && headingFontName !== 'system-ui') {
    fallbacks.push(`@font-face {
  font-family: ${headingFontName}-fallback;
  size-adjust: 100%;
  src: local('Arial');
}`);
  }

  return fallbacks.join('\n\n');
}
