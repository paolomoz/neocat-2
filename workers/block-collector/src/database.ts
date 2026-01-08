import {
  Developer,
  Organization,
  Repository,
  Site,
  Page,
  Block,
  DesignSystem,
  CrawlJob,
  CrawlStatus,
  QueueStatus,
  QualityTier,
  generateId,
  parseJSON,
  stringifyJSON,
  DiscoveryStats,
  CrawlStats,
  BlockStats,
} from './types';

// ============================================
// Developer Operations
// ============================================

export async function getDevelopers(db: D1Database): Promise<Developer[]> {
  const result = await db
    .prepare('SELECT * FROM developers ORDER BY priority DESC, username ASC')
    .all<Developer>();
  return result.results;
}

export async function getDeveloperByUsername(
  db: D1Database,
  username: string
): Promise<Developer | null> {
  const result = await db
    .prepare('SELECT * FROM developers WHERE username = ?')
    .bind(username)
    .first<Developer>();
  return result;
}

export async function updateDeveloperScanned(
  db: D1Database,
  username: string,
  reposScanned: number,
  orgsDiscovered: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE developers
       SET repos_scanned = ?, orgs_discovered = ?, last_scanned_at = datetime('now')
       WHERE username = ?`
    )
    .bind(reposScanned, orgsDiscovered, username)
    .run();
}

// ============================================
// Organization Operations
// ============================================

export async function upsertOrganization(
  db: D1Database,
  name: string,
  discoveredVia: string
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO organizations (id, name, discovered_via)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET discovered_via = excluded.discovered_via`
    )
    .bind(id, name, discoveredVia)
    .run();
  return id;
}

export async function getOrganizations(db: D1Database): Promise<Organization[]> {
  const result = await db
    .prepare('SELECT * FROM organizations ORDER BY name ASC')
    .all<Organization>();
  return result.results;
}

export async function updateOrgScanned(
  db: D1Database,
  name: string,
  reposCount: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE organizations
       SET repos_count = ?, last_scanned_at = datetime('now')
       WHERE name = ?`
    )
    .bind(reposCount, name)
    .run();
}

// ============================================
// Repository Operations
// ============================================

export async function upsertRepository(
  db: D1Database,
  repo: {
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    discoveredVia: string;
  }
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO repositories (id, full_name, owner, name, default_branch, discovered_via)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(full_name) DO UPDATE SET
         default_branch = excluded.default_branch,
         discovered_via = excluded.discovered_via`
    )
    .bind(id, repo.fullName, repo.owner, repo.name, repo.defaultBranch, repo.discoveredVia)
    .run();

  // Get the actual ID (might be existing)
  const existing = await db
    .prepare('SELECT id FROM repositories WHERE full_name = ?')
    .bind(repo.fullName)
    .first<{ id: string }>();
  return existing?.id || id;
}

export async function getRepositories(
  db: D1Database,
  options?: { edsOnly?: boolean; limit?: number; offset?: number }
): Promise<Repository[]> {
  let query = 'SELECT * FROM repositories';
  const params: (string | number)[] = [];

  if (options?.edsOnly) {
    query += ' WHERE is_eds_confirmed = 1';
  }

  query += ' ORDER BY eds_confidence DESC, created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const result = await (params.length > 0 ? stmt.bind(...params) : stmt).all<Repository>();
  return result.results.map((r) => ({
    ...r,
    is_eds_confirmed: Boolean(r.is_eds_confirmed),
  }));
}

export async function updateRepositoryEDS(
  db: D1Database,
  fullName: string,
  isEDS: boolean,
  confidence: number,
  liveUrl?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE repositories
       SET is_eds_confirmed = ?, eds_confidence = ?, live_url = ?, last_scanned_at = datetime('now')
       WHERE full_name = ?`
    )
    .bind(isEDS ? 1 : 0, confidence, liveUrl || null, fullName)
    .run();
}

export async function getUnscannedRepositories(
  db: D1Database,
  limit: number = 100
): Promise<Repository[]> {
  const result = await db
    .prepare(
      `SELECT * FROM repositories
       WHERE last_scanned_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<Repository>();
  return result.results;
}

// ============================================
// Site Operations
// ============================================

