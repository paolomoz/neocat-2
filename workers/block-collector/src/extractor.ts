import {
  Block,
  BlockDetection,
  BoundingBox,
  ContentModel,
  ContentModelNode,
  DesignTokens,
} from './types';
import {
  getPagesBySite,
  getPageById,
  createBlock,
  getBlocks,
  getSiteById,
  upsertDesignSystem,
} from './database';
import { storeBlock, getPage as getPageFromStorage } from './storage';

// ============================================
// Block Extraction from HTML
// ============================================

export interface ExtractedBlock {
  name: string;
  variant: string | null;
  html: string;
  cleanedHtml: string;
  boundingBox: BoundingBox;
  hasJavaScript: boolean;
  hasInteractivity: boolean;
  designTokens: DesignTokens;
  contentModel: ContentModel;
  cssVariables: Record<string, string>;
}

export function extractBlocksFromHtml(html: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];

  // Known non-block classes to exclude
  const nonBlockClasses = new Set([
    'section', 'section-metadata', 'button-container', 'default-content-wrapper',
    'icon', 'picture', 'image', 'video',
  ]);

  // Find all divs with a class - potential blocks
  // In EDS, blocks are typically divs with a class name that identifies the block
  const divPattern = /<div[^>]*class="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="|<\/div>\s*$)/gi;

  const seenBlocks = new Set<string>();
  let match;
  while ((match = divPattern.exec(html)) !== null) {
    const className = match[1];
    const blockHtml = match[0];
    const classes = className.split(/\s+/);
    const firstClass = classes[0];

    // Skip non-block elements
    if (!firstClass || nonBlockClasses.has(firstClass)) continue;
    if (firstClass.startsWith('icon-')) continue;
    if (className.includes('section-metadata')) continue;
    if (isSystemBlock(firstClass)) continue;

    // The first class is typically the block name
    const blockName = firstClass;

    // Skip duplicates
    if (seenBlocks.has(blockName)) continue;
    seenBlocks.add(blockName);

    // Check for variants (additional classes that modify the block)
    let variant: string | null = null;
    for (const cls of classes.slice(1)) {
      if (['block', 'wrapper', 'container'].includes(cls)) continue;
      if (cls.startsWith('inview-')) continue;
      if (cls === blockName + '-wrapper') continue;
      if (cls.includes(blockName + '-')) {
        variant = cls;
        break;
      }
    }

    const block = processBlock(blockName, blockHtml, variant);
    if (block) blocks.push(block);
  }

  return blocks;
}

function extractBlockName(className: string, type: 'wrapper' | 'direct'): string | null {
  const classes = className.split(/\s+/);

  if (type === 'wrapper') {
    for (const cls of classes) {
      if (cls.endsWith('-wrapper')) {
        return cls.replace('-wrapper', '');
      }
    }
  } else {
    const blockIndex = classes.indexOf('block');
    if (blockIndex > 0) {
      return classes[blockIndex - 1];
    }
  }

  return null;
}

function isSystemBlock(name: string): boolean {
  const systemBlocks = ['section', 'default-content', 'fragment'];
  return systemBlocks.includes(name.toLowerCase());
}

function processBlock(name: string, html: string, passedVariant?: string | null): ExtractedBlock | null {
  // Use passed variant or extract from HTML
  const variant = passedVariant ?? extractVariant(html, name);

  // Clean HTML
  const cleanedHtml = cleanBlockHtml(html);

  // Check for JavaScript/interactivity
  const hasJavaScript =
    html.includes('<script') ||
    html.includes('onclick') ||
    html.includes('onload') ||
    html.includes('data-block-status');

  const hasInteractivity =
    hasJavaScript ||
    html.includes('role="button"') ||
    html.includes('tabindex') ||
    html.includes('aria-expanded') ||
    html.includes('aria-controls');

  // Extract design tokens
  const designTokens = extractDesignTokens(html);

  // Extract content model
  const contentModel = extractContentModel(html);

  // Extract CSS variables
  const cssVariables = extractCssVariables(html);

  return {
    name,
    variant,
    html,
    cleanedHtml,
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    hasJavaScript,
    hasInteractivity,
    designTokens,
    contentModel,
    cssVariables,
  };
}

function extractVariant(html: string, baseName: string): string | null {
  const classMatch = html.match(/class="([^"]+)"/);
  if (!classMatch) return null;

  const classes = classMatch[1].split(/\s+/);
  for (const cls of classes) {
    if (cls.startsWith(`${baseName}-`) && cls !== `${baseName}-wrapper`) {
      return cls;
    }
  }

  return null;
}

