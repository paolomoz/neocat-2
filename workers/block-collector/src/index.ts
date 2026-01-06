import { Env, APIResponse } from './types';
import {
  getDiscoveryStats,
  getCrawlStats,
  getBlockStats,
  getSites,
  getSiteById,
  getBlocks,
  getRepositories,
  getQueueStats,
  createSite,
} from './database';
import {
  runDiscoveryPipeline,
  runVerificationPipeline,
  discoverSiteUrls,
  discoverContributors,
} from './discovery';
import {
  crawlSite,
  crawlPage,
  queueSiteForCrawl,
  queuePendingSites,
  processNextInQueue,
} from './crawler';
import {
  extractBlocksFromSite,
  extractDesignSystemFromSite,
} from './extractor';
import {
  scoreBlocksForSite,
  generateQualityReport,
} from './quality-scorer';
import { handleChatRequest } from './chat';

// ============================================
// CORS and Response Helpers
// ============================================

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse<T>(data: APIResponse<T>, status: number = 200, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(env ? corsHeaders(env) : {}),
    },
  });
}

function errorResponse(message: string, status: number = 500, env?: Env): Response {
  return jsonResponse({ success: false, error: message }, status, env);
}

// ============================================
// Route Handlers
// ============================================

// Health check
async function handleHealth(env: Env): Promise<Response> {
  return jsonResponse({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } }, 200, env);
}

// Stats endpoints
async function handleStats(env: Env): Promise<Response> {
  const [discovery, crawl, blocks] = await Promise.all([
    getDiscoveryStats(env.DB),
    getCrawlStats(env.DB),
    getBlockStats(env.DB),
  ]);

  return jsonResponse({
    success: true,
    data: { discovery, crawl, blocks },
  }, 200, env);
}