export async function createSite(
  db: D1Database,
  domain: string,
  repositoryId?: string
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO sites (id, domain, repository_id)
       VALUES (?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET repository_id = excluded.repository_id`
    )
    .bind(id, domain, repositoryId || null)
    .run();

  const existing = await db
    .prepare('SELECT id FROM sites WHERE domain = ?')
    .bind(domain)
    .first<{ id: string }>();
  return existing?.id || id;
}

export async function getSites(
  db: D1Database,
  options?: { status?: CrawlStatus; limit?: number; offset?: number }
): Promise<Site[]> {
  let query = 'SELECT * FROM sites';
  const params: (string | number)[] = [];

  if (options?.status) {
    query += ' WHERE crawl_status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY average_quality_score DESC NULLS LAST, discovered_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const result = await (params.length > 0 ? stmt.bind(...params) : stmt).all<Site>();
  return result.results.map((s) => ({
    ...s,
    metadata: parseJSON(s.metadata as unknown as string),
  }));
}

export async function getSiteById(db: D1Database, id: string): Promise<Site | null> {
  const result = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Site>();
  if (!result) return null;
  return {
    ...result,
    metadata: parseJSON(result.metadata as unknown as string),
  };
}

export async function getSiteByDomain(db: D1Database, domain: string): Promise<Site | null> {
  const result = await db
    .prepare('SELECT * FROM sites WHERE domain = ?')
    .bind(domain)
    .first<Site>();
  if (!result) return null;
  return {
    ...result,
    metadata: parseJSON(result.metadata as unknown as string),
  };
}

export async function updateSiteCrawlStatus(
  db: D1Database,
  id: string,
  status: CrawlStatus
): Promise<void> {
  const updates =
    status === 'complete'
      ? "crawl_status = ?, last_crawled_at = datetime('now')"
      : 'crawl_status = ?';

  await db.prepare(`UPDATE sites SET ${updates} WHERE id = ?`).bind(status, id).run();
}

export async function updateSiteStats(
  db: D1Database,
  id: string,
  pageCount: number,
  blockCount: number,
  avgQuality: number | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE sites
       SET page_count = ?, block_count = ?, average_quality_score = ?
       WHERE id = ?`
    )
    .bind(pageCount, blockCount, avgQuality, id)
    .run();
}

// ============================================
// Page Operations
// ============================================

export async function createPage(
  db: D1Database,
  page: {
    id?: string;  // Optional: use provided ID or generate new one
    siteId: string;
    url: string;
    path: string;
    templateType?: string;
    lighthouseScore?: number;
    loadTimeMs?: number;
    htmlHash?: string;
    screenshotUrl?: string;
    metadata?: object;
  }
): Promise<string> {
  const id = page.id || generateId();
  await db
    .prepare(
      `INSERT INTO pages (id, site_id, url, path, template_type, lighthouse_score, load_time_ms, html_hash, screenshot_url, metadata, crawled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(site_id, path) DO UPDATE SET
         lighthouse_score = excluded.lighthouse_score,
         load_time_ms = excluded.load_time_ms,
         html_hash = excluded.html_hash,
         screenshot_url = excluded.screenshot_url,
         metadata = excluded.metadata,
         crawled_at = datetime('now')`
    )
    .bind(
      id,
      page.siteId,
      page.url,
      page.path,
      page.templateType || null,
      page.lighthouseScore || null,
      page.loadTimeMs || null,
      page.htmlHash || null,
      page.screenshotUrl || null,
      stringifyJSON(page.metadata)
    )
    .run();

  const existing = await db
    .prepare('SELECT id FROM pages WHERE site_id = ? AND path = ?')
    .bind(page.siteId, page.path)
    .first<{ id: string }>();
  return existing?.id || id;
}

export async function getPagesBySite(db: D1Database, siteId: string): Promise<Page[]> {
  const result = await db
    .prepare('SELECT * FROM pages WHERE site_id = ? ORDER BY path ASC')
    .bind(siteId)
    .all<Page>();
  return result.results.map((p) => ({
    ...p,
    metadata: parseJSON(p.metadata as unknown as string),
  }));
}

export async function getPageById(db: D1Database, id: string): Promise<Page | null> {
  const result = await db.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<Page>();
  if (!result) return null;
  return {
    ...result,
    metadata: parseJSON(result.metadata as unknown as string),
  };
}

// ============================================
// Block Operations
// ============================================

