/**
 * AEM Block Importer - Service Worker
 *
 * Handles background operations:
 * - Content script injection
 * - Screenshot capture
 * - API calls to worker
 * - State coordination
 */

// Import shared modules
importScripts('../lib/state-manager.js', '../lib/api-client.js', '../lib/github-client.js');

/**
 * Keepalive mechanism for long-running operations
 * MV3 service workers get killed after ~30s of inactivity
 */
let keepaliveInterval = null;

function startKeepalive() {
  if (keepaliveInterval) return;
  // Ping every 20 seconds to prevent service worker termination
  keepaliveInterval = setInterval(() => {
    console.log('Keepalive ping...');
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

/**
 * Inject content script into active tab
 */
async function injectContentScript(tabId) {
  try {
    // Inject CSS first
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/selector.css'],
    });

    // Then inject JS
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/xpath-generator.js', 'content/selector.js'],
    });

    return { success: true };
  } catch (error) {
    console.error('Failed to inject content script:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Inject sidebar content script into active tab
 */
async function injectSidebar(tabId) {
  try {
    // Inject CSS first
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/sidebar.css'],
    });

    // Then inject JS
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/sidebar.js'],
    });

    // Wait a moment for script to initialize
    await new Promise(resolve => setTimeout(resolve, 100));

    // Tell sidebar to open
    chrome.tabs.sendMessage(tabId, { type: 'OPEN_SIDEBAR' });

    return { success: true };
  } catch (error) {
    console.error('Failed to inject sidebar:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle block generation from sidebar (element already selected)
 */
async function handleGenerateBlockFromSidebar(url, elementData, sessionId) {
  console.log('handleGenerateBlockFromSidebar:', { url, sessionId });
  console.log('=== elementData DEBUG ===');
  console.log('  elementData:', elementData);
  console.log('  elementData.html:', elementData?.html ? `${elementData.html.substring(0, 100)}... (${elementData.html.length} chars)` : 'MISSING');
  console.log('  elementData.xpath:', elementData?.xpath || 'MISSING');
  console.log('  elementData.bounds:', elementData?.bounds);
  console.log('=========================');

  startKeepalive();

  try {
    const config = await StateManager.getConfig();
    const tab = await findTargetTab();

    // Capture screenshot
    console.log('Capturing visible tab screenshot...');
    const fullScreenshot = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 100,
    });
    console.log('Full screenshot captured, length:', fullScreenshot?.length);

    // Crop screenshot in content script if we have bounds
    let screenshotBlob;
    if (elementData.bounds && tab) {
      console.log('Cropping screenshot with bounds:', elementData.bounds);
      const croppedDataUrl = await cropScreenshotInTab(tab.id, fullScreenshot, elementData.bounds);
      console.log('Cropped dataUrl length:', croppedDataUrl?.length);
      const response = await fetch(croppedDataUrl);
      screenshotBlob = await response.blob();
      console.log('Cropped screenshot blob size:', screenshotBlob?.size);
    } else {
      console.log('Using full screenshot (no bounds or tab)');
      const response = await fetch(fullScreenshot);
      screenshotBlob = await response.blob();
      console.log('Full screenshot blob size:', screenshotBlob?.size);
    }

    // Generate block via API
    console.log('Calling ApiClient.generateBlock with:');
    console.log('  url:', url);
    console.log('  screenshot blob size:', screenshotBlob?.size);
    console.log('  html:', elementData?.html ? `${elementData.html.length} chars` : 'MISSING');
    console.log('  xpath:', elementData?.xpath || 'not provided');

    const generateResult = await ApiClient.generateBlock({
      url,
      screenshot: screenshotBlob,
      html: elementData?.html,
      xpath: elementData?.xpath,
    });

    if (!generateResult.success) {
      throw new Error(generateResult.error || 'Block generation failed');
    }

    // Push variant for preview
    const previewResult = await ApiClient.pushBlockVariant({
      sessionId,
      blockName: generateResult.blockName,
      html: generateResult.html,
      css: generateResult.css,
      js: generateResult.js,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    const variant = previewResult.variant || {};
    const previewUrl = variant.previewUrl ||
      `https://${variant.branch || 'main'}--${config.daSite}--${config.daOrg}.aem.live${variant.daPath || `/preview/${generateResult.blockName}`}`;

    stopKeepalive();

    return {
      success: true,
      blockName: generateResult.blockName,
      html: generateResult.html,
      css: generateResult.css,
      js: generateResult.js,
      previewUrl,
      branch: variant.branch,
    };
  } catch (error) {
    console.error('Block generation from sidebar failed:', error);
    stopKeepalive();
    return { success: false, error: error.message };
  }
}

/**
 * Capture visible tab and crop to element bounds
 */
async function captureElementScreenshot(tabId, bounds) {
  try {
    // Capture the visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 100,
    });

    // Create an offscreen document for canvas operations
    // Note: In MV3, we need to use offscreen API for DOM operations
    // For simplicity, we'll do the cropping in the content script
    // and just return the full screenshot here if bounds are provided

    // Convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // If we have bounds, we'll need to crop - but this requires canvas
    // which isn't available in service workers. We'll send bounds to content
    // script for cropping, or use the full screenshot and let the server crop.

    if (bounds) {
      // For now, return the full screenshot with bounds metadata
      // The server can crop, or we can implement offscreen document
      return {
        success: true,
        screenshot: blob,
        bounds,
        fullPage: true, // Indicates cropping is needed
      };
    }

    return {
      success: true,
      screenshot: blob,
    };
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Crop screenshot using canvas in content script
 */
async function cropScreenshotInTab(tabId, dataUrl, bounds) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (imageDataUrl, cropBounds) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          const dpr = window.devicePixelRatio || 1;
          canvas.width = cropBounds.width * dpr;
          canvas.height = cropBounds.height * dpr;

          ctx.drawImage(
            img,
            cropBounds.x * dpr,
            cropBounds.y * dpr,
            cropBounds.width * dpr,
            cropBounds.height * dpr,
            0,
            0,
            canvas.width,
            canvas.height
          );

          resolve(canvas.toDataURL('image/png'));
        };
        img.src = imageDataUrl;
      });
    },
    args: [dataUrl, bounds],
  });

  return results[0]?.result;
}

