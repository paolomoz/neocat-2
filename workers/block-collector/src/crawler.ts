import { PageCrawlResult, PageMetadata, SectionData, BlockDetection, BoundingBox } from './types';
import {
  getSites,
  getSiteById,
  updateSiteCrawlStatus,
  updateSiteStats,
  createPage,
  getPagesBySite,
  addToQueue,
  getNextFromQueue,
  completeQueueJob,
} from './database';
import { storePage } from './storage';

// ============================================
// Rate Limiting
// ============================================

const CRAWL_DELAY_MS = 3000; // 3 seconds between requests per domain
const domainLastCrawl: Map<string, number> = new Map();

async function rateLimitedFetch(url: string): Promise<Response> {
  const domain = new URL(url).hostname;
  const lastCrawl = domainLastCrawl.get(domain) || 0;
  const now = Date.now();
  const waitTime = Math.max(0, CRAWL_DELAY_MS - (now - lastCrawl));

  if (waitTime > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  domainLastCrawl.set(domain, Date.now());

  return fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; EDS-Block-Collector/1.0; +https://github.com/adobe/aem-boilerplate)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });
}

// ============================================
// Robots.txt Parsing
// ============================================

interface RobotsRules {
  allowed: string[];
  disallowed: string[];
  crawlDelay: number | null;
  sitemaps: string[];
}

async function parseRobotsTxt(domain: string): Promise<RobotsRules> {
  const rules: RobotsRules = {
    allowed: [],
    disallowed: [],
    crawlDelay: null,
    sitemaps: [],
  };

  try {
    const response = await fetch(`https://${domain}/robots.txt`);
    if (!response.ok) return rules;

    const text = await response.text();
    const lines = text.split('\n');

    let isRelevantUserAgent = false;

    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();

      if (trimmed.startsWith('user-agent:')) {
        const agent = trimmed.replace('user-agent:', '').trim();
        isRelevantUserAgent = agent === '*' || agent.includes('bot');
      } else if (isRelevantUserAgent) {
        if (trimmed.startsWith('allow:')) {
          rules.allowed.push(trimmed.replace('allow:', '').trim());
        } else if (trimmed.startsWith('disallow:')) {
          rules.disallowed.push(trimmed.replace('disallow:', '').trim());
        } else if (trimmed.startsWith('crawl-delay:')) {
          const delay = parseInt(trimmed.replace('crawl-delay:', '').trim(), 10);
          if (!isNaN(delay)) rules.crawlDelay = delay * 1000;
        }
      }

      if (trimmed.startsWith('sitemap:')) {
        rules.sitemaps.push(line.replace(/sitemap:/i, '').trim());
      }
    }
  } catch (e) {
    console.error(`Error parsing robots.txt for ${domain}:`, e);
  }

  return rules;
}

function isPathAllowed(path: string, rules: RobotsRules): boolean {
  // Check disallowed first
  for (const pattern of rules.disallowed) {
    if (pattern === '/' || path.startsWith(pattern)) {
      // Check if explicitly allowed
      for (const allowPattern of rules.allowed) {
        if (path.startsWith(allowPattern)) return true;
      }
      return false;
    }
  }
  return true;
}

// ============================================
// Sitemap Parsing
// ============================================

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: number;
}

async function parseSitemap(sitemapUrl: string): Promise<SitemapUrl[]> {
  const urls: SitemapUrl[] = [];

  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) return urls;

    const text = await response.text();

    // Check if it's a sitemap index
    if (text.includes('<sitemapindex')) {
      const sitemapUrls = text.match(/<loc>([^<]+)<\/loc>/g) || [];
      for (const match of sitemapUrls.slice(0, 5)) {
        // Limit nested sitemaps
        const nestedUrl = match.replace(/<\/?loc>/g, '');
        const nestedUrls = await parseSitemap(nestedUrl);
        urls.push(...nestedUrls);
      }
    } else {
      // Regular sitemap
      const urlMatches = text.match(/<url>[\s\S]*?<\/url>/g) || [];
      for (const urlBlock of urlMatches) {
        const locMatch = urlBlock.match(/<loc>([^<]+)<\/loc>/);
        if (locMatch) {
          const url: SitemapUrl = { loc: locMatch[1] };

          const lastmodMatch = urlBlock.match(/<lastmod>([^<]+)<\/lastmod>/);
          if (lastmodMatch) url.lastmod = lastmodMatch[1];

          const priorityMatch = urlBlock.match(/<priority>([^<]+)<\/priority>/);
          if (priorityMatch) url.priority = parseFloat(priorityMatch[1]);

          urls.push(url);
        }
      }
    }
  } catch (e) {
    console.error(`Error parsing sitemap ${sitemapUrl}:`, e);
  }

  return urls;
}

