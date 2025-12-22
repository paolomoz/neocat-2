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
  | 'INTERNAL_ERROR'
  | 'GITHUB_API_ERROR'
  | 'GITHUB_AUTH_FAILED'
  | 'DA_API_ERROR'
  | 'DA_AUTH_FAILED';

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
  // DA Service Account (Adobe IMS OAuth)
  DA_CLIENT_ID?: string;
  DA_CLIENT_SECRET?: string;
  DA_SERVICE_TOKEN?: string;
  // GitHub Token for EDS preview flow
  GITHUB_TOKEN?: string;
}

// GitHub Push Request/Response
export interface GitHubPushRequest {
  owner: string;
  repo: string;
  blockName: string;
  js: string;
  css: string;
  token: string;
  branch?: string;
  siteUrl?: string; // Website URL to generate branch name (e.g., "www.researchaffiliates.com")
  commitMessage?: string;
}

export interface GitHubPushResponse {
  success: true;
  commitUrl: string;
  jsPath: string;
  cssPath: string;
  commitSha: string;
  branch: string;
}

// DA Admin Create Page Request/Response
export interface DACreatePageRequest {
  org: string;
  site: string;
  path: string;
  html: string;
  token?: string; // Optional - if not provided, uses service account from env
}

export interface DACreatePageResponse {
  success: true;
  pageUrl: string;
  previewUrl: string;
  path: string;
}

// =============================================================================
// EDS Preview Flow Types
// =============================================================================

/** GitHub configuration for block generation */
export interface GitHubConfig {
  owner: string;
  repo: string;
  token?: string; // Optional - uses GITHUB_TOKEN from env if not provided
}

/** DA configuration for block generation */
export interface DAConfig {
  org: string;
  site: string;
  /** Base path for generated variants (e.g., "/drafts/gen") */
  basePath?: string;
  token?: string; // Optional - uses service account if not provided
}

/** Generated block variant info */
export interface BlockVariant {
  option: number;
  iteration: number;
  blockName: string;
  branch: string;
  daPath: string;
  previewUrl: string;
  html: string;
  css: string;
  js: string;
}

/** Request to push a block variant to GitHub and DA */
export interface BlockVariantPushRequest {
  sessionId: string;
  blockName: string;
  option: number;
  iteration: number;
  html: string;
  css: string;
  js: string;
  github: GitHubConfig;
  da: DAConfig;
}

/** Response from pushing a block variant */
export interface BlockVariantPushResponse {
  success: true;
  variant: BlockVariant;
}

/** Request to finalize and merge winning variant */
export interface BlockFinalizeRequest {
  sessionId: string;
  blockName: string;
  winner: {
    option: number;
    iteration: number;
  };
  github: GitHubConfig;
  da?: DAConfig;
  /** Path to move winning DA page to (optional) */
  finalDaPath?: string;
  /** Whether to cleanup all temporary branches and pages */
  cleanup?: boolean;
}

/** Response from finalizing a block */
export interface BlockFinalizeResponse {
  success: true;
  merged: {
    branch: string;
    into: string;
    commitSha: string;
    commitUrl: string;
  };
  library?: {
    daPath: string;
    daUrl: string;
    previewUrl: string;
  };
  cleanup?: {
    branchesDeleted: number;
    pagesDeleted: number;
  };
}

/** Request to cleanup a generation session */
export interface BlockCleanupRequest {
  sessionId: string;
  blockName: string;
  github: GitHubConfig;
  da?: DAConfig;
}

/** Response from cleanup */
export interface BlockCleanupResponse {
  success: true;
  branchesDeleted: string[];
  pagesDeleted: string[];
}
