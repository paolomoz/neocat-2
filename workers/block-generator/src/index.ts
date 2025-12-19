import {
  BlockRequest,
  BlockResponse,
  ErrorResponse,
  BlockGeneratorError,
  Env,
} from './types';
import { fetchPage } from './fetcher';
import { parseHTMLDocument, getElement } from './parser';
import { extractContent } from './content-extractor';
import { buildBlock } from './block-builder';
import { captureElementScreenshot } from './screenshot';
import { analyzeDesign, generateBlockCode, DesignTokens, AnthropicConfig, GeneratedBlockCode } from './design-analyzer';
import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(env);
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', version: '1.0.0' });
    }

    // Test UI endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      return handleTestUI(env);
    }

    // Batch generation UI
    if (url.pathname === '/batch' && request.method === 'GET') {
      return handleBatchUI(env);
    }

    // Main generation endpoint (JSON response)
    if (url.pathname === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    // Preview endpoint (HTML page for browser)
    if (url.pathname === '/preview' && request.method === 'POST') {
      return handlePreview(request, env);
    }

    // 404 for unknown routes
    return Response.json(
      { success: false, error: 'Not found', code: 'NOT_FOUND' },
      { status: 404, headers: corsHeaders(env) }
    );
  },
};

/**
 * Build Anthropic config from environment
 */
function getAnthropicConfig(env: Env): AnthropicConfig | undefined {
  // Check for Bedrock config
  if (env.ANTHROPIC_USE_BEDROCK === '1' && env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK) {
    return {
      useBedrock: true,
      bedrockToken: env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK,
      bedrockRegion: env.ANTHROPIC_AWS_REGION || 'us-east-1',
      bedrockModel: env.ANTHROPIC_MODEL,
    };
  }

  // Check for direct Anthropic API key
  if (env.ANTHROPIC_API_KEY) {
    return {
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }

  return undefined;
}

/**
 * Capture screenshot and analyze design using Claude Vision (legacy - extracts tokens only)
 */
async function analyzeDesignFromScreenshot(
  url: string,
  selector: string,
  env: Env
): Promise<DesignTokens | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const { screenshot } = await captureElementScreenshot(browser, url, selector);
      const designTokens = await analyzeDesign(screenshot, anthropicConfig);
      return designTokens;
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Design analysis failed:', error);
    return undefined;
  }
}

/**
 * Capture screenshot and generate complete block code using Claude Vision
 * Includes retry logic for Browser Rendering rate limits
 */