export async function createBlock(
  db: D1Database,
  block: {
    siteId: string;
    pageId: string;
    blockName: string;
    blockVariant?: string;
    html?: string;
    cleanedHtml?: string;
    htmlUrl?: string;
    cssUrl?: string;
    jsUrl?: string;
    screenshotUrl?: string;
    bboxX: number;
    bboxY: number;
    bboxWidth: number;
    bboxHeight: number;
    designTokens?: object;
    contentModel?: object;
    cssVariables?: object;
    qualityScore?: number;
    qualityTier?: QualityTier;
    qualityBreakdown?: object;
    hasJavascript?: boolean;
    hasInteractivity?: boolean;
    detectorUsed: string;
  }
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO blocks (
        id, site_id, page_id, block_name, block_variant,
        html, cleaned_html, html_url, css_url, js_url, screenshot_url,
        bbox_x, bbox_y, bbox_width, bbox_height,
        design_tokens, content_model, css_variables,
        quality_score, quality_tier, quality_breakdown,
        has_javascript, has_interactivity, detector_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, block_name, bbox_x, bbox_y) DO UPDATE SET
        html = excluded.html,
        cleaned_html = excluded.cleaned_html,
        quality_score = excluded.quality_score,
        quality_tier = excluded.quality_tier,
        quality_breakdown = excluded.quality_breakdown,
        extracted_at = datetime('now')`
    )
    .bind(
      id,
      block.siteId,
      block.pageId,
      block.blockName,
      block.blockVariant || null,
      block.html || null,
      block.cleanedHtml || null,
      block.htmlUrl || null,
      block.cssUrl || null,
      block.jsUrl || null,
      block.screenshotUrl || null,
      block.bboxX,
      block.bboxY,
      block.bboxWidth,
      block.bboxHeight,
      stringifyJSON(block.designTokens),
      stringifyJSON(block.contentModel),
      stringifyJSON(block.cssVariables),
      block.qualityScore ?? null,
      block.qualityTier || null,
      stringifyJSON(block.qualityBreakdown),
      block.hasJavascript ? 1 : 0,
      block.hasInteractivity ? 1 : 0,
      block.detectorUsed
    )
    .run();
  return id;
}

export async function getBlocks(
  db: D1Database,
  options?: {
    siteId?: string;
    pageId?: string;
    blockName?: string;
    tier?: QualityTier;
    minQuality?: number;
    limit?: number;
    offset?: number;
  }
): Promise<Block[]> {
  // Join with pages and sites to get page_url
  let query = `
    SELECT
      b.*,
      p.url as page_url,
      s.domain as site_domain
    FROM blocks b
    LEFT JOIN pages p ON b.page_id = p.id
    LEFT JOIN sites s ON b.site_id = s.id
    WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.siteId) {
    query += ' AND b.site_id = ?';
    params.push(options.siteId);
  }
  if (options?.pageId) {
    query += ' AND b.page_id = ?';
    params.push(options.pageId);
  }
  if (options?.blockName) {
    query += ' AND b.block_name = ?';
    params.push(options.blockName);
  }
  if (options?.tier) {
    query += ' AND b.quality_tier = ?';
    params.push(options.tier);
  }
  if (options?.minQuality !== undefined) {
    query += ' AND b.quality_score >= ?';
    params.push(options.minQuality);
  }

  query += ' ORDER BY b.quality_score DESC NULLS LAST';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const result = await (params.length > 0 ? stmt.bind(...params) : stmt).all<Block & { page_url?: string; site_domain?: string }>();
  return result.results.map((b) => ({
    ...b,
    has_javascript: Boolean(b.has_javascript),
    has_interactivity: Boolean(b.has_interactivity),
    design_tokens: parseJSON(b.design_tokens as unknown as string),
    content_model: parseJSON(b.content_model as unknown as string),
    css_variables: parseJSON(b.css_variables as unknown as string),
    quality_breakdown: parseJSON(b.quality_breakdown as unknown as string),
    // Generate full page URL
    page_url: b.page_url || (b.site_domain ? `https://${b.site_domain}/` : undefined),
    // Generate description based on block characteristics
    description: generateBlockDescription(b),
  }));
}

