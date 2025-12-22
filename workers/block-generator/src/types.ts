// Bounding box for block region
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Request/Response types
export interface BlockRequest {
  url: string;
  /** CSS selector (legacy) */
  selector?: string;
  /** Bounding box coordinates (legacy) */
  boundingBox?: BoundingBox;
  /** Additional sibling selectors to merge content from (legacy) */
  siblingSelectors?: string[];
  /** Section description from visual analysis (preferred) */
  sectionDescription?: string;
  /** Section name from visual analysis (preferred) */
  sectionName?: string;
  /** Y-coordinate where section starts (from /analyze) */
  yStart?: number;
  /** Y-coordinate where section ends (from /analyze) */
  yEnd?: number;
}

export interface BlockResponse {
  success: true;
  blockName: string;
  layoutPattern: LayoutPattern;
  html: string;
  js: string;
  css: string;
  metadata: BlockMetadata;
}

export interface ErrorResponse {
  success: false;
  error: string;
  code: ErrorCode;
}

export interface BlockMetadata {
  elementCount: number;
  hasImages: boolean;
  hasHeadings: boolean;
  hasLinks: boolean;
  rowCount: number;
  columnCount: number;
}

// Layout analysis types
export type LayoutPattern =
  | 'grid'
  | 'columns'
  | 'hero'
  | 'media-text'
  | 'list'
  | 'accordion'
  | 'text-only'
  | 'single-image'
  | 'tabs'
  | 'cards'
  | 'carousel'
  | 'text'
  | 'unknown';

export type ChildSignature =
  | 'image'
  | 'heading'
  | 'text'
  | 'link'
  | 'list'
  | 'container'
  | 'media'
  | 'mixed';

export interface LayoutAnalysis {
  pattern: LayoutPattern;
  blockName: string;
  structure: LayoutStructure;
}

export interface LayoutStructure {
  rowCount: number;
  columnCount: number;
  hasImages: boolean;
  hasHeadings: boolean;
  hasLinks: boolean;
  hasList: boolean;
  childSignatures: ChildSignature[];
  isRepeating: boolean;
}

// Extracted content types
export interface ExtractedContent {
  outerHTML: string;
  innerHTML: string;
  tagName: string;
  className: string;
  childCount: number;
}

// EDS block structure types
export interface EDSRow {
  cells: EDSCell[];
}

export interface EDSCell {
  content: string;
  isImage: boolean;
}

// Error codes
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_URL'
  | 'FETCH_FAILED'
  | 'SELECTOR_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'ANALYSIS_FAILED'
  | 'GENERATION_FAILED'
  | 'INTERNAL_ERROR';

// Custom error class
export class BlockGeneratorError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'BlockGeneratorError';
  }
}

// Environment bindings
export interface Env {
  ALLOWED_ORIGINS: string;
  // Anthropic API (direct)
  ANTHROPIC_API_KEY?: string;
  // Anthropic via AWS Bedrock
  ANTHROPIC_USE_BEDROCK?: string;
  ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK?: string;
  ANTHROPIC_AWS_REGION?: string;
  ANTHROPIC_MODEL?: string;
  // Cloudflare Browser Rendering
  BROWSER?: Fetcher;
}