async function generateBlockFromScreenshot(
  url: string,
  selector: string,
  extracted: ReturnType<typeof extractContent>,
  env: Env,
  maxRetries: number = 3
): Promise<GeneratedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const { screenshot } = await captureElementScreenshot(browser, url, selector);
        const generatedBlock = await generateBlockCode(screenshot, extracted, anthropicConfig);
        return generatedBlock;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      // Check if it's a rate limit error (429)
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`Browser rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For other errors, don't retry
      console.error('Block code generation failed:', error);
      return undefined;
    }
  }

  console.error('Block code generation failed after retries:', lastError);
  return undefined;
}

/**
 * Handles the block generation request
 */
async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    // Parse and validate request body
    const body = await parseRequestBody(request);

    // Step 1: Fetch the page
    const html = await fetchPage(body.url);

    // Step 2: Parse HTML and extract element
    const document = parseHTMLDocument(html);
    const element = getElement(document, body.selector);

    // Step 3: Extract structured content (handles nested structures)
    const extracted = extractContent(element.outerHTML, body.url);

    // Step 4: Try to generate complete block using Claude Vision
    const generatedBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);

    let blockName: string;
    let blockHtml: string;
    let blockJs: string;
    let blockCss: string;

    if (generatedBlock) {
      // Use Claude-generated code
      blockName = generatedBlock.blockName;
      blockHtml = generatedBlock.html;
      blockJs = generatedBlock.js;
      blockCss = generatedBlock.css;
    } else {
      // Fall back to template-based generation
      const block = buildBlock(extracted);
      blockName = block.blockName;
      blockHtml = block.html;
      blockJs = block.js;
      blockCss = block.css;
    }

    // Build response
    const response: BlockResponse = {
      success: true,
      blockName,
      layoutPattern: extracted.type,
      html: blockHtml,
      js: blockJs,
      css: blockCss,
      metadata: {
        elementCount: extracted.columns.length,
        hasImages: extracted.columns.some(c => !!c.image),
        hasHeadings: extracted.columns.some(c => !!c.heading),
        hasLinks: extracted.columns.some(c => !!c.cta),
        rowCount: extracted.columns.length,
        columnCount: extracted.styles.columnCount,
      },
    };

    return Response.json(response, {
      status: 200,
      headers: corsHeaders(env),
    });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles the preview request - returns a full HTML page
 */
async function handlePreview(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseRequestBody(request);
    const html = await fetchPage(body.url);
    const document = parseHTMLDocument(html);
    const element = getElement(document, body.selector);

    // Extract content from DOM
    const extracted = extractContent(element.outerHTML, body.url);

    // Try to generate complete block using Claude Vision
    const generatedBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);

    let blockName: string;
    let blockHTML: string;
    let blockJS: string;
    let blockCSS: string;

    if (generatedBlock) {
      // Use Claude-generated code
      blockName = generatedBlock.blockName;
      blockHTML = generatedBlock.html;
      blockJS = generatedBlock.js;
      blockCSS = generatedBlock.css;
    } else {
      // Fall back to template-based generation
      const block = buildBlock(extracted);
      blockName = block.blockName;
      blockHTML = block.html;
      blockJS = block.js;
      blockCSS = block.css;
    }

    const previewHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Preview: ${blockName}</title>
  <style>
    /* Reset and base styles */
    *, *::before, *::after {
      box-sizing: border-box;
    }

    :root {
      --background-color: #fff;
      --light-color: #f8f8f8;
      --dark-color: #505050;
      --text-color: #131313;
      --link-color: #3b63fb;
      --link-hover-color: #1d3ecf;
      --heading-font-size-xxl: 48px;
      --heading-font-size-xl: 40px;
      --heading-font-size-l: 32px;
      --heading-font-size-m: 24px;
      --heading-font-size-s: 20px;
      --body-font-size-m: 18px;
      --body-font-size-s: 16px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      color: var(--text-color);
      line-height: 1.5;
    }

    .preview-header {
      background: #fff;
      padding: 20px;
      margin: -20px -20px 20px;
      border-bottom: 1px solid #ddd;
    }

    .preview-header h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    .preview-header .meta {
      color: #666;
      font-size: 14px;
    }

    .preview-header code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    .preview-container {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .preview-content {
      padding: 0 20px;
    }

    /* Generated block CSS */
    ${blockCSS}
  </style>
</head>
<body>
  <div class="preview-header">
    <h1>Block Preview</h1>
    <p class="meta">
      Block: <code>${blockName}</code> |
      Pattern: <code>${extracted.type}</code> |
      Source: <code>${body.url}</code>
    </p>
  </div>

  <div class="preview-container">
    <div class="preview-content">
      ${blockHTML}
    </div>
  </div>

  <script type="module">
    // Simulated aem.js utilities
    function createOptimizedPicture(src, alt = '', eager = false, breakpoints = [{ width: '750' }]) {
      const picture = document.createElement('picture');
      breakpoints.forEach((bp, i) => {
        const source = document.createElement('source');
        source.type = 'image/webp';
        source.srcset = src;
        if (bp.media) source.media = bp.media;
        picture.appendChild(source);
      });
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      img.loading = eager ? 'eager' : 'lazy';
      picture.appendChild(img);
      return picture;
    }

    // Make it available globally for the block script
    window.createOptimizedPicture = createOptimizedPicture;

    // Block decoration function
    ${blockJS.replace(/import\s*{[^}]*}\s*from\s*['"][^'"]*['"];?\s*/g, '')}

    // Run decoration
    const blockEl = document.querySelector('.${blockName}');
    if (blockEl && typeof decorate === 'function') {
      decorate(blockEl);
    }
  </script>
</body>
</html>`;

    return new Response(previewHTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      },
    });
  } catch (error) {
    if (error instanceof BlockGeneratorError) {
      return new Response(`<html><body><h1>Error</h1><p>${error.message}</p></body></html>`, {
        status: error.statusCode,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('<html><body><h1>Error</h1><p>An unexpected error occurred</p></body></html>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

/**
 * Returns the test UI HTML page
 */
function handleTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EDS Block Generator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f5f5f5;
    }
    h1 { margin: 0 0 8px; }
    .subtitle { color: #666; margin: 0 0 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    input[type="text"] {
      width: 100%;
      padding: 12px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 6px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #3b63fb;
      box-shadow: 0 0 0 3px rgba(59, 99, 251, 0.1);
    }
    .buttons { display: flex; gap: 12px; margin-top: 24px; }
    button {
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn-primary {
      background: #3b63fb;
      color: white;
    }
    .btn-primary:hover { background: #1d3ecf; }
    .btn-secondary {
      background: #e0e0e0;
      color: #333;
    }
    .btn-secondary:hover { background: #d0d0d0; }
    .hint {
      font-size: 13px;
      color: #888;
      margin-top: 6px;
    }
    .loading {
      display: none;
      color: #666;
      margin-top: 20px;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 6px;
      margin-top: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <h1>EDS Block Generator</h1>
  <p class="subtitle">Generate AEM Edge Delivery Services blocks from any webpage</p>

  <form id="generateForm">
    <div class="form-group">
      <label for="url">Page URL</label>
      <input type="text" id="url" name="url" placeholder="https://example.com" required>
      <p class="hint">The webpage to extract content from</p>
    </div>

    <div class="form-group">
      <label for="selector">CSS Selector</label>
      <input type="text" id="selector" name="selector" placeholder=".hero, #main-content, article" required>
      <p class="hint">CSS selector for the content block to convert</p>
    </div>

    <div class="buttons">
      <button type="submit" class="btn-primary" id="previewBtn">Preview in Browser</button>
      <button type="button" class="btn-secondary" id="jsonBtn">Get JSON</button>
    </div>
  </form>

  <p class="loading" id="loading">Generating block...</p>
  <div class="error" id="error"></div>

  <script>
    const form = document.getElementById('generateForm');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await makeRequest('/preview', true);
    });

    document.getElementById('jsonBtn').addEventListener('click', async () => {
      await makeRequest('/generate', false);
    });

    async function makeRequest(endpoint, openInNewTab) {
      const url = document.getElementById('url').value;
      const selector = document.getElementById('selector').value;

      loading.style.display = 'block';
      error.style.display = 'none';

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, selector })
        });

        if (endpoint === '/preview') {
          const html = await response.text();
          if (!response.ok) {
            throw new Error('Failed to generate preview');
          }
          const newWindow = window.open('', '_blank');
          if (!newWindow) {
            throw new Error('Popup blocked. Please allow popups for this site.');
          }
          newWindow.document.write(html);
          newWindow.document.close();
        } else {
          const json = await response.json();
          if (json.success) {
            const newWindow = window.open('', '_blank');
            if (!newWindow) {
              throw new Error('Popup blocked. Please allow popups for this site.');
            }
            newWindow.document.write('<pre>' + JSON.stringify(json, null, 2) + '</pre>');
            newWindow.document.close();
          } else {
            throw new Error(json.error);
          }
        }
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Batch generation UI for multiple blocks
 */
function handleBatchUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Batch Block Generator</title>
  <style>
    body { font-family: system-ui; padding: 40px; max-width: 900px; margin: 0 auto; background: #f5f5f5; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .url-input { margin-bottom: 24px; }
    .url-input input { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 6px; }
    .block-item { padding: 16px; margin: 8px 0; background: #fff; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .block-item.loading { background: #fff3cd; }
    .block-item.success { background: #d4edda; }
    .block-item.error { background: #f8d7da; }
    .selector { font-family: monospace; font-size: 12px; color: #666; }
    .status { font-weight: 600; }
    button { padding: 8px 16px; cursor: pointer; }
    #startAll { font-size: 18px; padding: 14px 28px; background: #3b63fb; color: white; border: none; border-radius: 6px; margin-bottom: 24px; }
    #startAll:hover { background: #1d3ecf; }
    #startAll:disabled { background: #ccc; cursor: not-allowed; }
    .note { font-size: 13px; color: #888; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>Batch Block Generator</h1>
  <p class="subtitle">Generate multiple EDS blocks from any webpage using Claude Vision</p>

  <div class="url-input">
    <input type="text" id="pageUrl" value="https://www.virginatlanticcargo.com/gb/en.html" placeholder="Page URL">
  </div>

  <button id="startAll">Generate All Blocks</button>
  <div id="blocks"></div>
  <p class="note">All blocks run in parallel (Workers Paid: 30 concurrent browsers). ~20-40 seconds total.</p>

  <script>
    const defaultSelectors = [
      { name: 'Hero Carousel', selector: '.cmp-carousel' },
      { name: 'Booking Panel', selector: '.bookpanel.section' },
      { name: 'Products Grid', selector: '.textandasset.section .vertical3Column' },
      { name: 'Quick Links', selector: '.textandasset.section .vertical3ColumnText' },
    ];

    const blocksDiv = document.getElementById('blocks');

    defaultSelectors.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'block-item';
      div.id = 'block-' + i;
      div.innerHTML = '<div><strong>' + item.name + '</strong><br><span class="selector">' + item.selector + '</span></div><span class="status">Ready</span>';
      blocksDiv.appendChild(div);
    });

    // Concurrency limiter - Browser Rendering allows ~2 concurrent sessions
    async function runWithConcurrency(tasks, limit) {
      const results = [];
      const executing = [];

      for (const task of tasks) {
        const p = task().then(r => {
          executing.splice(executing.indexOf(p), 1);
          return r;
        });
        results.push(p);
        executing.push(p);

        if (executing.length >= limit) {
          await Promise.race(executing);
        }
      }

      return Promise.all(results);
    }

    document.getElementById('startAll').onclick = async () => {
      const pageUrl = document.getElementById('pageUrl').value;
      document.getElementById('startAll').disabled = true;

      // Create task functions for each block
      const tasks = defaultSelectors.map((item, i) => async () => {
        const div = document.getElementById('block-' + i);
        div.className = 'block-item loading';
        div.querySelector('.status').textContent = 'Generating...';

        try {
          const response = await fetch('/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: pageUrl, selector: item.selector })
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(err.error || 'Generation failed');
          }

          const html = await response.text();
          div.className = 'block-item success';
          div.querySelector('.status').textContent = 'Opening...';

          const newWindow = window.open('', '_blank');
          if (newWindow) {
            newWindow.document.write(html);
            newWindow.document.close();
            div.querySelector('.status').textContent = 'Done!';
          } else {
            div.querySelector('.status').textContent = 'Done (allow popups)';
          }
        } catch (err) {
          div.className = 'block-item error';
          div.querySelector('.status').textContent = err.message;
        }
      });

      // Run with max 10 concurrent browser sessions (Workers Paid: 30 limit)
      await runWithConcurrency(tasks, 10);
      document.getElementById('startAll').disabled = false;
    };
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Parses and validates the request body
 */
async function parseRequestBody(request: Request): Promise<BlockRequest> {
  const contentType = request.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    throw new BlockGeneratorError(
      'Content-Type must be application/json',
      'INVALID_REQUEST'
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BlockGeneratorError(
      'Invalid JSON in request body',
      'INVALID_REQUEST'
    );
  }

  // Validate required fields
  if (!body || typeof body !== 'object') {
    throw new BlockGeneratorError(
      'Request body must be an object',
      'INVALID_REQUEST'
    );
  }

  const { url, selector } = body as Record<string, unknown>;

  if (typeof url !== 'string' || !url.trim()) {
    throw new BlockGeneratorError(
      'Missing or invalid "url" field',
      'INVALID_REQUEST'
    );
  }

  if (typeof selector !== 'string' || !selector.trim()) {
    throw new BlockGeneratorError(
      'Missing or invalid "selector" field',
      'INVALID_REQUEST'
    );
  }

  return {
    url: url.trim(),
    selector: selector.trim(),
  };
}

/**
 * Handles errors and returns appropriate response
 */
function handleError(error: unknown, env: Env): Response {
  if (error instanceof BlockGeneratorError) {
    const response: ErrorResponse = {
      success: false,
      error: error.message,
      code: error.code,
    };

    return Response.json(response, {
      status: error.statusCode,
      headers: corsHeaders(env),
    });
  }

  // Unknown error
  console.error('Unexpected error:', error);

  const response: ErrorResponse = {
    success: false,
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  };

  return Response.json(response, {
    status: 500,
    headers: corsHeaders(env),
  });
}

/**
 * Returns CORS headers
 */
function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

/**
 * Handles CORS preflight requests
 */
function handleCORS(env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