// ============================================
// Page Crawling
// ============================================

export async function crawlPage(url: string): Promise<PageCrawlResult | null> {
  const startTime = Date.now();

  try {
    console.log(`[crawlPage] Fetching: ${url}`);
    const response = await rateLimitedFetch(url);
    console.log(`[crawlPage] Response status: ${response.status} for ${url}`);
    if (!response.ok) {
      console.error(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const loadTime = Date.now() - startTime;

    // Parse metadata
    const metadata = extractMetadata(html);

    // Parse sections and blocks
    const sections = extractSections(html);

    return {
      url,
      html,
      screenshot: null, // Will be captured separately with Puppeteer
      loadTime,
      sections,
      metadata,
      lighthouseScore: null, // Will be fetched separately
    };
  } catch (e) {
    console.error(`Error crawling ${url}:`, e);
    return null;
  }
}

function extractMetadata(html: string): PageMetadata {
  const metadata: PageMetadata = {};

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) metadata.title = titleMatch[1].trim();

  // Meta description
  const descMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
  );
  if (descMatch) metadata.description = descMatch[1];

  // OG Image
  const ogImageMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
  );
  if (ogImageMatch) metadata.og_image = ogImageMatch[1];

  return metadata;
}

function extractSections(html: string): SectionData[] {
  const sections: SectionData[] = [];

  // In EDS, sections are divs with class="section" or class="section style-name"
  // but NOT class="section-metadata" or other section-* classes
  // Look for <div class="section"> or <div class="section something">
  const sectionPattern = /<div[^>]*class="section(?:\s+[^"]*)?(?<!-\w+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="section(?:\s|")|\s*<\/main>|\s*<\/body>|$)/gi;

  let match;
  let index = 0;
  while ((match = sectionPattern.exec(html)) !== null) {
    const fullMatch = match[0];
    const sectionHtml = fullMatch;

    // Extract class name
    const classMatch = sectionHtml.match(/class="([^"]+)"/);
    const className = classMatch ? classMatch[1] : '';

    // Skip if this is section-metadata or similar
    if (className.includes('section-') && !className.startsWith('section ')) {
      continue;
    }

    // Extract blocks from section
    const blocks = extractBlocks(sectionHtml);

    sections.push({
      index: index++,
      className,
      html: sectionHtml,
      blocks,
    });
  }

  // Fallback: if no sections found with strict matching, try finding main content and extract blocks directly
  if (sections.length === 0) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      const blocks = extractBlocks(mainMatch[1]);
      if (blocks.length > 0) {
        sections.push({
          index: 0,
          className: 'main',
          html: mainMatch[1],
          blocks,
        });
      }
    }
  }

  return sections;
}