// Get a single block by ID
export async function getBlockById(
  db: D1Database,
  blockId: string
): Promise<Block | null> {
  const query = `
    SELECT
      b.*,
      p.url as page_url,
      s.domain as site_domain
    FROM blocks b
    LEFT JOIN pages p ON b.page_id = p.id
    LEFT JOIN sites s ON b.site_id = s.id
    WHERE b.id = ?
  `;

  const result = await db
    .prepare(query)
    .bind(blockId)
    .first<Block & { page_url?: string; site_domain?: string }>();

  if (!result) return null;

  return {
    ...result,
    has_javascript: Boolean(result.has_javascript),
    has_interactivity: Boolean(result.has_interactivity),
    design_tokens: parseJSON(result.design_tokens as unknown as string),
    content_model: parseJSON(result.content_model as unknown as string),
    css_variables: parseJSON(result.css_variables as unknown as string),
    quality_breakdown: parseJSON(result.quality_breakdown as unknown as string),
    page_url: result.page_url || (result.site_domain ? `https://${result.site_domain}/` : undefined),
    description: generateBlockDescription(result),
  } as Block & { page_url?: string; description?: string };
}

// Generate a human-readable description of what the block demonstrates
function generateBlockDescription(block: Block & { page_url?: string; site_domain?: string }): string {
  const html = block.html || '';
  const name = block.block_name;
  const breakdown = block.quality_breakdown as { [key: string]: number } | undefined;

  const features: string[] = [];

  // Check for common patterns
  if (html.includes('<picture') && html.includes('srcset')) {
    features.push('responsive images');
  }
  if (html.includes('icon icon-')) {
    features.push('icon system');
  }
  if (html.match(/<h[1-6]/)) {
    features.push('heading hierarchy');
  }
  if (html.includes('<ul') || html.includes('<ol')) {
    features.push('semantic lists');
  }
  if (html.includes('button-container') || html.includes('cta')) {
    features.push('CTA buttons');
  }
  if (html.includes('aria-') || html.includes('role=')) {
    features.push('ARIA accessibility');
  }
  if (html.match(/class="[^"]*--/)) {
    features.push('BEM naming');
  }

  // Check quality strengths
  if (breakdown) {
    if (breakdown.performance >= 95) features.push('optimized performance');
    if (breakdown.accessibility >= 95) features.push('excellent accessibility');
    if (breakdown.responsive >= 95) features.push('fully responsive');
    if (breakdown.edsCompliance >= 90) features.push('EDS best practices');
  }

  // Build description
  const tier = block.quality_tier || 'unrated';
  const tierDesc = tier === 'gold' ? 'high-quality' : tier === 'silver' ? 'well-implemented' : 'standard';

  if (features.length === 0) {
    return `A ${tierDesc} ${name} block implementation.`;
  }

  const featureList = features.slice(0, 3).join(', ');
  return `A ${tierDesc} ${name} block demonstrating ${featureList}.`;
}

export async function deleteBlocksBelowQuality(
  db: D1Database,
  minScore: number
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM blocks WHERE quality_score < ? OR quality_score IS NULL')
    .bind(minScore)
    .run();
  return result.meta.changes;
}

// ============================================
// Design System Operations
// ============================================

export async function upsertDesignSystem(
  db: D1Database,
  siteId: string,
  designSystem: {
    colors?: object;
    typography?: object;
    spacing?: object;
    breakpoints?: object;
    cssVariables?: object;
    previewUrl?: string;
  }
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO design_systems (id, site_id, colors, typography, spacing, breakpoints, css_variables, preview_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET
         colors = excluded.colors,
         typography = excluded.typography,
         spacing = excluded.spacing,
         breakpoints = excluded.breakpoints,
         css_variables = excluded.css_variables,
         preview_url = excluded.preview_url,
         extracted_at = datetime('now')`
    )
    .bind(
      id,
      siteId,
      stringifyJSON(designSystem.colors),
      stringifyJSON(designSystem.typography),
      stringifyJSON(designSystem.spacing),
      stringifyJSON(designSystem.breakpoints),
      stringifyJSON(designSystem.cssVariables),
      designSystem.previewUrl || null
    )
    .run();

  const existing = await db
    .prepare('SELECT id FROM design_systems WHERE site_id = ?')
    .bind(siteId)
    .first<{ id: string }>();
  return existing?.id || id;
}

export async function getDesignSystemBySite(
  db: D1Database,
  siteId: string
): Promise<DesignSystem | null> {
  const result = await db
    .prepare('SELECT * FROM design_systems WHERE site_id = ?')
    .bind(siteId)
    .first<DesignSystem>();
  if (!result) return null;
  return {
    ...result,
    colors: parseJSON(result.colors as unknown as string),
    typography: parseJSON(result.typography as unknown as string),
    spacing: parseJSON(result.spacing as unknown as string),
    breakpoints: parseJSON(result.breakpoints as unknown as string),
    css_variables: parseJSON(result.css_variables as unknown as string),
  } as DesignSystem;
}

// ============================================
// Crawl Queue Operations
// ============================================

export async function addToQueue(
  db: D1Database,
  url: string,
  siteId?: string,
  priority: number = 5
): Promise<string> {
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO crawl_queue (id, site_id, url, priority)
       VALUES (?, ?, ?, ?)`
    )
    .bind(id, siteId || null, url, priority)
    .run();
  return id;
}