function cleanBlockHtml(html: string): string {
  return html
    // Remove inline styles
    .replace(/\s*style="[^"]*"/gi, '')
    // Remove data attributes (except data-block-name)
    .replace(/\s*data-(?!block-name)[a-z-]+="[^"]*"/gi, '')
    // Remove empty class attributes
    .replace(/\s*class=""/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Remove extra spaces in tags
    .replace(/\s*>/g, '>')
    .replace(/<\s*/g, '<')
    .trim();
}

// ============================================
// Design Token Extraction
// ============================================

function extractDesignTokens(html: string): DesignTokens {
  const tokens: DesignTokens = {
    colors: [],
    fonts: [],
    spacing: [],
    breakpoints: [],
  };

  // Extract inline style colors
  const colorPatterns = [
    /#[0-9a-fA-F]{3,8}/g,
    /rgb\([^)]+\)/g,
    /rgba\([^)]+\)/g,
    /hsl\([^)]+\)/g,
  ];

  for (const pattern of colorPatterns) {
    const matches = html.match(pattern) || [];
    tokens.colors.push(...matches);
  }
  tokens.colors = [...new Set(tokens.colors)];

  // Extract font references
  const fontPattern = /font-family:\s*([^;}"]+)/gi;
  let fontMatch;
  while ((fontMatch = fontPattern.exec(html)) !== null) {
    const fonts = fontMatch[1].split(',').map((f) => f.trim().replace(/["']/g, ''));
    tokens.fonts.push(...fonts);
  }
  tokens.fonts = [...new Set(tokens.fonts)];

  // Extract spacing values
  const spacingPattern = /(?:margin|padding|gap)(?:-[a-z]+)?:\s*([^;}"]+)/gi;
  let spacingMatch;
  while ((spacingMatch = spacingPattern.exec(html)) !== null) {
    const values = spacingMatch[1].split(/\s+/);
    tokens.spacing.push(...values);
  }
  tokens.spacing = [...new Set(tokens.spacing)];

  return tokens;
}

// ============================================
// Content Model Extraction
// ============================================

function extractContentModel(html: string): ContentModel {
  const model: ContentModel = {
    structure: [],
    requiredFields: [],
    optionalFields: [],
  };

  // Parse structure
  model.structure = parseHtmlStructure(html);

  // Determine required vs optional fields
  // Headings and first paragraph are usually required
  const hasHeading = html.match(/<h[1-6][^>]*>/i);
  const hasParagraph = html.match(/<p[^>]*>/i);
  const hasImage = html.match(/<img[^>]*>/i) || html.match(/<picture[^>]*>/i);
  const hasLink = html.match(/<a[^>]*>/i);
  const hasList = html.match(/<[uo]l[^>]*>/i);

  if (hasHeading) model.requiredFields.push('heading');
  if (hasParagraph) model.optionalFields.push('paragraph');
  if (hasImage) model.optionalFields.push('image');
  if (hasLink) model.optionalFields.push('link');
  if (hasList) model.optionalFields.push('list');

  return model;
}

function parseHtmlStructure(html: string): ContentModelNode[] {
  const nodes: ContentModelNode[] = [];

  // Simple tag extraction (in production use proper DOM parsing)
  const tagPattern = /<([\w]+)([^>]*)>/g;
  let match;
  const seenTags = new Set<string>();

  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];

    // Skip common container tags
    if (['div', 'span', 'section'].includes(tag)) continue;

    // Determine type
    let type: ContentModelNode['type'] = 'element';
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].includes(tag)) type = 'text';
    if (['img', 'picture', 'video', 'svg'].includes(tag)) type = 'image';
    if (tag === 'a') type = 'link';
    if (['ul', 'ol'].includes(tag)) type = 'list';

    // Extract class
    const classMatch = attrs.match(/class="([^"]+)"/);
    const className = classMatch ? classMatch[1] : undefined;

    // Avoid duplicates
    const key = `${tag}:${className || ''}`;
    if (seenTags.has(key)) continue;
    seenTags.add(key);

    nodes.push({
      type,
      tag,
      className,
    });
  }

  return nodes;
}

// ============================================
// CSS Variable Extraction
// ============================================

function extractCssVariables(html: string): Record<string, string> {
  const variables: Record<string, string> = {};

  // Find var() usages in inline styles
  const varPattern = /var\((--[^,)]+)(?:,\s*([^)]+))?\)/g;
  let match;

  while ((match = varPattern.exec(html)) !== null) {
    const varName = match[1];
    const fallback = match[2]?.trim();
    if (!variables[varName]) {
      variables[varName] = fallback || '';
    }
  }

  // Find CSS variable declarations
  const declPattern = /(--[a-z-]+):\s*([^;}"]+)/gi;
  while ((match = declPattern.exec(html)) !== null) {
    variables[match[1]] = match[2].trim();
  }

  return variables;
}

// ============================================
// Page Block Extraction Pipeline
// ============================================

export interface PageExtractionResult {
  pageId: string;
  blocksExtracted: number;
  blocksStored: number;
  errors: string[];
}

