// ============================================
// Environment & Bindings
// ============================================

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  BROWSER: Fetcher;
  AI: Ai;
  VECTOR_INDEX: VectorizeIndex;
  GITHUB_TOKEN?: string;
  WAPPALYZER_API_KEY?: string;
  LIGHTHOUSE_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AWS_BEARER_TOKEN_BEDROCK?: string;
  ALLOWED_ORIGINS: string;
}

// ============================================
// Discovery Types
// ============================================

export interface Developer {
  id: string;
  username: string;
  priority: 1 | 2 | 3;
  repos_scanned: number;
  orgs_discovered: number;
  last_scanned_at: string | null;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  discovered_via: string | null;
  repos_count: number;
  last_scanned_at: string | null;
  created_at: string;
}

export interface Repository {
  id: string;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  is_eds_confirmed: boolean;
  eds_confidence: number;
  discovered_via: string;
  live_url: string | null;
  last_scanned_at: string | null;
  created_at: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  updated_at: string;
}

export interface GitHubOrg {
  login: string;
  id: number;
  description: string | null;
}

// ============================================
// EDS Detection Types
// ============================================

export interface EDSDetectionSignals {
  hasRumScript: boolean;
  hasAemJs: boolean;
  hasLibFranklinJs: boolean;
  hasBlockStructure: boolean;
  hasSectionStructure: boolean;
  hasFastlyHeaders: boolean;
  isEDSDomain: boolean;
  hasBlocksDirectory: boolean;
  hasScriptsDirectory: boolean;
  lighthouseScore: number | null;
}

export interface EDSDetectionResult {
  isEDS: boolean;
  confidence: number;
  signals: EDSDetectionSignals;
  liveUrl: string | null;
}

export interface RepoEDSCheck {
  hasAemJs: boolean;
  hasBlocksDir: boolean;
  hasScriptsDir: boolean;
  hasStylesDir: boolean;
  hasFstabYaml: boolean;
  hasHelixDir: boolean;
}

// ============================================
// Site & Page Types
// ============================================

export type CrawlStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

export interface Site {
  id: string;
  domain: string;
  repository_id: string | null;
  discovered_at: string;
  last_crawled_at: string | null;
  crawl_status: CrawlStatus;
  page_count: number;
  block_count: number;
  average_quality_score: number | null;
  design_system_id: string | null;
  metadata: SiteMetadata | null;
}

export interface SiteMetadata {
  title?: string;
  description?: string;
  language?: string;
  industry?: string;
  company?: string;
}

export interface Page {
  id: string;
  site_id: string;
  url: string;
  path: string;
  template_type: string | null;
  crawled_at: string | null;
  lighthouse_score: number | null;
  load_time_ms: number | null;
  html_hash: string | null;
  screenshot_url: string | null;
  metadata: PageMetadata | null;
}

export interface PageMetadata {
  title?: string;
  description?: string;
  og_image?: string;
  sections_count?: number;
  blocks_count?: number;
}

export interface PageCrawlResult {
  url: string;
  html: string;
  screenshot: ArrayBuffer | null;
  loadTime: number;
  sections: SectionData[];
  metadata: PageMetadata;
  lighthouseScore: number | null;
}

export interface SectionData {
  index: number;
  className: string;
  html: string;
  blocks: BlockDetection[];
}

// ============================================
// Block Types
// ============================================

export interface Block {
  id: string;
  site_id: string;
  page_id: string;
  block_name: string;
  block_variant: string | null;
  html_url: string | null;
  css_url: string | null;
  js_url: string | null;
  screenshot_url: string | null;
  html: string | null;
  cleaned_html: string | null;
  bbox_x: number;
  bbox_y: number;
  bbox_width: number;
  bbox_height: number;
  design_tokens: DesignTokens | null;
  content_model: ContentModel | null;
  css_variables: Record<string, string> | null;
  quality_score: number | null;
  quality_tier: QualityTier | null;
  quality_breakdown: QualityBreakdown | null;
  has_javascript: boolean;
  has_interactivity: boolean;
  extracted_at: string;
  detector_used: string;
}

export interface BlockDetection {
  name: string;
  variant: string | null;
  html: string;
  boundingBox: BoundingBox;
  hasJavaScript: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================
// Design System Types
// ============================================

export interface DesignSystem {
  id: string;
  site_id: string;
  colors: ColorTokens;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  breakpoints: BreakpointTokens;
  css_variables: Record<string, string>;
  preview_url: string | null;
  extracted_at: string;
}

export interface DesignTokens {
  colors: string[];
  fonts: string[];
  spacing: string[];
  breakpoints: string[];
}

export interface ColorTokens {
  primary: string[];
  secondary: string[];
  neutral: string[];
  semantic: {
    success?: string;
    warning?: string;
    error?: string;
    info?: string;
  };
}

export interface TypographyTokens {
  fontFamilies: string[];
  fontSizes: string[];
  fontWeights: string[];
  lineHeights: string[];
}

export interface SpacingTokens {
  values: string[];
  scale: Record<string, string>;
}

export interface BreakpointTokens {
  mobile: string;
  tablet: string;
  desktop: string;
  wide?: string;
}

// ============================================
// Content Model Types
// ============================================

export interface ContentModel {
  structure: ContentModelNode[];
  requiredFields: string[];
  optionalFields: string[];
}

export interface ContentModelNode {
  type: 'element' | 'text' | 'image' | 'link' | 'list';
  tag?: string;
  className?: string;
  children?: ContentModelNode[];
  attributes?: Record<string, string>;
}

// ============================================
// Quality Scoring Types
// ============================================

export type QualityTier = 'gold' | 'silver' | 'bronze' | 'unrated';

export interface QualityScore {
  overall: number;
  breakdown: QualityBreakdown;
  issues: QualityIssue[];
  tier: QualityTier;
}

export interface QualityBreakdown {
  performance: number;
  accessibility: number;
  semanticHtml: number;
  codeQuality: number;
  responsive: number;
  edsCompliance: number;
}

export interface QualityIssue {
  category: keyof QualityBreakdown;
  severity: 'error' | 'warning' | 'info';
  message: string;
  selector?: string;
}

// ============================================
// Crawl Queue Types
// ============================================

export type QueueStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

export interface CrawlJob {
  id: string;
  site_id: string | null;
  url: string;
  priority: number;
  status: QueueStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ============================================
// API Types
// ============================================

export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
    offset?: number;
    sources?: string[];
  };
}

export interface DiscoveryStats {
  developers_scanned: number;
  organizations_found: number;
  repositories_found: number;
  eds_confirmed: number;
  sites_discovered: number;
}

export interface CrawlStats {
  sites_total: number;
  sites_pending: number;
  sites_complete: number;
  sites_failed: number;
  pages_crawled: number;
  blocks_extracted: number;
}

export interface BlockStats {
  total: number;
  by_tier: Record<QualityTier, number>;
  by_name: Record<string, number>;
  average_quality: number;
}

// ============================================
// Utility Types
// ============================================

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export function generateId(): string {
  return crypto.randomUUID();
}

export function parseJSON<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function stringifyJSON(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ============================================
// Chat Types
// ============================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  sessionId?: string;
}

export interface SuggestedBlock {
  id: string;
  blockName: string;
  qualityTier: QualityTier;
  qualityScore: number;
  description: string;
  matchReason: string;
}

export interface ChatResponse {
  success: boolean;
  message: string;
  suggestedBlocks?: SuggestedBlock[];
  followUpQuestion?: string;
  quickReplies?: string[];
  sessionId: string;
  error?: string;
}