function extractBlocks(sectionHtml: string): BlockDetection[] {
  const blocks: BlockDetection[] = [];

  // Known non-block classes to exclude
  const nonBlockClasses = new Set([
    'section', 'section-metadata', 'button-container', 'default-content-wrapper',
    'icon', 'picture', 'image', 'video',
  ]);

  // Find all divs with a class - potential blocks
  // In EDS, blocks are typically direct children of sections with a class name that identifies the block
  const divPattern = /<div[^>]*class="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="|<\/div>\s*$)/gi;

  let match;
  while ((match = divPattern.exec(sectionHtml)) !== null) {
    const className = match[1];
    const classes = className.split(/\s+/);
    const firstClass = classes[0];

    // Skip non-block elements
    if (!firstClass || nonBlockClasses.has(firstClass)) continue;
    if (firstClass.startsWith('icon-')) continue; // Icon classes
    if (className.includes('section-metadata')) continue;

    // The first class is typically the block name
    const blockName = firstClass;

    // Check for variants (additional classes that modify the block)
    let variant: string | null = null;
    for (const cls of classes.slice(1)) {
      // Skip common utility classes
      if (['block', 'wrapper', 'container'].includes(cls)) continue;
      if (cls.startsWith('inview-')) continue; // Animation classes
      if (cls === blockName + '-wrapper') continue;
      // First non-utility class after block name is the variant
      if (cls.includes(blockName + '-')) {
        variant = cls;
        break;
      }
    }

    // Get the block HTML (simplified - just use the match)
    const blockHtml = match[0];

    blocks.push({
      name: blockName,
      variant,
      html: blockHtml,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      hasJavaScript: blockHtml.includes('<script') || blockHtml.includes('onclick'),
    });
  }

  // Deduplicate by block name (in case of multiple matches)
  const seen = new Set<string>();
  return blocks.filter(b => {
    const key = `${b.name}:${b.variant || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================
// Site Crawling Pipeline
// ============================================

export interface SiteCrawlOptions {
  maxPages?: number;
  respectRobots?: boolean;
  includeSitemap?: boolean;
}

export interface SiteCrawlResult {
  siteId: string;
  domain: string;
  pagesDiscovered: number;
  pagesCrawled: number;
  blocksFound: number;
  errors: string[];
}

export async function crawlSite(
  db: D1Database,
  bucket: R2Bucket,
  siteId: string,
  options?: SiteCrawlOptions
): Promise<SiteCrawlResult> {
  const maxPages = options?.maxPages || 25;
  const includeSitemap = options?.includeSitemap !== false;

  // Get site to check domain
  const site = await getSiteById(db, siteId);

  // Skip robots.txt for EDS preview domains (they always have Disallow: /)
  const isEdsPreviewDomain = site?.domain && (
    site.domain.endsWith('.aem.live') ||
    site.domain.endsWith('.hlx.live') ||
    site.domain.endsWith('.hlx.page') ||
    site.domain.endsWith('.aem.page')
  );
  const respectRobots = isEdsPreviewDomain ? false : (options?.respectRobots !== false);

  const result: SiteCrawlResult = {
    siteId,
    domain: '',
    pagesDiscovered: 0,
    pagesCrawled: 0,
    blocksFound: 0,
    errors: [],
  };

  // Site was already fetched above to check domain type
  if (!site) {
    result.errors.push('Site not found');
    return result;
  }

  result.domain = site.domain;

  // Update status
  await updateSiteCrawlStatus(db, siteId, 'in_progress');

  try {
    // Get robots.txt rules
    let rules: RobotsRules = {
      allowed: [],
      disallowed: [],
      crawlDelay: null,
      sitemaps: [],
    };

    if (respectRobots) {
      rules = await parseRobotsTxt(site.domain);
    }

    // Collect URLs to crawl
    const urlsToCrawl: Set<string> = new Set();
    const baseUrl = `https://${site.domain}`;

    // Always include homepage
    urlsToCrawl.add(baseUrl);
    urlsToCrawl.add(`${baseUrl}/`);

    // Get URLs from sitemap
    if (includeSitemap && rules.sitemaps.length > 0) {
      for (const sitemapUrl of rules.sitemaps) {
        const sitemapUrls = await parseSitemap(sitemapUrl);
        for (const su of sitemapUrls) {
          if (su.loc.startsWith(baseUrl)) {
            urlsToCrawl.add(su.loc);
          }
        }
      }
    }

    // Try common EDS pages - expanded list for better discovery
    const commonPaths = [
      '/',
      '/about',
      '/about-us',
      '/contact',
      '/contact-us',
      '/products',
      '/services',
      '/solutions',
      '/blog',
      '/news',
      '/resources',
      '/support',
      '/help',
      '/faq',
      '/pricing',
      '/features',
      '/customers',
      '/case-studies',
      '/partners',
      '/careers',
      '/team',
      '/company',
      '/documentation',
      '/docs',
      '/getting-started',
      '/overview',
      '/home',
    ];

    for (const path of commonPaths) {
      urlsToCrawl.add(`${baseUrl}${path}`);
    }

    result.pagesDiscovered = urlsToCrawl.size;

    // Crawl pages - use array to allow dynamic additions
    const crawledPaths = new Set<string>();
    const urlQueue = Array.from(urlsToCrawl);
    let queueIndex = 0;

    while (queueIndex < urlQueue.length && result.pagesCrawled < maxPages) {
      const url = urlQueue[queueIndex++];
      const urlObj = new URL(url);
      const path = urlObj.pathname || '/';

      // Skip if already crawled
      if (crawledPaths.has(path)) continue;

      // Check robots.txt
      if (respectRobots && !isPathAllowed(path, rules)) {
        console.log(`Skipping ${path} - disallowed by robots.txt`);
        continue;
      }

      try {
        console.log(`[crawlSite] Starting crawl: ${url}`);
        const pageResult = await crawlPage(url);
        console.log(`[crawlSite] Result for ${url}: ${pageResult ? 'success' : 'null'}`);

        if (pageResult) {
          // Determine template type
          const templateType = inferTemplateType(path, pageResult.html);

          // Store page HTML
          const pageId = crypto.randomUUID();
          const stored = await storePage(bucket, siteId, pageId, {
            html: pageResult.html,
          });

          // Create page record with same ID used for storage
          await createPage(db, {
            id: pageId,  // Use same ID as storage
            siteId,
            url,
            path,
            templateType,
            lighthouseScore: pageResult.lighthouseScore ?? undefined,
            loadTimeMs: pageResult.loadTime,
            htmlHash: hashString(pageResult.html),
            screenshotUrl: stored.screenshotUrl ?? undefined,
            metadata: pageResult.metadata,
          });

          // Count blocks
          for (const section of pageResult.sections) {
            result.blocksFound += section.blocks.length;
          }

          // Extract links from this page to discover more URLs
          const discoveredLinks = extractInternalLinks(pageResult.html, baseUrl);
          for (const link of discoveredLinks) {
            const linkPath = new URL(link).pathname;
            if (!crawledPaths.has(linkPath) && !urlQueue.includes(link)) {
              urlQueue.push(link);
            }
          }

          crawledPaths.add(path);
          result.pagesCrawled++;
        }
      } catch (e) {
        result.errors.push(`Failed to crawl ${url}: ${e}`);
      }

      // Apply crawl delay
      if (rules.crawlDelay) {
        await new Promise((resolve) => setTimeout(resolve, rules.crawlDelay!));
      }
    }

    // Update pages discovered count after link extraction
    result.pagesDiscovered = urlQueue.length;

    // Update site stats
    await updateSiteStats(db, siteId, result.pagesCrawled, result.blocksFound, null);
    await updateSiteCrawlStatus(db, siteId, 'complete');
  } catch (e) {
    result.errors.push(`Site crawl failed: ${e}`);
    await updateSiteCrawlStatus(db, siteId, 'failed');
  }

  return result;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Extract internal links from HTML content
 * Returns paths that belong to the same domain
 */
function extractInternalLinks(html: string, baseUrl: string): string[] {
  const links: Set<string> = new Set();
  const domain = new URL(baseUrl).hostname;

  // Match href attributes in anchor tags
  const hrefPattern = /href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];

    // Skip non-page links
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }

    // Skip file downloads
    if (/\.(pdf|zip|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|svg|mp4|webm)$/i.test(href)) {
      continue;
    }

    try {
      let fullUrl: string;

      if (href.startsWith('http://') || href.startsWith('https://')) {
        // Absolute URL - check if same domain
        const hrefUrl = new URL(href);
        if (hrefUrl.hostname !== domain) continue;
        fullUrl = href;
      } else if (href.startsWith('/')) {
        // Root-relative URL
        fullUrl = `${baseUrl}${href}`;
      } else {
        // Relative URL - skip these to avoid complexity
        continue;
      }

      // Normalize the URL
      const normalized = new URL(fullUrl);
      const path = normalized.pathname;

      // Skip common non-content paths
      if (path.startsWith('/api/') || path.startsWith('/_') || path.startsWith('/static/')) {
        continue;
      }

      links.add(`${baseUrl}${path}`);
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(links);
}