/**
 * Handle element selection completion
 */
async function handleElementSelected(tabId, data) {
  const { xpath, html, bounds } = data;

  // Start keepalive to prevent service worker termination during long API calls
  startKeepalive();

  try {
    // Update state
    await StateManager.setState({
      status: 'generating',
      progress: { screenshot: 'active' },
    });

    // Notify popup
    chrome.runtime.sendMessage({
      type: 'SELECTION_COMPLETE',
    });

    // Get current tab URL
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;

    // Capture screenshot
    const fullScreenshot = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 100,
    });

    // Crop screenshot in content script
    const croppedDataUrl = await cropScreenshotInTab(tabId, fullScreenshot, bounds);

    // Convert to blob
    const response = await fetch(croppedDataUrl);
    const screenshotBlob = await response.blob();

    // Update progress
    await StateManager.setState({
      progress: { screenshot: 'complete', html: 'complete', generate: 'active' },
    });

    chrome.runtime.sendMessage({
      type: 'GENERATION_PROGRESS',
      progress: { screenshot: 'complete', html: 'complete', generate: 'active' },
    });

    // Get config
    const config = await StateManager.getConfig();

    // Generate block
    const generateResult = await ApiClient.generateBlock({
      url,
      screenshot: screenshotBlob,
      xpath,
      html,
    });

    if (!generateResult.success) {
      throw new Error(generateResult.error || 'Block generation failed');
    }

    // Update progress
    await StateManager.setState({
      progress: {
        screenshot: 'complete',
        html: 'complete',
        generate: 'complete',
        preview: 'active',
        blockName: generateResult.blockName,
      },
    });

    chrome.runtime.sendMessage({
      type: 'GENERATION_PROGRESS',
      progress: {
        screenshot: 'complete',
        html: 'complete',
        generate: 'complete',
        preview: 'active',
        blockName: generateResult.blockName,
      },
    });

    // Generate session ID
    const sessionId = StateManager.generateSessionId();

    // Push variant for preview
    const previewResult = await ApiClient.pushBlockVariant({
      sessionId,
      blockName: generateResult.blockName,
      html: generateResult.html,
      css: generateResult.css,
      js: generateResult.js,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    // Build preview URL (response has { success, variant: { previewUrl, branch, ... } })
    const variant = previewResult.variant || {};
    const previewUrl =
      variant.previewUrl ||
      `https://${variant.branch || 'main'}--${config.daSite}--${config.daOrg}.aem.live${variant.daPath || `/preview/${generateResult.blockName}`}`;

    // Store result in state
    await StateManager.setState({
      status: 'preview',
      sessionId,
      previewData: {
        blockName: generateResult.blockName,
        html: generateResult.html,
        css: generateResult.css,
        js: generateResult.js,
        previewUrl,
        branch: variant.branch,
      },
      progress: {
        screenshot: 'complete',
        html: 'complete',
        generate: 'complete',
        preview: 'complete',
      },
    });

    // Notify popup
    chrome.runtime.sendMessage({
      type: 'GENERATION_COMPLETE',
      data: {
        blockName: generateResult.blockName,
        html: generateResult.html,
        css: generateResult.css,
        js: generateResult.js,
        previewUrl,
      },
    });

    // Stop keepalive - operation complete
    stopKeepalive();
  } catch (error) {
    console.error('Element processing failed:', error);

    // Stop keepalive on error
    stopKeepalive();

    await StateManager.setState({
      status: 'error',
      error: error.message,
    });

    chrome.runtime.sendMessage({
      type: 'GENERATION_ERROR',
      error: error.message,
    });
  }
}