// Discovery endpoints
async function handleDiscoveryRun(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const body = await request.json().catch(() => ({})) as {
    maxDevelopers?: number;
    maxContributorsPerRepo?: number;
    maxOrgsPerDev?: number;
  };

  const result = await runDiscoveryPipeline(env.DB, env.GITHUB_TOKEN, {
    maxDevelopers: body.maxDevelopers || 50,
    maxContributorsPerRepo: body.maxContributorsPerRepo || 100,
    maxOrgsPerDev: body.maxOrgsPerDev || 10,
  });

  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleVerificationRun(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const body = await request.json().catch(() => ({})) as {
    maxRepos?: number;
    checkLiveUrl?: boolean;
  };

  const result = await runVerificationPipeline(env.DB, env.GITHUB_TOKEN, {
    maxRepos: body.maxRepos || 50,
    checkLiveUrl: body.checkLiveUrl !== false,
  });

  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleDiscoverUrls(env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const result = await discoverSiteUrls(env.DB, env.GITHUB_TOKEN);
  return jsonResponse({ success: true, data: result }, 200, env);
}

// Scan a single org directly and add sites without heavy DB writes
async function handleScanOrg(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const body = await request.json().catch(() => ({})) as { org: string; maxRepos?: number };
  if (!body.org) {
    return errorResponse('org required', 400, env);
  }

  const maxRepos = body.maxRepos || 100;
  const sites: { domain: string; repo: string; liveUrl: string }[] = [];
  const errors: string[] = [];

  try {
    // Fetch repos from org
    const reposRes = await fetch(`https://api.github.com/orgs/${body.org}/repos?per_page=${maxRepos}&sort=updated`, {
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'User-Agent': 'EDS-Block-Collector',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!reposRes.ok) {
      return errorResponse(`GitHub API error: ${reposRes.status}`, 500, env);
    }

    const repos = await reposRes.json() as Array<{ name: string; full_name: string; default_branch: string }>;

    // For each repo, construct the live URL and create a site
    for (const repo of repos) {
      try {
        const domain = `main--${repo.name}--${body.org}.aem.live`;
        const liveUrl = `https://${domain}/`;

        // Quick check if site responds
        const checkRes = await fetch(liveUrl, { method: 'HEAD' });
        if (checkRes.ok) {
          // Create site in DB
          const siteId = await createSite(env.DB, domain);
          sites.push({ domain, repo: repo.full_name, liveUrl });
        }
      } catch (e) {
        // Skip repos that don't have live sites
      }
    }
  } catch (e) {
    errors.push(`Failed to scan org: ${e}`);
  }

  return jsonResponse({
    success: true,
    data: {
      org: body.org,
      reposChecked: maxRepos,
      sitesFound: sites.length,
      sites,
      errors,
    },
  }, 200, env);
}

async function handleListContributors(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const url = new URL(request.url);
  const maxPerRepo = parseInt(url.searchParams.get('maxPerRepo') || '100');

  const contributors = await discoverContributors(env.GITHUB_TOKEN, { maxPerRepo });

  return jsonResponse({
    success: true,
    data: contributors,
    meta: {
      total: contributors.length,
      sources: [
        'adobe/aem-boilerplate',
        'adobe/helix-website',
        'adobe/helix-project-boilerplate',
        'adobe/aem-lib',
        'adobe/helix-shared',
        'adobe/helix-sidekick',
        'adobe/helix-sidekick-extension',
      ],
    },
  }, 200, env);
}

// Repository endpoints
async function handleListRepositories(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const edsOnly = url.searchParams.get('edsOnly') === 'true';
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const repos = await getRepositories(env.DB, { edsOnly, limit, offset });
  return jsonResponse({
    success: true,
    data: repos,
    meta: { limit, offset, total: repos.length },
  }, 200, env);
}

// Site endpoints
async function handleListSites(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') as 'pending' | 'complete' | 'failed' | null;
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const sites = await getSites(env.DB, {
    status: status || undefined,
    limit,
    offset,
  });

  return jsonResponse({
    success: true,
    data: sites,
    meta: { limit, offset, total: sites.length },
  }, 200, env);
}

async function handleGetSite(siteId: string, env: Env): Promise<Response> {
  const site = await getSiteById(env.DB, siteId);
  if (!site) {
    return errorResponse('Site not found', 404, env);
  }
  return jsonResponse({ success: true, data: site }, 200, env);
}

async function handleCreateSite(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { domain: string };

  if (!body.domain) {
    return errorResponse('domain required', 400, env);
  }

  const siteId = await createSite(env.DB, body.domain);
  return jsonResponse({ success: true, data: { siteId, domain: body.domain } }, 201, env);
}

// Crawler endpoints
async function handleCrawlSite(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    siteId: string;
    maxPages?: number;
  };

  if (!body.siteId) {
    return errorResponse('siteId required', 400, env);
  }

  const result = await crawlSite(env.DB, env.BUCKET, body.siteId, {
    maxPages: body.maxPages || 20,
  });

  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleQueueSite(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    siteId: string;
    priority?: number;
  };

  if (!body.siteId) {
    return errorResponse('siteId required', 400, env);
  }

  const jobId = await queueSiteForCrawl(env.DB, body.siteId, body.priority);
  return jsonResponse({ success: true, data: { jobId } }, 200, env);
}

async function handleQueuePending(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { limit?: number };
  const queued = await queuePendingSites(env.DB, body.limit || 10);
  return jsonResponse({ success: true, data: { queued } }, 200, env);
}

async function handleProcessQueue(env: Env): Promise<Response> {
  const result = await processNextInQueue(env.DB, env.BUCKET);
  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleQueueStats(env: Env): Promise<Response> {
  const stats = await getQueueStats(env.DB);
  return jsonResponse({ success: true, data: stats }, 200, env);
}

// Test endpoint to crawl a single URL
async function handleTestFetch(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { url: string };

  if (!body.url) {
    return errorResponse('url required', 400, env);
  }

  try {
    const result = await crawlPage(body.url);
    if (result) {
      return jsonResponse({
        success: true,
        data: {
          url: result.url,
          loadTime: result.loadTime,
          sectionsCount: result.sections.length,
          blocksCount: result.sections.reduce((sum, s) => sum + s.blocks.length, 0),
          metadata: result.metadata,
          htmlLength: result.html.length,
          htmlPreview: result.html.substring(0, 500),
          sections: result.sections.map((s, i) => ({
            index: i,
            className: s.className,
            htmlLength: s.html.length,
            blocks: s.blocks.map(b => ({ name: b.name, variant: b.variant })),
            htmlPreview: s.html.substring(0, 300),
          })),
        },
      }, 200, env);
    } else {
      return jsonResponse({ success: false, error: 'crawlPage returned null' }, 200, env);
    }
  } catch (e) {
    return errorResponse(`Fetch failed: ${e}`, 500, env);
  }
}

// Extraction endpoints
async function handleExtractBlocks(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { siteId: string };

  if (!body.siteId) {
    return errorResponse('siteId required', 400, env);
  }

  const result = await extractBlocksFromSite(env.DB, env.BUCKET, body.siteId);
  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleExtractDesignSystem(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { siteId: string };

  if (!body.siteId) {
    return errorResponse('siteId required', 400, env);
  }

  const result = await extractDesignSystemFromSite(env.DB, env.BUCKET, body.siteId);
  return jsonResponse({ success: true, data: result }, 200, env);
}

// Block endpoints
async function handleListBlocks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || undefined;
  const blockName = url.searchParams.get('blockName') || undefined;
  const tier = url.searchParams.get('tier') as 'gold' | 'silver' | 'bronze' | null;
  const minQuality = url.searchParams.get('minQuality');
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const blocks = await getBlocks(env.DB, {
    siteId,
    blockName,
    tier: tier || undefined,
    minQuality: minQuality ? parseInt(minQuality) : undefined,
    limit,
    offset,
  });

  return jsonResponse({
    success: true,
    data: blocks,
    meta: { limit, offset, total: blocks.length },
  }, 200, env);
}

// Quality endpoints
async function handleScoreBlocks(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    siteId: string;
    deleteUnrated?: boolean;
  };

  if (!body.siteId) {
    return errorResponse('siteId required', 400, env);
  }

  const result = await scoreBlocksForSite(env.DB, body.siteId, {
    deleteUnrated: body.deleteUnrated,
  });

  return jsonResponse({ success: true, data: result }, 200, env);
}

async function handleQualityReport(siteId: string, env: Env): Promise<Response> {
  const report = await generateQualityReport(env.DB, siteId);
  return jsonResponse({ success: true, data: report }, 200, env);
}

// ============================================
// Full Pipeline Handler
// ============================================

async function handleFullPipeline(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return errorResponse('GITHUB_TOKEN not configured', 500, env);
  }

  const body = await request.json().catch(() => ({})) as {
    maxDevelopers?: number;
    maxRepos?: number;
    maxSites?: number;
    deleteUnrated?: boolean;
  };

  const results: Record<string, unknown> = {};

  // Step 1: Discovery
  console.log('Starting discovery...');
  results.discovery = await runDiscoveryPipeline(env.DB, env.GITHUB_TOKEN, {
    maxDevelopers: body.maxDevelopers || 3,
  });

  // Step 2: Verification
  console.log('Starting verification...');
  results.verification = await runVerificationPipeline(env.DB, env.GITHUB_TOKEN, {
    maxRepos: body.maxRepos || 20,
    checkLiveUrl: true,
  });

  // Step 3: Queue sites for crawling
  console.log('Queueing sites...');
  const queued = await queuePendingSites(env.DB, body.maxSites || 5);
  results.queued = queued;

  // Step 4: Process queue (crawl sites)
  console.log('Processing crawl queue...');
  const crawlResults = [];
  for (let i = 0; i < queued; i++) {
    const result = await processNextInQueue(env.DB, env.BUCKET);
    if (!result.processed) break;
    crawlResults.push(result);
  }
  results.crawled = crawlResults;

  // Step 5: Extract and score blocks for completed sites
  console.log('Extracting and scoring blocks...');
  const sites = await getSites(env.DB, { status: 'complete', limit: body.maxSites || 5 });
  const extractionResults = [];

  for (const site of sites) {
    const extraction = await extractBlocksFromSite(env.DB, env.BUCKET, site.id);
    const scoring = await scoreBlocksForSite(env.DB, site.id, {
      deleteUnrated: body.deleteUnrated,
    });
    extractionResults.push({
      siteId: site.id,
      domain: site.domain,
      extraction,
      scoring,
    });
  }
  results.extraction = extractionResults;

  return jsonResponse({ success: true, data: results }, 200, env);
}

// Preview handler - shows page in iframe with highlight instructions
async function handlePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  const blockName = url.searchParams.get('block');

  if (!targetUrl) {
    return errorResponse('url parameter required', 400, env);
  }

  // Generate a preview page with iframe and inspect panel
  const previewPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Preview: ${blockName || 'block'}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; display: flex; flex-direction: column; height: 100vh; }
    .preview-header {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      color: white;
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
      border-bottom: 1px solid #334155;
      flex-shrink: 0;
    }
    .preview-header h1 { font-size: 0.95rem; font-weight: 600; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
    .preview-header h1 .block-name { color: #60a5fa; }
    .preview-actions { display: flex; gap: 8px; align-items: center; }
    .btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.8rem;
      text-decoration: none;
      cursor: pointer;
      border: none;
      font-weight: 500;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-success { background: #22c55e; color: white; }
    .btn-secondary { background: transparent; color: #94a3b8; border: 1px solid #334155; }
    .btn-secondary:hover { border-color: #60a5fa; color: #60a5fa; }
    .selector-box {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #334155;
      padding: 4px 4px 4px 12px;
      border-radius: 6px;
    }
    .selector-text {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.85rem;
      color: #f59e0b;
    }
    .copy-btn {
      background: #475569;
      border: none;
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: all 0.2s;
    }
    .copy-btn:hover { background: #3b82f6; }
    .copy-btn.copied { background: #22c55e; }
    .main-content { display: flex; flex: 1; overflow: hidden; }
    .preview-frame {
      flex: 1;
      border: none;
      background: white;
    }
    .inspect-panel {
      width: 280px;
      background: #1e293b;
      border-left: 1px solid #334155;
      padding: 20px;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .inspect-panel h2 { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 15px; }
    .inspect-step {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      align-items: flex-start;
    }
    .step-num {
      width: 24px;
      height: 24px;
      background: #3b82f6;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
      flex-shrink: 0;
    }
    .step-content { flex: 1; }
    .step-content strong { color: #f1f5f9; font-size: 0.85rem; display: block; margin-bottom: 4px; }
    .step-content p { color: #94a3b8; font-size: 0.8rem; line-height: 1.4; }
    .step-content code { background: #334155; padding: 2px 6px; border-radius: 3px; color: #f59e0b; font-size: 0.75rem; }
    .step-content kbd { background: #475569; padding: 2px 6px; border-radius: 3px; color: #f1f5f9; font-size: 0.7rem; font-family: inherit; }
    .bookmarklet-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #334155; }
    .bookmarklet-link {
      display: block;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #000;
      text-align: center;
      padding: 10px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.8rem;
      text-decoration: none;
      margin-top: 10px;
    }
    .bookmarklet-link:hover { opacity: 0.9; }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #22c55e;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: 500;
      opacity: 0;
      transition: all 0.3s;
      z-index: 1000;
    }
    .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  </style>
</head>
<body>
  <div class="preview-header">
    <h1>📦 <span class="block-name">${blockName || 'block'}</span></h1>
    <div class="preview-actions">
      <div class="selector-box">
        <span class="selector-text">.${blockName}</span>
        <button class="copy-btn" onclick="copySelector(this)">Copy</button>
      </div>
      <a href="${targetUrl}" target="_blank" class="btn btn-primary" onclick="copySelector()">Open & Inspect →</a>
    </div>
  </div>
  <div class="main-content">
    <iframe id="previewFrame" class="preview-frame" src="${targetUrl}" onload="tryHighlight()"></iframe>
    <div class="inspect-panel" id="inspectPanel" style="display: none;">
      <h2>How to Inspect</h2>
      <div class="inspect-step">
        <div class="step-num">1</div>
        <div class="step-content">
          <strong>Open the page</strong>
          <p>Click <kbd>Open & Inspect</kbd> above (selector auto-copied)</p>
        </div>
      </div>
      <div class="inspect-step">
        <div class="step-num">2</div>
        <div class="step-content">
          <strong>Open DevTools</strong>
          <p>Press <kbd>F12</kbd> or <kbd>⌘⌥I</kbd> (Mac)</p>
        </div>
      </div>
      <div class="inspect-step">
        <div class="step-num">3</div>
        <div class="step-content">
          <strong>Find the block</strong>
          <p>In Elements tab, press <kbd>⌘F</kbd> and paste <code>.${blockName}</code></p>
        </div>
      </div>
      <div class="inspect-step">
        <div class="step-num">4</div>
        <div class="step-content">
          <strong>Inspect styles</strong>
          <p>Click the element to see its CSS in the Styles panel</p>
        </div>
      </div>
      <div class="bookmarklet-section">
        <h2>Quick Highlight</h2>
        <p style="color: #94a3b8; font-size: 0.75rem; margin-bottom: 8px;">Drag this to your bookmarks bar, then click it on any EDS page:</p>
        <a class="bookmarklet-link" href="javascript:(function(){var n='${blockName}';var s=document.createElement('style');s.textContent='.eds-hl{outline:4px solid %233b82f6!important;outline-offset:4px!important;animation:eds-p 1s infinite!important}@keyframes eds-p{50%{outline-color:%2360a5fa}}';document.head.appendChild(s);var b=document.querySelectorAll('.'+n);if(!b.length)b=document.querySelectorAll('[class*='+n+']');b.forEach(function(e){e.classList.add('eds-hl')});if(b.length)b[0].scrollIntoView({behavior:'smooth',block:'center'});alert('Found '+b.length+' .'+n+' block(s)')})();">⚡ Highlight .${blockName}</a>
      </div>
    </div>
  </div>
  <div class="toast" id="toast">Selector copied!</div>
  <script>
    let highlightAttempted = false;

    function tryHighlight() {
      if (highlightAttempted) return;
      highlightAttempted = true;

      const iframe = document.getElementById('previewFrame');
      const blockName = ${JSON.stringify(blockName || '')};

      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

        // Add highlight styles
        const style = iframeDoc.createElement('style');
        style.id = 'eds-highlight-style';
        style.textContent = \`
          @keyframes eds-pulse {
            0%, 100% { outline-color: rgba(59, 130, 246, 1); }
            50% { outline-color: rgba(59, 130, 246, 0.4); }
          }
          .eds-block-highlight {
            outline: 4px solid #3b82f6 !important;
            outline-offset: 4px !important;
            animation: eds-pulse 1.5s ease-in-out infinite !important;
            position: relative !important;
          }
          .eds-block-highlight::before {
            content: '${blockName}' !important;
            position: absolute !important;
            top: -30px !important;
            left: 0 !important;
            background: #3b82f6 !important;
            color: white !important;
            padding: 4px 12px !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            border-radius: 4px !important;
            z-index: 10000 !important;
            font-family: -apple-system, sans-serif !important;
          }
        \`;
        iframeDoc.head.appendChild(style);

        // Find and highlight blocks
        let blocks = iframeDoc.querySelectorAll('.' + blockName);
        if (!blocks.length) blocks = iframeDoc.querySelectorAll('[class*="' + blockName + '"]');

        if (blocks.length > 0) {
          blocks.forEach(b => b.classList.add('eds-block-highlight'));
          setTimeout(() => {
            blocks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 300);
          showToast('Found ' + blocks.length + ' .' + blockName + ' block(s)');
        } else {
          showToast('No .' + blockName + ' blocks on this page', true);
          showFallbackPanel();
        }
      } catch (e) {
        // Cross-origin - show fallback panel
        showFallbackPanel();
      }
    }

    function showFallbackPanel() {
      document.getElementById('inspectPanel').style.display = 'block';
    }

    function copySelector(btn) {
      navigator.clipboard.writeText('.${blockName}');
      if (btn) {
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      }
      showToast('Selector copied!');
    }

    function showToast(msg, isWarning) {
      const toast = document.getElementById('toast');
      toast.textContent = msg || 'Selector copied!';
      toast.style.background = isWarning ? '#f59e0b' : '#22c55e';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }
  </script>
</body>
</html>`;

  return new Response(previewPage, {
    headers: {
      'Content-Type': 'text/html',
      ...corsHeaders(env),
    },
  });
}

// ============================================
// Cron Handler
// ============================================

async function handleCron(env: Env): Promise<void> {
  const now = new Date();
  const isWeeklyRun = now.getUTCDay() === 0 && now.getUTCHours() === 2; // Sunday 2AM UTC

  console.log(`Starting cron job (${isWeeklyRun ? 'weekly' : 'hourly'})...`);

  try {
    // Weekly: Run discovery for new sites (requires GITHUB_TOKEN)
    if (isWeeklyRun && env.GITHUB_TOKEN) {
      console.log('Running weekly discovery...');
      await runDiscoveryPipeline(env.DB, env.GITHUB_TOKEN, {
        maxDevelopers: 20,
        maxContributorsPerRepo: 50,
      });

      console.log('Running verification...');
      await runVerificationPipeline(env.DB, env.GITHUB_TOKEN, {
        maxRepos: 50,
        checkLiveUrl: true,
      });
    }

    // Queue all pending sites
    console.log('Queueing pending sites...');
    const queued = await queuePendingSites(env.DB, 500);
    console.log(`Queued ${queued} sites`);

    // Process sites from queue (crawl + extract + score)
    // Process up to 10 sites per hourly run to stay within time limits
    const maxSitesPerRun = 10;
    let processed = 0;

    console.log('Processing queue...');
    for (let i = 0; i < maxSitesPerRun; i++) {
      const result = await processNextInQueue(env.DB, env.BUCKET);
      if (!result.processed) {
        console.log('Queue empty');
        break;
      }

      // Extract blocks immediately after crawling
      if (result.result?.siteId) {
        console.log(`Extracting blocks for ${result.result.domain}...`);
        await extractBlocksFromSite(env.DB, env.BUCKET, result.result.siteId);
        await scoreBlocksForSite(env.DB, result.result.siteId, { deleteUnrated: false });
      }

      processed++;
      console.log(`Processed ${processed}/${maxSitesPerRun}: ${result.result?.domain}`);
    }

    console.log(`Cron job completed. Processed ${processed} sites.`);
  } catch (e) {
    console.error('Cron job failed:', e);
  }
}

// ============================================
// Router
// ============================================

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  try {
    // Health
    if (path === '/health' && method === 'GET') {
      return handleHealth(env);
    }

    // Stats
    if (path === '/stats' && method === 'GET') {
      return handleStats(env);
    }

    // Discovery
    if (path === '/discovery/run' && method === 'POST') {
      return handleDiscoveryRun(request, env);
    }
    if (path === '/discovery/verify' && method === 'POST') {
      return handleVerificationRun(request, env);
    }
    if (path === '/discovery/urls' && method === 'POST') {
      return handleDiscoverUrls(env);
    }
    if (path === '/discovery/scan-org' && method === 'POST') {
      return handleScanOrg(request, env);
    }
    if (path === '/discovery/contributors' && method === 'GET') {
      return handleListContributors(request, env);
    }

    // Repositories
    if (path === '/repositories' && method === 'GET') {
      return handleListRepositories(request, env);
    }

    // Sites
    if (path === '/sites' && method === 'GET') {
      return handleListSites(request, env);
    }
    if (path === '/sites' && method === 'POST') {
      return handleCreateSite(request, env);
    }
    if (path.match(/^\/sites\/[\w-]+$/) && method === 'GET') {
      const siteId = path.split('/')[2];
      return handleGetSite(siteId, env);
    }

    // Crawler
    if (path === '/crawler/crawl' && method === 'POST') {
      return handleCrawlSite(request, env);
    }
    if (path === '/crawler/queue' && method === 'POST') {
      return handleQueueSite(request, env);
    }
    if (path === '/crawler/queue-pending' && method === 'POST') {
      return handleQueuePending(request, env);
    }
    if (path === '/crawler/process' && method === 'POST') {
      return handleProcessQueue(env);
    }
    if (path === '/crawler/stats' && method === 'GET') {
      return handleQueueStats(env);
    }
    if (path === '/crawler/test-fetch' && method === 'POST') {
      return handleTestFetch(request, env);
    }

    // Extraction
    if (path === '/extractor/blocks' && method === 'POST') {
      return handleExtractBlocks(request, env);
    }
    if (path === '/extractor/design-system' && method === 'POST') {
      return handleExtractDesignSystem(request, env);
    }

    // Blocks
    if (path === '/blocks' && method === 'GET') {
      return handleListBlocks(request, env);
    }

    // Chat
    if (path === '/api/chat' && method === 'POST') {
      return handleChatRequest(request, env);
    }

    // Quality
    if (path === '/quality/score' && method === 'POST') {
      return handleScoreBlocks(request, env);
    }
    if (path.match(/^\/quality\/report\/[\w-]+$/) && method === 'GET') {
      const siteId = path.split('/')[3];
      return handleQualityReport(siteId, env);
    }

    // Full pipeline
    if (path === '/pipeline/run' && method === 'POST') {
      return handleFullPipeline(request, env);
    }

    // Preview page with block highlighting
    if (path === '/preview' && method === 'GET') {
      return handlePreview(request, env);
    }

    // Home page / documentation
    if (path === '/' && method === 'GET') {
      return new Response(getHomePage(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders(env) },
      });
    }

    return errorResponse('Not found', 404, env);
  } catch (e) {
    console.error('Request error:', e);
    return errorResponse(e instanceof Error ? e.message : 'Internal server error', 500, env);
  }
}

// ============================================
// Home Page
// ============================================

function getHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EDS Block Collection Database</title>
  <style>
    :root {
      --gold: #f59e0b;
      --silver: #6b7280;
      --bronze: #b45309;
      --unrated: #dc2626;
      --bg: #0f172a;
      --bg-card: #1e293b;
      --bg-hover: #334155;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #334155;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; transition: all 0.3s ease; }
    body.chat-open .container { max-width: none; margin-right: 440px; margin-left: 20px; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 30px; }
    header h1 { font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
    header h1 span { font-size: 2rem; }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border); }
    .stat-card .label { color: var(--text-muted); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 2.5rem; font-weight: 700; margin-top: 5px; }
    .stat-card .subtitle { color: var(--text-muted); font-size: 0.875rem; }
    .dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
    @media (max-width: 900px) { .dashboard-grid { grid-template-columns: 1fr; } }
    .card { background: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border); }
    .card h2 { font-size: 1rem; color: var(--text-muted); margin-bottom: 20px; text-transform: uppercase; letter-spacing: 0.05em; }
    .tier-bars { display: flex; flex-direction: column; gap: 12px; }
    .tier-bar { display: grid; grid-template-columns: 80px 1fr 60px; align-items: center; gap: 15px; }
    .tier-bar .name { font-weight: 600; text-transform: uppercase; font-size: 0.875rem; }
    .tier-bar .bar-container { height: 24px; background: var(--bg); border-radius: 4px; overflow: hidden; }
    .tier-bar .bar { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
    .tier-bar .count { text-align: right; font-weight: 600; }
    .tier-bar.gold .name { color: var(--gold); } .tier-bar.gold .bar { background: var(--gold); }
    .tier-bar.silver .name { color: var(--silver); } .tier-bar.silver .bar { background: var(--silver); }
    .tier-bar.bronze .name { color: var(--bronze); } .tier-bar.bronze .bar { background: var(--bronze); }
    .tier-bar.unrated .name { color: var(--unrated); } .tier-bar.unrated .bar { background: var(--unrated); }
    .block-types { display: flex; flex-wrap: wrap; gap: 8px; }
    .block-type-chip { background: var(--bg); padding: 6px 12px; border-radius: 20px; font-size: 0.875rem; cursor: pointer; transition: all 0.2s; border: 1px solid var(--border); }
    .block-type-chip:hover { background: var(--bg-hover); border-color: var(--accent); }
    .block-type-chip .count { background: var(--accent); color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; margin-left: 6px; }
    .tabs { display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    .tab { padding: 10px 20px; background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 1rem; border-radius: 8px 8px 0 0; transition: all 0.2s; }
    .tab:hover { color: var(--text); background: var(--bg-hover); }
    .tab.active { color: var(--accent); background: var(--bg-card); font-weight: 600; }
    .filters { display: flex; gap: 15px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .filter-group { display: flex; gap: 5px; }
    .filter-btn { padding: 8px 16px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text); border-radius: 20px; cursor: pointer; font-size: 0.875rem; transition: all 0.2s; }
    .filter-btn:hover { border-color: var(--accent); }
    .filter-btn.active { background: var(--accent); border-color: var(--accent); }
    .search-input { padding: 10px 16px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text); border-radius: 8px; font-size: 0.875rem; width: 250px; }
    .search-input::placeholder { color: var(--text-muted); }
    .search-input:focus { outline: none; border-color: var(--accent); }
    .blocks-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
    .block-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border); overflow: hidden; cursor: pointer; transition: all 0.2s; }
    .block-card:hover { border-color: var(--accent); transform: translateY(-2px); }
    .block-card-header { padding: 15px; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border); }
    .block-card-header h3 { font-size: 1rem; font-weight: 600; }
    .block-card-header .site { color: var(--text-muted); font-size: 0.75rem; margin-top: 4px; }
    .tier-badge { padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .tier-badge.gold { background: var(--gold); color: #000; }
    .tier-badge.silver { background: var(--silver); color: #fff; }
    .tier-badge.bronze { background: var(--bronze); color: #fff; }
    .tier-badge.unrated { background: var(--unrated); color: #fff; }
    .block-card-preview { padding: 15px; background: var(--bg); font-family: 'Monaco', 'Menlo', monospace; font-size: 0.7rem; color: var(--text-muted); height: 100px; overflow: hidden; position: relative; }
    .block-card-desc { padding: 12px 15px; font-size: 0.85rem; color: var(--text-muted); border-bottom: 1px solid var(--border); line-height: 1.4; }
    .block-card-preview::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, var(--bg)); }
    .block-card-scores { padding: 15px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .mini-score { text-align: center; }
    .mini-score .value { font-size: 1.25rem; font-weight: 700; }
    .mini-score .label { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000; opacity: 0; visibility: hidden; transition: all 0.3s; }
    .modal-overlay.active { opacity: 1; visibility: visible; }
    .modal { background: var(--bg-card); border-radius: 16px; width: 90%; max-width: 900px; max-height: 90vh; overflow: hidden; display: flex; flex-direction: column; }
    .modal-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .modal-header h2 { font-size: 1.25rem; }
    .modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 1.5rem; cursor: pointer; padding: 5px; }
    .modal-close:hover { color: var(--text); }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
    .score-breakdown { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px; }
    @media (max-width: 600px) { .score-breakdown { grid-template-columns: repeat(2, 1fr); } }
    .score-item { background: var(--bg); padding: 15px; border-radius: 8px; text-align: center; }
    .score-item .score { font-size: 2rem; font-weight: 700; }
    .score-item .score.high { color: #22c55e; }
    .score-item .score.mid { color: var(--gold); }
    .score-item .score.low { color: var(--unrated); }
    .score-item .name { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 5px; }
    .html-preview { background: var(--bg); border-radius: 8px; padding: 20px; font-family: 'Monaco', 'Menlo', monospace; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
    .html-preview .tag { color: #f472b6; }
    .html-preview .attr { color: #a78bfa; }
    .html-preview .string { color: #4ade80; }
    .sites-list { display: flex; flex-direction: column; gap: 10px; }
    .site-row { display: grid; grid-template-columns: 1fr 100px 100px 120px; gap: 15px; padding: 15px; background: var(--bg-card); border-radius: 8px; border: 1px solid var(--border); align-items: center; cursor: pointer; transition: all 0.2s; }
    .site-row:hover { border-color: var(--accent); }
    .site-row .domain { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .site-row .meta { color: var(--text-muted); font-size: 0.875rem; text-align: center; }
    .loading { text-align: center; padding: 40px; color: var(--text-muted); }
    .loading-spinner { width: 40px; height: 40px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .empty-state h3 { margin-bottom: 10px; color: var(--text); }
    .preview-link, .direct-link { text-decoration: none; font-size: 0.875rem; padding: 6px 12px; border-radius: 6px; transition: all 0.2s; }
    .preview-link { background: var(--accent); color: white !important; }
    .preview-link:hover { background: #2563eb; }
    .direct-link { color: var(--text-muted) !important; border: 1px solid var(--border); }
    .direct-link:hover { border-color: var(--accent); color: var(--accent) !important; }
    /* Chat Sidebar Styles */
    .chat-toggle { position: fixed; top: 80px; right: 0; padding: 12px 16px 12px 20px; border-radius: 24px 0 0 24px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border: none; cursor: pointer; box-shadow: -2px 2px 12px rgba(59, 130, 246, 0.4); z-index: 999; display: flex; align-items: center; gap: 8px; transition: all 0.3s; color: white; font-weight: 600; font-size: 0.9rem; }
    .chat-toggle:hover { padding-right: 24px; box-shadow: -4px 4px 20px rgba(59, 130, 246, 0.5); }
    .chat-toggle svg { width: 20px; height: 20px; fill: white; }
    .chat-toggle.active { opacity: 0; pointer-events: none; }
    .chat-sidebar { position: fixed; top: 0; right: -420px; width: 420px; height: 100vh; background: var(--bg-card); border-left: 1px solid var(--border); display: flex; flex-direction: column; z-index: 1001; transition: right 0.3s ease; box-shadow: -4px 0 20px rgba(0,0,0,0.3); }
    .chat-sidebar.open { right: 0; }
    .chat-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg); }
    .chat-header h3 { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .chat-header h3::before { content: '🤖'; }
    .chat-close { background: transparent; border: none; color: var(--text-muted); font-size: 1.5rem; cursor: pointer; padding: 4px 8px; border-radius: 4px; line-height: 1; }
    .chat-close:hover { background: var(--bg-hover); color: var(--text); }
    .chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .chat-message { max-width: 90%; padding: 12px 16px; border-radius: 16px; font-size: 0.9rem; line-height: 1.5; }
    .chat-message.user { align-self: flex-end; background: var(--accent); color: white; border-bottom-right-radius: 4px; }
    .chat-message.assistant { align-self: flex-start; background: var(--bg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .chat-message .message-text { white-space: pre-wrap; }
    .chat-block-suggestions { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .chat-block-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; }
    .chat-block-card:hover { border-color: var(--accent); background: var(--bg-hover); }
    .chat-block-card .block-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .chat-block-card .block-name { font-weight: 600; font-size: 0.9rem; }
    .chat-block-card .match-reason { font-size: 0.8rem; color: var(--text-muted); }
    .quick-replies { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .quick-reply-btn { padding: 8px 16px; background: transparent; border: 1px solid var(--accent); color: var(--accent); border-radius: 20px; font-size: 0.85rem; cursor: pointer; transition: all 0.2s; font-family: inherit; }
    .quick-reply-btn:hover { background: var(--accent); color: white; }
    .chat-input-container { padding: 16px; border-top: 1px solid var(--border); display: flex; gap: 8px; background: var(--bg); }
    .chat-input { flex: 1; padding: 12px 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; color: var(--text); resize: none; font-family: inherit; font-size: 0.9rem; max-height: 120px; }
    .chat-input:focus { outline: none; border-color: var(--accent); }
    .chat-input::placeholder { color: var(--text-muted); }
    .chat-send { width: 44px; height: 44px; border-radius: 12px; background: var(--accent); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; }
    .chat-send:hover { background: #2563eb; }
    .chat-send:disabled { background: var(--border); cursor: not-allowed; }
    .chat-send svg { width: 20px; height: 20px; fill: white; }
    .typing-indicator { display: flex; gap: 4px; padding: 12px 16px; align-self: flex-start; background: var(--bg); border: 1px solid var(--border); border-radius: 16px; border-bottom-left-radius: 4px; }
    .typing-indicator span { width: 8px; height: 8px; background: var(--text-muted); border-radius: 50%; animation: typing 1.4s infinite; }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-8px); opacity: 1; } }
    @media (max-width: 500px) { .chat-sidebar { width: 100%; right: -100%; } }
  </style>
</head>
<body class="chat-open">
  <div class="container">
    <header>
      <h1><span>&#x1F9F1;</span> EDS Block Collection</h1>
      <div id="lastUpdated" style="color: var(--text-muted); font-size: 0.875rem;"></div>
    </header>
    <div class="stats-row" id="statsRow">
      <div class="stat-card"><div class="label">Total Blocks</div><div class="value" id="totalBlocks">-</div><div class="subtitle">Collected from EDS sites</div></div>
      <div class="stat-card"><div class="label">Sites Crawled</div><div class="value" id="totalSites">-</div><div class="subtitle">Active EDS projects</div></div>
      <div class="stat-card"><div class="label">Avg Quality</div><div class="value" id="avgScore">-</div><div class="subtitle">Weighted score</div></div>
      <div class="stat-card"><div class="label">Block Types</div><div class="value" id="blockTypes">-</div><div class="subtitle">Unique patterns</div></div>
    </div>
    <div class="dashboard-grid">
      <div class="card">
        <h2>Quality Distribution</h2>
        <div class="tier-bars" id="tierBars">
          <div class="tier-bar gold"><span class="name">Gold</span><div class="bar-container"><div class="bar" style="width: 0%"></div></div><span class="count">0</span></div>
          <div class="tier-bar silver"><span class="name">Silver</span><div class="bar-container"><div class="bar" style="width: 0%"></div></div><span class="count">0</span></div>
          <div class="tier-bar bronze"><span class="name">Bronze</span><div class="bar-container"><div class="bar" style="width: 0%"></div></div><span class="count">0</span></div>
          <div class="tier-bar unrated"><span class="name">Low Quality</span><div class="bar-container"><div class="bar" style="width: 0%"></div></div><span class="count">0</span></div>
        </div>
      </div>
      <div class="card"><h2>Top Block Types</h2><div class="block-types" id="blockTypesChart"></div></div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="blocks">Blocks</button>
      <button class="tab" data-tab="sites">Sites</button>
    </div>
    <div id="blocksTab">
      <div class="filters">
        <div class="filter-group">
          <button class="filter-btn active" data-tier="all">All</button>
          <button class="filter-btn" data-tier="gold">Gold</button>
          <button class="filter-btn" data-tier="silver">Silver</button>
          <button class="filter-btn" data-tier="bronze">Bronze</button>
        </div>
        <input type="text" class="search-input" id="blockSearch" placeholder="Search blocks...">
      </div>
      <div class="blocks-grid" id="blocksGrid"><div class="loading"><div class="loading-spinner"></div>Loading blocks...</div></div>
    </div>
    <div id="sitesTab" style="display: none;"><div class="sites-list" id="sitesList"><div class="loading"><div class="loading-spinner"></div>Loading sites...</div></div></div>
  </div>
  <div class="modal-overlay" id="blockModal">
    <div class="modal">
      <div class="modal-header"><h2 id="modalTitle">Block Details</h2><button class="modal-close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>
  <!-- Chat Toggle Button -->
  <button class="chat-toggle active" id="chatToggle" onclick="toggleChat()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
    <span>Block Assistant</span>
  </button>
  <!-- Chat Sidebar -->
  <div class="chat-sidebar open" id="chatSidebar">
    <div class="chat-header">
      <h3>Block Assistant</h3>
      <button class="chat-close" onclick="toggleChat()">&times;</button>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-message assistant">
        <div class="message-text">Hi! I can help you find the perfect EDS block for your project. Describe what you need, like "a hero section with background image and CTA button" or "navigation with dropdown menus".</div>
      </div>
    </div>
    <div class="chat-input-container">
      <textarea class="chat-input" id="chatInput" placeholder="Describe the block you need..." rows="1" onkeydown="handleChatKeydown(event)"></textarea>
      <button class="chat-send" id="chatSend" onclick="sendChatMessage()">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>
      </button>
    </div>
  </div>
  <script>
    const API_BASE = location.origin;
    let allBlocks = [], allSites = [], realStats = null, currentTierFilter = 'all', currentSearch = '';
    async function init() { await Promise.all([loadBlocks(), loadSites(), loadStats()]); setupEventListeners(); updateStats(); }
    async function loadBlocks() { try { const res = await fetch(API_BASE + '/blocks?limit=1000'); const data = await res.json(); allBlocks = data.data || []; renderBlocks(); } catch (e) { document.getElementById('blocksGrid').innerHTML = '<div class="empty-state"><h3>Failed to load blocks</h3></div>'; } }
    async function loadSites() { try { const res = await fetch(API_BASE + '/sites?limit=500'); const data = await res.json(); allSites = data.data || []; renderSites(); } catch (e) { console.error('Failed to load sites:', e); } }
    async function loadStats() { try { const res = await fetch(API_BASE + '/stats'); const data = await res.json(); realStats = data.data || null; } catch (e) { console.error('Failed to load stats:', e); } }
    function updateStats() {
      const stats = realStats;
      document.getElementById('totalBlocks').textContent = stats ? stats.blocks.total : allBlocks.length;
      document.getElementById('totalSites').textContent = stats ? stats.crawl.sites_total : allSites.length;
      document.getElementById('avgScore').textContent = stats ? Math.round(stats.blocks.average_quality) : 0;
      const tiers = stats ? stats.blocks.by_tier : { gold: 0, silver: 0, bronze: 0, unrated: 0 };
      if (!stats) allBlocks.forEach(b => { tiers[b.quality_tier || 'unrated']++; });
      document.getElementById('blockTypes').textContent = stats ? Object.keys(stats.blocks.by_name).length : new Set(allBlocks.map(b => b.block_name)).size;
      const maxTier = Math.max(...Object.values(tiers));
      Object.entries(tiers).forEach(([tier, count]) => {
        const bar = document.querySelector('.tier-bar.' + tier + ' .bar');
        const countEl = document.querySelector('.tier-bar.' + tier + ' .count');
        if (bar) bar.style.width = (count / maxTier * 100) + '%';
        if (countEl) countEl.textContent = count;
      });
      const typeCounts = stats ? stats.blocks.by_name : {};
      if (!stats) allBlocks.forEach(b => { typeCounts[b.block_name] = (typeCounts[b.block_name] || 0) + 1; });
      document.getElementById('blockTypesChart').innerHTML = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => '<div class="block-type-chip" onclick="filterByType(\\'' + name + '\\')">' + name + '<span class="count">' + count + '</span></div>').join('');
      document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleString();
    }
    function renderBlocks() {
      let filtered = allBlocks;
      if (currentTierFilter !== 'all') filtered = filtered.filter(b => b.quality_tier === currentTierFilter);
      if (currentSearch) { const s = currentSearch.toLowerCase(); filtered = filtered.filter(b => b.block_name.toLowerCase().includes(s) || (b.html || '').toLowerCase().includes(s) || (b.description || '').toLowerCase().includes(s)); }
      if (!filtered.length) { document.getElementById('blocksGrid').innerHTML = '<div class="empty-state"><h3>No blocks found</h3></div>'; return; }
      document.getElementById('blocksGrid').innerHTML = filtered.map(block => {
        const bd = block.quality_breakdown || {};
        const site = allSites.find(s => s.id === block.site_id);
        const domain = site ? site.domain.split('--')[1] || site.domain : 'Unknown';
        const desc = block.description || 'A ' + block.block_name + ' block.';
        return '<div class="block-card" onclick="showBlockDetail(\\'' + block.id + '\\')"><div class="block-card-header"><div><h3>' + block.block_name + '</h3><div class="site">' + domain + '</div></div><span class="tier-badge ' + (block.quality_tier || 'unrated') + '">' + (block.quality_score || '-') + '</span></div><div class="block-card-desc">' + desc + '</div><div class="block-card-scores"><div class="mini-score"><div class="value">' + (bd.performance || '-') + '</div><div class="label">Perf</div></div><div class="mini-score"><div class="value">' + (bd.accessibility || '-') + '</div><div class="label">A11y</div></div><div class="mini-score"><div class="value">' + (bd.edsCompliance || '-') + '</div><div class="label">EDS</div></div></div></div>';
      }).join('');
    }
    function renderSites() {
      const sorted = [...allSites].sort((a, b) => (b.block_count || 0) - (a.block_count || 0));
      document.getElementById('sitesList').innerHTML = '<div class="site-row" style="background:transparent;border:none;font-weight:600;color:var(--text-muted);"><span>Domain</span><span class="meta">Blocks</span><span class="meta">Pages</span><span class="meta">Status</span></div>' + sorted.map(site => '<div class="site-row" onclick="filterBySite(\\'' + site.id + '\\')"><span class="domain" title="' + site.domain + '">' + site.domain.replace('.aem.live', '') + '</span><span class="meta">' + (site.block_count || 0) + '</span><span class="meta">' + (site.page_count || 0) + '</span><span class="meta">' + (site.crawl_status || 'unknown') + '</span></div>').join('');
    }
    function showBlockDetail(blockId) {
      const block = allBlocks.find(b => b.id === blockId); if (!block) return;
      const bd = block.quality_breakdown || {};
      const site = allSites.find(s => s.id === block.site_id);
      const pageUrl = block.page_url || (site ? 'https://' + site.domain + '/' : null);
      const desc = block.description || 'A ' + block.block_name + ' block implementation.';
      document.getElementById('modalTitle').textContent = block.block_name;
      var previewUrl = pageUrl ? API_BASE + '/preview?url=' + encodeURIComponent(pageUrl) + '&block=' + encodeURIComponent(block.block_name) : null;
      document.getElementById('modalBody').innerHTML = '<div style="display:flex;gap:15px;align-items:center;flex-wrap:wrap;margin-bottom:15px;"><span class="tier-badge ' + block.quality_tier + '" style="font-size:1rem;padding:8px 16px;">' + ((block.quality_tier || 'unrated').toUpperCase()) + ' - ' + (block.quality_score || 0) + '</span>' + (previewUrl ? '<a href="' + previewUrl + '" target="_blank" class="preview-link">View with Highlight &rarr;</a><a href="' + pageUrl + '" target="_blank" class="direct-link">Direct Link</a>' : '') + '</div><p style="color:var(--text);margin-bottom:20px;font-size:1rem;line-height:1.6;">' + desc + '</p><div class="score-breakdown">' + renderScoreItem('Performance', bd.performance) + renderScoreItem('Accessibility', bd.accessibility) + renderScoreItem('Semantic HTML', bd.semanticHtml) + renderScoreItem('Code Quality', bd.codeQuality) + renderScoreItem('Responsive', bd.responsive) + renderScoreItem('EDS Compliance', bd.edsCompliance) + '</div><h3 style="margin-bottom:15px;color:var(--text-muted);font-size:0.875rem;text-transform:uppercase;">HTML Structure</h3><div class="html-preview">' + highlightHtml(block.html || 'No HTML') + '</div>';
      document.getElementById('blockModal').classList.add('active');
    }
    function renderScoreItem(name, score) { return '<div class="score-item"><div class="score ' + (score >= 85 ? 'high' : score >= 70 ? 'mid' : 'low') + '">' + (score || '-') + '</div><div class="name">' + name + '</div></div>'; }
    function closeModal() { document.getElementById('blockModal').classList.remove('active'); }
    function filterByType(type) { currentSearch = type; document.getElementById('blockSearch').value = type; renderBlocks(); }
    function filterBySite(siteId) { document.querySelector('.tab[data-tab="blocks"]').click(); const site = allSites.find(s => s.id === siteId); if (site) { currentSearch = site.domain.split('--')[1] || site.domain; document.getElementById('blockSearch').value = currentSearch; renderBlocks(); } }
    function setupEventListeners() {
      document.querySelectorAll('.tab').forEach(tab => { tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); document.getElementById('blocksTab').style.display = tab.dataset.tab === 'blocks' ? 'block' : 'none'; document.getElementById('sitesTab').style.display = tab.dataset.tab === 'sites' ? 'block' : 'none'; }); });
      document.querySelectorAll('.filter-btn[data-tier]').forEach(btn => { btn.addEventListener('click', () => { document.querySelectorAll('.filter-btn[data-tier]').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentTierFilter = btn.dataset.tier; renderBlocks(); }); });
      document.getElementById('blockSearch').addEventListener('input', (e) => { currentSearch = e.target.value; renderBlocks(); });
      document.getElementById('blockModal').addEventListener('click', (e) => { if (e.target.id === 'blockModal') closeModal(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    }
    function escapeHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function highlightHtml(html) { return escapeHtml(html).replace(/(&lt;\\/?[\\w-]+)/g, '<span class="tag">$1</span>').replace(/([\\w-]+)=/g, '<span class="attr">$1</span>=').replace(/"([^"]*)"/g, '"<span class="string">$1</span>"'); }

    // Chat functionality
    let chatOpen = true;
    let chatMessages = [];
    let chatSessionId = null;
    let chatLoading = false;

    function toggleChat() {
      chatOpen = !chatOpen;
      document.getElementById('chatSidebar').classList.toggle('open', chatOpen);
      document.getElementById('chatToggle').classList.toggle('active', chatOpen);
      document.body.classList.toggle('chat-open', chatOpen);
      if (chatOpen) {
        document.getElementById('chatInput').focus();
      }
    }

    function handleChatKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    }

    async function sendChatMessage() {
      const input = document.getElementById('chatInput');
      const message = input.value.trim();
      if (!message || chatLoading) return;

      // Add user message to UI
      addChatMessage('user', message);
      input.value = '';

      // Add to history
      chatMessages.push({ role: 'user', content: message });

      // Show typing indicator
      chatLoading = true;
      document.getElementById('chatSend').disabled = true;
      showTypingIndicator();

      try {
        const response = await fetch(API_BASE + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: chatMessages,
            sessionId: chatSessionId,
          }),
        });

        const data = await response.json();
        hideTypingIndicator();

        if (data.success) {
          chatSessionId = data.sessionId;
          // Only show quick replies with the last message (follow-up if exists, otherwise main)
          const hasFollowUp = data.followUpQuestion;
          addChatMessage('assistant', data.message, data.suggestedBlocks, hasFollowUp ? null : data.quickReplies);
          chatMessages.push({ role: 'assistant', content: data.message });

          if (hasFollowUp) {
            setTimeout(() => {
              addChatMessage('assistant', data.followUpQuestion, null, data.quickReplies);
              chatMessages.push({ role: 'assistant', content: data.followUpQuestion });
            }, 500);
          }
        } else {
          addChatMessage('assistant', data.message || 'Sorry, I encountered an error. Please try again.');
        }
      } catch (e) {
        hideTypingIndicator();
        addChatMessage('assistant', 'Connection error. Please check your network and try again.');
      }

      chatLoading = false;
      document.getElementById('chatSend').disabled = false;
    }

    function addChatMessage(role, content, suggestedBlocks, quickReplies) {
      const container = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.className = 'chat-message ' + role;

      let html = '<div class="message-text">' + escapeHtml(content) + '</div>';

      if (suggestedBlocks && suggestedBlocks.length > 0) {
        html += '<div class="chat-block-suggestions">';
        suggestedBlocks.forEach(block => {
          html += '<div class="chat-block-card" onclick="viewBlockFromChat(\\'' + block.id + '\\')">' +
            '<div class="block-header">' +
            '<span class="block-name">' + escapeHtml(block.blockName) + '</span>' +
            '<span class="tier-badge ' + block.qualityTier + '">' + block.qualityScore + '</span>' +
            '</div>' +
            '<div class="match-reason">' + escapeHtml(block.matchReason) + '</div>' +
            '</div>';
        });
        html += '</div>';
      }

      if (quickReplies && quickReplies.length > 0) {
        html += '<div class="quick-replies">';
        quickReplies.forEach(reply => {
          html += '<button class="quick-reply-btn" onclick="sendQuickReply(\\'' + escapeHtml(reply).replace(/'/g, "\\\\'") + '\\')">' + escapeHtml(reply) + '</button>';
        });
        html += '</div>';
      }

      div.innerHTML = html;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function sendQuickReply(text) {
      // Remove any existing quick reply buttons to avoid re-clicking
      document.querySelectorAll('.quick-replies').forEach(el => el.remove());
      // Set the input and send
      document.getElementById('chatInput').value = text;
      sendChatMessage();
    }

    function viewBlockFromChat(blockId) {
      showBlockDetail(blockId);
    }

    function showTypingIndicator() {
      const container = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.id = 'typingIndicator';
      div.className = 'typing-indicator';
      div.innerHTML = '<span></span><span></span><span></span>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function hideTypingIndicator() {
      const indicator = document.getElementById('typingIndicator');
      if (indicator) indicator.remove();
    }

    init();
  </script>
</body>
</html>`;
}

// ============================================
// Worker Export
// ============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