function inferTemplateType(path: string, html: string): string {
  const pathLower = path.toLowerCase();

  if (path === '/' || path === '') return 'homepage';
  if (pathLower.includes('/blog/') || pathLower.includes('/news/')) return 'article';
  if (pathLower.includes('/product')) return 'product';
  if (pathLower.includes('/about')) return 'about';
  if (pathLower.includes('/contact')) return 'contact';
  if (pathLower.includes('/landing')) return 'landing';

  // Check HTML structure
  if (html.includes('class="article') || html.includes('itemprop="articleBody"')) {
    return 'article';
  }
  if (html.includes('class="product') || html.includes('itemprop="product"')) {
    return 'product';
  }

  return 'generic';
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// ============================================
// Queue-Based Crawling
// ============================================

export async function processNextInQueue(
  db: D1Database,
  bucket: R2Bucket
): Promise<{ processed: boolean; result?: SiteCrawlResult; error?: string }> {
  const job = await getNextFromQueue(db);
  if (!job) {
    return { processed: false };
  }

  try {
    const result = await crawlSite(db, bucket, job.site_id!);
    await completeQueueJob(db, job.id, 'complete');
    return { processed: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await completeQueueJob(db, job.id, 'failed', error);
    return { processed: true, error };
  }
}

export async function queueSiteForCrawl(
  db: D1Database,
  siteId: string,
  priority: number = 5
): Promise<string> {
  const site = await getSiteById(db, siteId);
  if (!site) throw new Error('Site not found');

  return addToQueue(db, `https://${site.domain}`, siteId, priority);
}

export async function queuePendingSites(
  db: D1Database,
  limit: number = 10
): Promise<number> {
  const sites = await getSites(db, { status: 'pending', limit });
  let queued = 0;

  for (const site of sites) {
    await addToQueue(db, `https://${site.domain}`, site.id, 5);
    queued++;
  }

  return queued;
}