export async function extractBlocksFromPage(
  db: D1Database,
  bucket: R2Bucket,
  siteId: string,
  pageId: string
): Promise<PageExtractionResult> {
  const result: PageExtractionResult = {
    pageId,
    blocksExtracted: 0,
    blocksStored: 0,
    errors: [],
  };

  // Get page HTML
  const pageData = await getPageFromStorage(bucket, siteId, pageId);
  if (!pageData) {
    result.errors.push('Page HTML not found in storage');
    return result;
  }

  // Extract blocks
  const blocks = extractBlocksFromHtml(pageData.html);
  result.blocksExtracted = blocks.length;

  // Store each block
  for (const block of blocks) {
    try {
      const blockId = crypto.randomUUID();

      // Store block files
      const stored = await storeBlock(bucket, siteId, blockId, {
        html: block.html,
        metadata: {
          name: block.name,
          variant: block.variant,
          designTokens: block.designTokens,
          contentModel: block.contentModel,
        },
      });

      // Create database record
      await createBlock(db, {
        siteId,
        pageId,
        blockName: block.name,
        blockVariant: block.variant ?? undefined,
        html: block.html,
        cleanedHtml: block.cleanedHtml,
        htmlUrl: stored.htmlUrl,
        screenshotUrl: stored.screenshotUrl ?? undefined,
        bboxX: block.boundingBox.x,
        bboxY: block.boundingBox.y,
        bboxWidth: block.boundingBox.width,
        bboxHeight: block.boundingBox.height,
        designTokens: block.designTokens,
        contentModel: block.contentModel,
        cssVariables: block.cssVariables,
        hasJavascript: block.hasJavaScript,
        hasInteractivity: block.hasInteractivity,
        detectorUsed: 'regex-extractor',
      });

      result.blocksStored++;
    } catch (e) {
      result.errors.push(`Failed to store block ${block.name}: ${e}`);
    }
  }

  return result;
}

// ============================================
// Site Block Extraction Pipeline
// ============================================

export interface SiteExtractionResult {
  siteId: string;
  pagesProcessed: number;
  totalBlocksExtracted: number;
  totalBlocksStored: number;
  uniqueBlockTypes: string[];
  errors: string[];
}

export async function extractBlocksFromSite(
  db: D1Database,
  bucket: R2Bucket,
  siteId: string
): Promise<SiteExtractionResult> {
  const result: SiteExtractionResult = {
    siteId,
    pagesProcessed: 0,
    totalBlocksExtracted: 0,
    totalBlocksStored: 0,
    uniqueBlockTypes: [],
    errors: [],
  };

  const blockTypes = new Set<string>();

  // Get all pages for site
  const pages = await getPagesBySite(db, siteId);

  for (const page of pages) {
    try {
      const pageResult = await extractBlocksFromPage(db, bucket, siteId, page.id);

      result.pagesProcessed++;
      result.totalBlocksExtracted += pageResult.blocksExtracted;
      result.totalBlocksStored += pageResult.blocksStored;
      result.errors.push(...pageResult.errors);
    } catch (e) {
      result.errors.push(`Failed to process page ${page.path}: ${e}`);
    }
  }

  // Get unique block types
  const blocks = await getBlocks(db, { siteId, limit: 1000 });
  for (const block of blocks) {
    blockTypes.add(block.block_name);
  }
  result.uniqueBlockTypes = Array.from(blockTypes);

  return result;
}

// ============================================
// Design System Extraction
// ============================================

export interface DesignSystemExtractionResult {
  siteId: string;
  colors: string[];
  fonts: string[];
  spacing: string[];
  cssVariables: Record<string, string>;
}

export async function extractDesignSystemFromSite(
  db: D1Database,
  bucket: R2Bucket,
  siteId: string
): Promise<DesignSystemExtractionResult> {
  const result: DesignSystemExtractionResult = {
    siteId,
    colors: [],
    fonts: [],
    spacing: [],
    cssVariables: {},
  };

  // Aggregate design tokens from all blocks
  const blocks = await getBlocks(db, { siteId, limit: 1000 });

  const allColors = new Set<string>();
  const allFonts = new Set<string>();
  const allSpacing = new Set<string>();
  const allVariables: Record<string, string> = {};

  for (const block of blocks) {
    if (block.design_tokens) {
      const tokens = block.design_tokens as DesignTokens;
      tokens.colors?.forEach((c) => allColors.add(c));
      tokens.fonts?.forEach((f) => allFonts.add(f));
      tokens.spacing?.forEach((s) => allSpacing.add(s));
    }

    if (block.css_variables) {
      Object.assign(allVariables, block.css_variables);
    }
  }

  result.colors = Array.from(allColors);
  result.fonts = Array.from(allFonts);
  result.spacing = Array.from(allSpacing);
  result.cssVariables = allVariables;

  // Save design system
  await upsertDesignSystem(db, siteId, {
    colors: {
      primary: result.colors.filter((c) => !c.includes('gray') && !c.includes('white') && !c.includes('black')),
      secondary: [],
      neutral: result.colors.filter((c) => c.includes('gray') || c.includes('white') || c.includes('black')),
      semantic: {},
    },
    typography: {
      fontFamilies: result.fonts,
      fontSizes: [],
      fontWeights: [],
      lineHeights: [],
    },
    spacing: {
      values: result.spacing,
      scale: {},
    },
    breakpoints: {
      mobile: '600px',
      tablet: '900px',
      desktop: '1200px',
    },
    cssVariables: result.cssVariables,
  });

  return result;
}