/**
 * Handle block acceptance (merge)
 */
async function handleAcceptBlock(sessionId, blockName, branch) {
  try {
    const config = await StateManager.getConfig();

    await ApiClient.finalizeBlock({
      sessionId,
      blockName,
      winner: { option: 1, iteration: 1 }, // Single variant flow uses option 1
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Block acceptance failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle block rejection
 */
async function handleRejectBlock(sessionId) {
  // Branch cleanup is handled by backend
  // Just clear local state
  return { success: true };
}

/**
 * Handle design system import
 */
async function handleDesignSystemImport(url) {
  // Start keepalive to prevent service worker termination during long API calls
  startKeepalive();

  try {
    const config = await StateManager.getConfig();

    // Generate session ID for branch creation
    const sessionId = StateManager.generateSessionId();

    console.log('Design system import request:', {
      url,
      sessionId,
      generatePreview: true,
      github: config.githubRepo,
      da: { org: config.daOrg, site: config.daSite },
    });

    const result = await ApiClient.importDesignSystem({
      url,
      sessionId,
      generatePreview: true,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    console.log('Design system import response:', {
      success: result.success,
      hasPreview: !!result.preview,
      previewUrl: result.preview?.previewUrl,
      branch: result.github?.branch,
    });

    // Transform extractedDesign into tokens format expected by popup
    const design = result.extractedDesign || {};
    const colors = design.colors || {};
    const typography = design.typography || {};
    const fonts = design.fonts || [];

    // Convert colors object to array format
    const colorTokens = Object.entries(colors)
      .filter(([_, value]) => value && typeof value === 'string')
      .map(([name, value]) => ({ name, value }));

    // Convert fonts to array format
    const fontTokens = fonts.map(f => ({
      name: f.family || f.name,
      value: f.family || f.name,
    }));

    // Add typography fonts if no downloaded fonts
    if (fontTokens.length === 0) {
      if (typography.bodyFont) fontTokens.push({ name: 'Body', value: typography.bodyFont });
      if (typography.headingFont) fontTokens.push({ name: 'Heading', value: typography.headingFont });
    }

    // Extract branch name from GitHub response
    const branch = result.github?.branch || result.preview?.branch;

    // Stop keepalive - operation complete
    stopKeepalive();

    return {
      success: true,
      tokens: {
        colors: colorTokens,
        fonts: fontTokens,
      },
      styleGuideUrl: result.preview?.previewUrl,
      commitUrl: result.github?.commitUrl,
      branch,
    };
  } catch (error) {
    console.error('Design system import failed:', error);
    // Stop keepalive on error
    stopKeepalive();
    return { success: false, error: error.message };
  }
}

/**
 * Handle design system finalization (merge to main)
 */
async function handleFinalizeDesignSystem(branch) {
  try {
    const config = await StateManager.getConfig();

    await ApiClient.finalizeDesignSystem({
      branch,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Design system finalize failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle design system rejection (delete branch)
 */
async function handleRejectDesignSystem(branch) {
  // Branch cleanup can be handled by backend or just left (will be garbage collected)
  // For now, just return success
  return { success: true };
}

/**
 * Handle page composition and DA push
 */
async function handleComposePage(url, sections, pageTitle, acceptedBlocks) {
  console.log('handleComposePage called:', { url, sectionCount: sections?.length, pageTitle, acceptedBlocks });

  // Start keepalive for long-running operation
  startKeepalive();

  try {
    const config = await StateManager.getConfig();

    // Generate a session ID for this page
    const sessionId = StateManager.generateSessionId();

    // Call worker to compose page
    const result = await ApiClient.composePage({
      url,
      sections,
      pageTitle,
      sessionId,
      acceptedBlocks: acceptedBlocks || {},
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    console.log('composePage result:', result);

    stopKeepalive();

    return {
      success: true,
      previewUrl: result.previewUrl,
      daPath: result.daPath,
      branch: result.branch,
      blocksGenerated: result.blocksGenerated,
    };
  } catch (error) {
    console.error('Page composition failed:', error);
    stopKeepalive();
    return { success: false, error: error.message };
  }
}

/**
 * Handle page finalization (merge to main)
 */
async function handleFinalizePage(branch) {
  console.log('handleFinalizePage called with branch:', branch);

  try {
    const config = await StateManager.getConfig();

    const result = await ApiClient.finalizePage({
      branch,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
    });

    console.log('finalizePage result:', result);

    return {
      success: true,
      commitSha: result.commitSha,
      commitUrl: result.commitUrl,
    };
  } catch (error) {
    console.error('Page finalization failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle page rejection (delete branch)
 */
async function handleRejectPage(branch) {
  console.log('handleRejectPage called with branch:', branch);

  try {
    const config = await StateManager.getConfig();

    const result = await ApiClient.rejectPage({
      branch,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Page rejection failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle block generation for a page import section
 * Uses the standalone block generation workflow (with preview branch)
 */
async function handleGenerateBlockForSection(url, section, sectionIndex) {
  console.log('handleGenerateBlockForSection called:', { url, section: section.name, sectionIndex });

  startKeepalive();

  try {
    const config = await StateManager.getConfig();

    // Generate a session ID for this block
    const sessionId = StateManager.generateSessionId();

    // Call worker to generate block from section description
    const result = await ApiClient.generateBlockForSection({
      url,
      sectionName: section.name,
      sectionDescription: section.description,
      sectionType: section.type,
      sectionHtml: section.html, // Include HTML for better context
      yStart: section.yStart,
      yEnd: section.yEnd,
      sessionId,
      github: {
        owner: config.githubRepo.split('/')[0],
        repo: config.githubRepo.split('/')[1],
      },
      da: {
        org: config.daOrg,
        site: config.daSite,
      },
    });

    console.log('generateBlockForSection result:', result);

    stopKeepalive();

    if (!result.success) {
      return { success: false, error: result.error || 'Block generation failed' };
    }

    return {
      success: true,
      blockName: result.blockName,
      previewUrl: result.previewUrl,
      branch: result.branch,
      sessionId,
      html: result.html,
      css: result.css,
      js: result.js,
    };
  } catch (error) {
    console.error('Block generation for section failed:', error);
    stopKeepalive();
    return { success: false, error: error.message };
  }
}

/**
 * Handle page analysis
 */
async function handleAnalyzePage(url) {
  console.log('handleAnalyzePage called with url:', url);

  // Start keepalive for long-running analysis
  startKeepalive();

  try {
    console.log('Calling ApiClient.analyzePage...');
    const result = await ApiClient.analyzePage({ url });
    console.log('ApiClient.analyzePage returned:', result?.blocks?.length, 'blocks');

    stopKeepalive();

    return {
      success: true,
      sections: result.blocks || [],
      screenshot: result.screenshot, // Full page screenshot
      pageTitle: result.title,
    };
  } catch (error) {
    console.error('Page analysis failed:', error);
    stopKeepalive();
    return { success: false, error: error.message };
  }
}

/**
 * Find the best tab to inject content script into
 * Excludes extension pages and chrome:// URLs
 */
async function findTargetTab() {
  // First try to get the active tab
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  // If active tab is a valid web page, use it
  if (activeTab && activeTab.url &&
      !activeTab.url.startsWith('chrome://') &&
      !activeTab.url.startsWith('chrome-extension://')) {
    console.log('Using active tab:', activeTab.url);
    return activeTab;
  }

  // Otherwise, find the most recent non-extension tab
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const webTabs = allTabs.filter(t =>
    t.url &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://')
  );

  if (webTabs.length > 0) {
    // Sort by last accessed (most recent first)
    webTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    console.log('Using most recent web tab:', webTabs[0].url);
    return webTabs[0];
  }

  return null;
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleAsync = async () => {
    switch (message.type) {
      case 'START_SELECTION': {
        console.log('START_SELECTION received');
        const tab = await findTargetTab();
        if (!tab) {
          console.error('No valid target tab found');
          return { error: 'No valid web page tab found' };
        }
        console.log('Injecting into tab:', tab.id, tab.url);
        return injectContentScript(tab.id);
      }

      case 'CANCEL_SELECTION': {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_SELECTION' });
        }
        return { success: true };
      }

      case 'START_SECTION_SELECTION': {
        console.log('START_SECTION_SELECTION received');
        const tab = await findTargetTab();
        if (!tab) {
          console.error('No valid target tab found');
          return { error: 'No valid web page tab found' };
        }
        console.log('Injecting section selector into tab:', tab.id, tab.url);
        // Inject the same content script but with a flag for section mode
        const result = await injectContentScript(tab.id);
        if (result.success) {
          // Tell content script to enter section selection mode
          chrome.tabs.sendMessage(tab.id, { type: 'START_SECTION_MODE' });
        }
        return result;
      }

      case 'CANCEL_SECTION_SELECTION': {
        const tab = await findTargetTab();
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_SECTION_SELECTION' });
        }
        return { success: true };
      }

      case 'SECTION_SELECTED': {
        // Forward section selection to popup
        chrome.runtime.sendMessage({
          type: 'SECTION_SELECTED',
          data: message.data,
        });
        return { success: true };
      }

      case 'ELEMENT_SELECTED': {
        handleElementSelected(sender.tab.id, message.data);
        return { success: true };
      }

      case 'ACCEPT_BLOCK': {
        return handleAcceptBlock(message.sessionId, message.blockName, message.branch);
      }

      case 'REJECT_BLOCK': {
        return handleRejectBlock(message.sessionId);
      }

      case 'IMPORT_DESIGN_SYSTEM': {
        return handleDesignSystemImport(message.url);
      }

      case 'FINALIZE_DESIGN_SYSTEM': {
        return handleFinalizeDesignSystem(message.branch);
      }

      case 'REJECT_DESIGN_SYSTEM': {
        return handleRejectDesignSystem(message.branch);
      }

      case 'ANALYZE_PAGE': {
        return handleAnalyzePage(message.url);
      }

      case 'GENERATE_BLOCK_FOR_SECTION': {
        return handleGenerateBlockForSection(message.url, message.section, message.sectionIndex);
      }

      case 'COMPOSE_PAGE': {
        return handleComposePage(message.url, message.sections, message.pageTitle, message.acceptedBlocks);
      }

      case 'FINALIZE_PAGE': {
        return handleFinalizePage(message.branch);
      }

      case 'REJECT_PAGE': {
        return handleRejectPage(message.branch);
      }

      case 'OPEN_SIDEBAR': {
        console.log('OPEN_SIDEBAR received');
        const tab = await findTargetTab();
        if (!tab) {
          console.error('No valid target tab found');
          return { error: 'No valid web page tab found' };
        }
        console.log('Injecting sidebar into tab:', tab.id, tab.url);
        return injectSidebar(tab.id);
      }

      case 'GET_BLOCKS': {
        // Get blocks from GitHub for the sidebar
        const config = await StateManager.getConfig();
        if (!config.githubRepo) {
          return { blocks: [] };
        }
        try {
          const [owner, repo] = config.githubRepo.split('/');
          const blocks = await GitHubClient.getBlocks(config.githubRepo);
          return { blocks };
        } catch (error) {
          console.error('Failed to get blocks:', error);
          return { blocks: [] };
        }
      }

      case 'GENERATE_BLOCK': {
        // Generate block from sidebar element selection
        console.log('GENERATE_BLOCK received:', message.url, message.sessionId);
        return handleGenerateBlockFromSidebar(message.url, message.elementData, message.sessionId);
      }

      default:
        return { error: 'Unknown message type' };
    }
  };

  handleAsync().then(sendResponse);
  return true; // Keep message channel open for async response
});

// Handle content script messages
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'selector') {
    port.onMessage.addListener((message) => {
      if (message.type === 'ELEMENT_SELECTED') {
        handleElementSelected(port.sender.tab.id, message.data);
      }
    });
  }
});

console.log('AEM Block Importer service worker initialized');
