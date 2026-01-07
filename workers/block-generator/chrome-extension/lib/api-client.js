/**
 * API Client for AEM Block Generator Worker
 *
 * Handles communication with the Cloudflare Worker endpoints.
 */

const ApiClient = {
  // Production worker URL
  DEFAULT_WORKER_URL: 'https://eds-block-generator.paolo-moz.workers.dev',

  /**
   * Get worker URL from config or use default
   */
  async getWorkerUrl() {
    const config = await StateManager.getConfig();
    return config.workerUrl || this.DEFAULT_WORKER_URL;
  },

  /**
   * Generate block from screenshot and xpath (with refinements)
   *
   * POST /block-generate-full
   * Returns { success, iterations: [{ iteration, blockName, html, css, js }, ...] }
   */
  async generateBlock({ url, screenshot, xpath, html, backgroundImages, refinements = 2 }) {
    const workerUrl = await this.getWorkerUrl();

    // Detailed debug logging
    console.log('=== ApiClient.generateBlock DEBUG ===');
    console.log('  url:', url);
    console.log('  screenshot:', screenshot);
    console.log('  screenshot type:', screenshot?.constructor?.name);
    console.log('  screenshot size:', screenshot?.size);
    console.log('  xpath:', xpath);
    console.log('  html:', html ? `${html.substring(0, 100)}... (${html.length} chars)` : 'MISSING');
    console.log('  backgroundImages:', backgroundImages?.length || 0);
    console.log('  refinements:', refinements);
    console.log('=====================================');

    const formData = new FormData();
    formData.append('url', url);
    formData.append('refinements', String(refinements));

    if (screenshot && screenshot.size > 0) {
      formData.append('screenshot', screenshot, 'element.png');
      console.log('✓ Screenshot appended to FormData');
    } else {
      console.error('✗ Screenshot is missing or empty!', { screenshot, size: screenshot?.size });
    }

    if (xpath) {
      formData.append('xpath', xpath);
      console.log('✓ XPath appended:', xpath);
    } else {
      console.warn('⚠ XPath not provided');
    }

    if (html) {
      formData.append('html', html);
      console.log('✓ HTML appended:', html.length, 'chars');
    } else {
      console.warn('⚠ HTML not provided');
    }

    // Send background images extracted from CSS
    if (backgroundImages && backgroundImages.length > 0) {
      formData.append('backgroundImages', JSON.stringify(backgroundImages));
      console.log('✓ Background images appended:', backgroundImages.length);
    }

    if (!xpath && !html) {
      console.error('✗ CRITICAL: Both xpath and html are missing - request will fail!');
    }

    console.log('Sending request to:', `${workerUrl}/block-generate-full`);

    const response = await fetch(`${workerUrl}/block-generate-full`, {
      method: 'POST',
      body: formData,
    });

    console.log('Response status:', response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Error response body:', errorBody);
      let error = {};
      try {
        error = JSON.parse(errorBody);
      } catch (e) {
        error = { error: errorBody };
      }
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Push block variant for preview
   *
   * POST /block-variant-push
   */
  async pushBlockVariant({
    sessionId,
    blockName,
    html,
    css,
    js,
    github,
    da,
    option = 1,
    iteration = 1,
  }) {
    const workerUrl = await this.getWorkerUrl();

    const response = await fetch(`${workerUrl}/block-variant-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId,
        blockName,
        option,
        iteration,
        html,
        css,
        js,
        github: { ...github, useServerToken: true },
        da,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Finalize block (merge to main)
   *
   * POST /block-finalize
   */
  async finalizeBlock({ sessionId, blockName, winner, github, da }) {
    const workerUrl = await this.getWorkerUrl();

    const response = await fetch(`${workerUrl}/block-finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId,
        blockName,
        winner,
        github: { ...github, useServerToken: true },
        da,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Select winner from multiple block variants using Claude Vision
   *
   * POST /block-winner
   */
  async selectWinner({ screenshot, variants }) {
    const workerUrl = await this.getWorkerUrl();

    const formData = new FormData();
    formData.append('screenshot', screenshot, 'original.png');
    formData.append('blocks', JSON.stringify(variants.map((v, i) => ({
      html: v.html,
      css: v.css,
      js: v.js,
      blockName: v.blockName,
      optionIndex: i,
      previewUrl: v.previewUrl,
    }))));

    console.log('[ApiClient.selectWinner] Comparing', variants.length, 'variants');

    const response = await fetch(`${workerUrl}/block-winner`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Import design system
   *
   * POST /design-system-import
   */
  async importDesignSystem({ url, sessionId, generatePreview, github, da }) {
    const workerUrl = await this.getWorkerUrl();

    const response = await fetch(`${workerUrl}/design-system-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        sessionId,
        generatePreview,
        github,
        da,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Finalize design system (merge to main)
   *
   * POST /design-system-finalize
   */
  async finalizeDesignSystem({ branch, github }) {
    const workerUrl = await this.getWorkerUrl();

    const response = await fetch(`${workerUrl}/design-system-finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch,
        github,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Analyze page sections
   *
   * POST /analyze
   */
  async analyzePage({ url }) {
    const workerUrl = await this.getWorkerUrl();
    console.log('ApiClient.analyzePage - workerUrl:', workerUrl, 'url:', url);

    const response = await fetch(`${workerUrl}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    console.log('ApiClient.analyzePage - response status:', response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('ApiClient.analyzePage - error response:', JSON.stringify(error));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Generate a block for a page import section
   * Uses the standalone block generation workflow (with preview branch)
   *
   * POST /generate-block-for-section
   */
  async generateBlockForSection({ url, sectionName, sectionDescription, sectionType, sectionHtml, yStart, yEnd, sessionId, github, da }) {
    const workerUrl = await this.getWorkerUrl();
    console.log('ApiClient.generateBlockForSection - workerUrl:', workerUrl, 'section:', sectionName);

    const response = await fetch(`${workerUrl}/generate-block-for-section`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        sectionName,
        sectionDescription,
        sectionType,
        sectionHtml, // Include HTML for better block generation context
        yStart,
        yEnd,
        sessionId,
        github,
        da,
      }),
    });

    console.log('ApiClient.generateBlockForSection - response status:', response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('ApiClient.generateBlockForSection - error response:', JSON.stringify(error));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Compose a page from sections and push to DA
   *
   * POST /compose-page
   */
  async composePage({ url, sections, pageTitle, sessionId, acceptedBlocks, github, da }) {
    const workerUrl = await this.getWorkerUrl();
    console.log('ApiClient.composePage - workerUrl:', workerUrl);

    const response = await fetch(`${workerUrl}/compose-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        sections,
        pageTitle,
        sessionId,
        acceptedBlocks,
        github,
        da,
      }),
    });

    console.log('ApiClient.composePage - response status:', response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('ApiClient.composePage - error response:', JSON.stringify(error));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Finalize page import (merge branch to main)
   *
   * POST /page-finalize
   */
  async finalizePage({ branch, github }) {
    const workerUrl = await this.getWorkerUrl();
    console.log('ApiClient.finalizePage - branch:', branch);

    const response = await fetch(`${workerUrl}/page-finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch,
        github,
      }),
    });

    console.log('ApiClient.finalizePage - response status:', response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('ApiClient.finalizePage - error response:', JSON.stringify(error));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * Reject page import (delete branch)
   */
  async rejectPage({ branch, github }) {
    const workerUrl = await this.getWorkerUrl();
    console.log('ApiClient.rejectPage - branch:', branch);

    // Use GitHub API directly to delete branch
    // The worker GITHUB_TOKEN will be used server-side
    // For now, just mark as rejected (branch cleanup can happen later)
    console.log(`Would delete branch: ${branch}`);
    return { success: true };
  },
};

// Make available globally
if (typeof window !== 'undefined') {
  window.ApiClient = ApiClient;
}
