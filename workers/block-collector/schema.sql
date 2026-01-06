-- AEM EDS Block Collection Database Schema
-- Run with: wrangler d1 execute block-database --file=./schema.sql

-- ============================================
-- DISCOVERY TABLES
-- ============================================

-- GitHub developers we track for discovery
CREATE TABLE IF NOT EXISTS developers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  priority INTEGER DEFAULT 1,  -- 1=low, 2=medium, 3=high
  repos_scanned INTEGER DEFAULT 0,
  orgs_discovered INTEGER DEFAULT 0,
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- GitHub organizations discovered
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  discovered_via TEXT,  -- developer username who led us here
  repos_count INTEGER DEFAULT 0,
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- GitHub repositories discovered (potential EDS sites)
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  full_name TEXT UNIQUE NOT NULL,  -- e.g., "hlxsites/acme-corp"
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT DEFAULT 'main',
  is_eds_confirmed INTEGER DEFAULT 0,  -- 1 if verified EDS structure
  eds_confidence REAL DEFAULT 0,  -- 0-100 detection confidence
  discovered_via TEXT,  -- 'developer', 'org', 'hlxsites', etc.
  live_url TEXT,  -- Production URL if known
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================
-- SITE & PAGE TABLES
-- ============================================

-- Sites discovered and crawled
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  repository_id TEXT REFERENCES repositories(id),
  discovered_at TEXT DEFAULT (datetime('now')),
  last_crawled_at TEXT,
  crawl_status TEXT DEFAULT 'pending',  -- 'pending', 'in_progress', 'complete', 'failed'
  page_count INTEGER DEFAULT 0,
  block_count INTEGER DEFAULT 0,
  average_quality_score REAL,
  design_system_id TEXT,
  metadata TEXT  -- JSON blob for extra data
);

-- Individual pages crawled
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  url TEXT NOT NULL,
  path TEXT NOT NULL,  -- URL path portion
  template_type TEXT,  -- 'homepage', 'article', 'product', 'landing', etc.
  crawled_at TEXT,
  lighthouse_score INTEGER,
  load_time_ms INTEGER,
  html_hash TEXT,  -- For deduplication
  screenshot_url TEXT,  -- R2 path
  metadata TEXT,  -- JSON blob
  UNIQUE(site_id, path)
);

-- ============================================
-- BLOCK TABLES (Main Training Data)
-- ============================================

-- Extracted blocks
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  page_id TEXT NOT NULL REFERENCES pages(id),

  -- Identity
  block_name TEXT NOT NULL,  -- e.g., 'hero', 'cards', 'columns'
  block_variant TEXT,  -- e.g., 'hero-large', 'cards-3-col'

  -- Content references (actual content in R2)
  html_url TEXT,  -- R2 path to HTML
  css_url TEXT,   -- R2 path to CSS
  js_url TEXT,    -- R2 path to JS (if any)
  screenshot_url TEXT,  -- R2 path to screenshot

  -- Inline content for quick access
  html TEXT,
  cleaned_html TEXT,

  -- Bounding box
  bbox_x INTEGER,
  bbox_y INTEGER,
  bbox_width INTEGER,
  bbox_height INTEGER,

  -- Structured data (JSON)
  design_tokens TEXT,  -- JSON: colors, fonts, spacing
  content_model TEXT,  -- JSON: structure, fields
  css_variables TEXT,  -- JSON: CSS custom properties

  -- Quality metrics
  quality_score REAL,  -- 0-100
  quality_tier TEXT,   -- 'gold', 'silver', 'bronze', 'unrated'
  quality_breakdown TEXT,  -- JSON: individual scores

  -- Behavior
  has_javascript INTEGER DEFAULT 0,
  has_interactivity INTEGER DEFAULT 0,

  -- Metadata
  extracted_at TEXT DEFAULT (datetime('now')),
  detector_used TEXT,

  UNIQUE(page_id, block_name, bbox_x, bbox_y)
);

-- ============================================
-- DESIGN SYSTEM TABLES
-- ============================================

-- Design systems per site
CREATE TABLE IF NOT EXISTS design_systems (
  id TEXT PRIMARY KEY,
  site_id TEXT UNIQUE REFERENCES sites(id),

  -- Design tokens (JSON)
  colors TEXT,
  typography TEXT,
  spacing TEXT,
  breakpoints TEXT,
  css_variables TEXT,

  -- Preview
  preview_url TEXT,  -- R2 path

  extracted_at TEXT DEFAULT (datetime('now'))
);