export async function getNextFromQueue(db: D1Database): Promise<CrawlJob | null> {
  const job = await db
    .prepare(
      `SELECT * FROM crawl_queue
       WHERE status = 'pending' AND attempts < max_attempts
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`
    )
    .first<CrawlJob>();

  if (job) {
    await db
      .prepare(
        `UPDATE crawl_queue
         SET status = 'in_progress', attempts = attempts + 1, started_at = datetime('now')
         WHERE id = ?`
      )
      .bind(job.id)
      .run();
  }

  return job;
}

export async function completeQueueJob(
  db: D1Database,
  id: string,
  status: 'complete' | 'failed',
  error?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE crawl_queue
       SET status = ?, last_error = ?, completed_at = datetime('now')
       WHERE id = ?`
    )
    .bind(status, error || null, id)
    .run();
}

export async function getQueueStats(
  db: D1Database
): Promise<{ pending: number; in_progress: number; complete: number; failed: number }> {
  const result = await db
    .prepare(
      `SELECT status, COUNT(*) as count FROM crawl_queue GROUP BY status`
    )
    .all<{ status: QueueStatus; count: number }>();

  const stats = { pending: 0, in_progress: 0, complete: 0, failed: 0 };
  for (const row of result.results) {
    stats[row.status] = row.count;
  }
  return stats;
}

// ============================================
// Statistics Operations
// ============================================

export async function getDiscoveryStats(db: D1Database): Promise<DiscoveryStats> {
  const [devs, orgs, repos, eds, sites] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM developers WHERE last_scanned_at IS NOT NULL').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM organizations').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM repositories').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM repositories WHERE is_eds_confirmed = 1').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM sites').first<{ c: number }>(),
  ]);

  return {
    developers_scanned: devs?.c || 0,
    organizations_found: orgs?.c || 0,
    repositories_found: repos?.c || 0,
    eds_confirmed: eds?.c || 0,
    sites_discovered: sites?.c || 0,
  };
}

export async function getCrawlStats(db: D1Database): Promise<CrawlStats> {
  const [total, pending, complete, failed, pages, blocks] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM sites').first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) as c FROM sites WHERE crawl_status = 'pending'").first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) as c FROM sites WHERE crawl_status = 'complete'").first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) as c FROM sites WHERE crawl_status = 'failed'").first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM pages').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM blocks').first<{ c: number }>(),
  ]);

  return {
    sites_total: total?.c || 0,
    sites_pending: pending?.c || 0,
    sites_complete: complete?.c || 0,
    sites_failed: failed?.c || 0,
    pages_crawled: pages?.c || 0,
    blocks_extracted: blocks?.c || 0,
  };
}

export async function getBlockStats(db: D1Database): Promise<BlockStats> {
  const [total, byTier, byName, avgQuality] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM blocks').first<{ c: number }>(),
    db.prepare('SELECT quality_tier, COUNT(*) as c FROM blocks GROUP BY quality_tier').all<{ quality_tier: QualityTier | null; c: number }>(),
    db.prepare('SELECT block_name, COUNT(*) as c FROM blocks GROUP BY block_name ORDER BY c DESC LIMIT 20').all<{ block_name: string; c: number }>(),
    db.prepare('SELECT AVG(quality_score) as avg FROM blocks WHERE quality_score IS NOT NULL').first<{ avg: number }>(),
  ]);

  const tierCounts: Record<QualityTier, number> = { gold: 0, silver: 0, bronze: 0, unrated: 0 };
  for (const row of byTier.results) {
    if (row.quality_tier) {
      tierCounts[row.quality_tier] = row.c;
    } else {
      tierCounts.unrated += row.c;
    }
  }

  const nameCounts: Record<string, number> = {};
  for (const row of byName.results) {
    nameCounts[row.block_name] = row.c;
  }

  return {
    total: total?.c || 0,
    by_tier: tierCounts,
    by_name: nameCounts,
    average_quality: avgQuality?.avg || 0,
  };
}