-- ============================================
-- TAXONOMY TABLES
-- ============================================

-- Block categories/taxonomy
CREATE TABLE IF NOT EXISTS block_categories (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  parent_id TEXT REFERENCES block_categories(id)
);

-- Block to category mapping
CREATE TABLE IF NOT EXISTS block_category_map (
  block_id TEXT NOT NULL REFERENCES blocks(id),
  category_id TEXT NOT NULL REFERENCES block_categories(id),
  PRIMARY KEY (block_id, category_id)
);

-- ============================================
-- JOB QUEUE TABLES
-- ============================================

-- Crawl job queue
CREATE TABLE IF NOT EXISTS crawl_queue (
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id),
  url TEXT NOT NULL,
  priority INTEGER DEFAULT 5,  -- 1=highest, 10=lowest
  status TEXT DEFAULT 'pending',  -- 'pending', 'in_progress', 'complete', 'failed'
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- ============================================
-- INDEXES
-- ============================================

-- Discovery indexes
CREATE INDEX IF NOT EXISTS idx_repositories_eds ON repositories(is_eds_confirmed);
CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories(owner);

-- Site/page indexes
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(crawl_status);
CREATE INDEX IF NOT EXISTS idx_sites_quality ON sites(average_quality_score);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site_id);
CREATE INDEX IF NOT EXISTS idx_pages_template ON pages(template_type);

-- Block indexes
CREATE INDEX IF NOT EXISTS idx_blocks_site ON blocks(site_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_name ON blocks(block_name);
CREATE INDEX IF NOT EXISTS idx_blocks_quality ON blocks(quality_score);
CREATE INDEX IF NOT EXISTS idx_blocks_tier ON blocks(quality_tier);

-- Queue indexes
CREATE INDEX IF NOT EXISTS idx_queue_status ON crawl_queue(status, priority);

-- ============================================
-- SEED DATA: Block Categories
-- ============================================

INSERT OR IGNORE INTO block_categories (id, name, description, parent_id) VALUES
  ('cat-layout', 'Layout', 'Structural layout blocks', NULL),
  ('cat-hero', 'Hero', 'Hero sections and banners', 'cat-layout'),
  ('cat-columns', 'Columns', 'Multi-column layouts', 'cat-layout'),
  ('cat-section', 'Section', 'Content sections', 'cat-layout'),

  ('cat-content', 'Content', 'Content display blocks', NULL),
  ('cat-cards', 'Cards', 'Card-based content', 'cat-content'),
  ('cat-carousel', 'Carousel', 'Sliding/rotating content', 'cat-content'),
  ('cat-accordion', 'Accordion', 'Expandable content', 'cat-content'),
  ('cat-tabs', 'Tabs', 'Tabbed content', 'cat-content'),
  ('cat-table', 'Table', 'Tabular data', 'cat-content'),

  ('cat-media', 'Media', 'Media display blocks', NULL),
  ('cat-video', 'Video', 'Video players', 'cat-media'),
  ('cat-image', 'Image', 'Image galleries and displays', 'cat-media'),
  ('cat-embed', 'Embed', 'External embeds', 'cat-media'),

  ('cat-navigation', 'Navigation', 'Navigation blocks', NULL),
  ('cat-header', 'Header', 'Site headers', 'cat-navigation'),
  ('cat-footer', 'Footer', 'Site footers', 'cat-navigation'),
  ('cat-breadcrumb', 'Breadcrumb', 'Breadcrumb navigation', 'cat-navigation'),

  ('cat-form', 'Form', 'Form and input blocks', NULL),
  ('cat-cta', 'CTA', 'Call-to-action blocks', NULL),
  ('cat-social', 'Social', 'Social media blocks', NULL);

-- ============================================
-- SEED DATA: EDS Organizations
-- ============================================

-- Developers are discovered dynamically from key repo contributors
-- (adobe/aem-boilerplate, adobe/helix-website, etc.)

-- Seed EDS Organizations (aemsites is the primary source)
INSERT OR IGNORE INTO organizations (id, name, discovered_via, repos_count) VALUES
  ('org-1', 'aemsites', 'seed', 0),
  ('org-2', 'hlxsites', 'seed', 0);
