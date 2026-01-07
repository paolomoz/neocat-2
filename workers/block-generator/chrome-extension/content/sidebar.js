/**
 * AEM Block Importer - Full Persistent Sidebar
 *
 * Complete extension UI that persists on the page.
 * Handles: Setup, Dashboard, Block Selection, Page Import, Previews
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__aemBlockImporterSidebar) {
    window.__aemBlockImporterSidebar.show();
    return;
  }

  // Constants
  const STORAGE_KEYS = {
    CONFIG: 'aem_importer_config',
    STATE: 'aem_importer_state',
  };

  const VIEWS = {
    SETUP: 'setup',
    DASHBOARD: 'dashboard',
    SELECTION: 'selection',
    GENERATING: 'generating',
    PREVIEW: 'preview',
    PAGE_IMPORT: 'page-import',
    DESIGN_IMPORT: 'design-import',
    MULTI_GENERATING: 'multi-generating',
  };

  const MAX_PARALLEL_GENERATIONS = 5;

  // State
  let state = {
    currentView: VIEWS.SETUP,
    config: {},
    // Block generation
    currentCode: { html: '', css: '', js: '' },
    currentCodeTab: 'js',
    sessionId: null,
    previewData: null,
    // Page import
    pageImport: null,
    // Design import
    designImport: null,
    // Selection
    isSelecting: false,
    selectionMode: 'block', // 'block', 'section', or 'multi'
    // Multi-block generation
    multiBlockGeneration: {
      isSelecting: false,
      generations: {},
      generationOrder: [],
      queue: [],
      activeCount: 0,
    },
  };

  let sidebar = null;
  let overlay = null;
  let tooltip = null;
  let currentElement = null;
  let altKeyPressed = false; // Track Alt key for smart selection mode
  let lastMouseX = 0;
  let lastMouseY = 0;

  // ============ Storage Helpers ============

  async function getConfig() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
    return result[STORAGE_KEYS.CONFIG] || {};
  }

  async function saveConfig(config) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CONFIG]: { ...config, updatedAt: Date.now() }
    });
    state.config = config;
  }

  async function getState() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.STATE);
    return result[STORAGE_KEYS.STATE] || {};
  }

  async function saveState(newState) {
    const current = await getState();
    await chrome.storage.local.set({
      [STORAGE_KEYS.STATE]: { ...current, ...newState, updatedAt: Date.now() }
    });
  }

  async function clearState() {
    await chrome.storage.local.remove(STORAGE_KEYS.STATE);
  }

  function generateSessionId() {
    return Math.random().toString(36).substr(2, 8);
  }

  // ============ UI Creation ============

  function createSidebar() {
    sidebar = document.createElement('div');
    sidebar.id = 'aem-importer-sidebar';
    sidebar.innerHTML = `
      <div class="aem-sidebar-header">
        <button class="aem-sidebar-toggle" title="Collapse">▲</button>
        <h2>AEM Block Importer</h2>
        <button class="aem-sidebar-close" title="Close">&times;</button>
      </div>
      <div class="aem-sidebar-content">
        <!-- Setup View -->
        <div id="aem-view-setup" class="aem-view">
          <div class="aem-form-group">
            <label>GitHub Repository</label>
            <input type="text" id="aem-github-repo" placeholder="owner/repo or GitHub URL">
            <small>Your AEM Edge Delivery project</small>
          </div>
          <button id="aem-save-config" class="aem-btn aem-btn-primary aem-btn-full">Connect</button>
          <div id="aem-setup-status" class="aem-status aem-hidden"></div>
        </div>

        <!-- Dashboard View -->
        <div id="aem-view-dashboard" class="aem-view aem-hidden">
          <div class="aem-sidebar-url" id="aem-current-url"></div>

          <div class="aem-dashboard-actions">
            <button id="aem-select-blocks-btn" class="aem-action-btn">
              <span class="aem-action-icon">&#128218;</span>
              <span class="aem-action-text">
                <strong>Select Blocks</strong>
                <small>Generate multiple blocks in parallel</small>
              </span>
            </button>
          </div>
        </div>

        <!-- Selection View -->
        <div id="aem-view-selection" class="aem-view aem-hidden">
          <div class="aem-selection-info">
            <div class="aem-selection-icon">&#127919;</div>
            <h3>Selection Mode Active</h3>
            <p>Hover over elements on the page.<br>Click to select.</p>
            <p class="aem-selection-hint">Hold <kbd>Alt</kbd> to select parent container</p>
          </div>
          <button id="aem-cancel-selection" class="aem-btn aem-btn-secondary aem-btn-full">Cancel (ESC)</button>
        </div>

        <!-- Generating View -->
        <div id="aem-view-generating" class="aem-view aem-hidden">
          <div class="aem-generating-header">
            <span>Generating:</span>
            <strong id="aem-generating-name">block</strong>
          </div>
          <div class="aem-progress-bar">
            <div id="aem-progress-fill" class="aem-progress-fill"></div>
          </div>
          <div class="aem-progress-percent"><span id="aem-progress-percent">0</span>%</div>
          <div class="aem-progress-steps">
            <div id="aem-step-screenshot" class="aem-step">
              <span class="aem-step-icon">&#9675;</span>
              <span>Screenshot captured</span>
            </div>
            <div id="aem-step-html" class="aem-step">
              <span class="aem-step-icon">&#9675;</span>
              <span>HTML extracted</span>
            </div>
            <div id="aem-step-generate" class="aem-step">
              <span class="aem-step-icon">&#9675;</span>
              <span>Generating with Claude...</span>
            </div>
            <div id="aem-step-preview" class="aem-step">
              <span class="aem-step-icon">&#9675;</span>
              <span>Creating preview</span>
            </div>
          </div>
        </div>

        <!-- Preview View -->
        <div id="aem-view-preview" class="aem-view aem-hidden">
          <div class="aem-preview-header">
            <span>Block:</span>
            <strong id="aem-preview-name">block</strong>
          </div>

          <div class="aem-preview-url">
            <label>Preview:</label>
            <a id="aem-preview-link" href="#" target="_blank" class="aem-preview-link">
              <span id="aem-preview-url-text">-</span> &#8599;
            </a>
          </div>

          <div class="aem-code-section">
            <div class="aem-code-tabs">
              <button class="aem-code-tab active" data-tab="js">JS</button>
              <button class="aem-code-tab" data-tab="css">CSS</button>
              <button class="aem-code-tab" data-tab="html">HTML</button>
              <button id="aem-copy-code" class="aem-icon-btn" title="Copy">&#128203;</button>
            </div>
            <pre id="aem-code-content" class="aem-code-content"></pre>
          </div>

          <div class="aem-preview-actions">
            <button id="aem-reject-block" class="aem-btn aem-btn-secondary">&#10007; Reject</button>
            <button id="aem-accept-block" class="aem-btn aem-btn-primary">&#10003; Accept</button>
          </div>
        </div>

        <!-- Page Import View -->
        <div id="aem-view-page-import" class="aem-view aem-hidden">
          <div class="aem-page-import-header">
            Importing: <span id="aem-import-page-path">/</span>
          </div>

          <div class="aem-section-list-container">
            <label>Sections (<span id="aem-section-count">0</span>):</label>
            <div id="aem-section-list" class="aem-section-list">
              <div class="aem-empty-sections">Click "Add Section" to select elements</div>
            </div>
          </div>

          <button id="aem-add-section-btn" class="aem-btn aem-btn-secondary aem-btn-full">+ Add Section</button>

          <div id="aem-section-editor" class="aem-section-editor aem-hidden">
            <h3>Configure Section</h3>
            <div class="aem-form-group">
              <label>Section Name</label>
              <input type="text" id="aem-section-name" placeholder="e.g., Hero Banner">
            </div>
            <div class="aem-form-group">
              <label>Block Type</label>
              <input type="text" id="aem-section-type" placeholder="e.g., hero, cards">
            </div>
            <div class="aem-form-group">
              <label>Use Block:</label>
              <div id="aem-block-options" class="aem-block-options"></div>
            </div>
            <div class="aem-editor-actions">
              <button id="aem-cancel-section-edit" class="aem-btn aem-btn-secondary">Cancel</button>
              <button id="aem-save-section" class="aem-btn aem-btn-primary">Save</button>
            </div>
          </div>
        </div>

        <!-- Design Import View -->
        <div id="aem-view-design-import" class="aem-view aem-hidden">
          <div id="aem-design-status" class="aem-design-status">Extracting design tokens...</div>
          <div class="aem-spinner"></div>

          <div id="aem-design-tokens" class="aem-design-tokens aem-hidden">
            <div class="aem-token-section">
              <label>Colors</label>
              <div id="aem-token-colors" class="aem-token-list"></div>
            </div>
            <div class="aem-token-section">
              <label>Fonts</label>
              <div id="aem-token-fonts" class="aem-token-list"></div>
            </div>
          </div>

          <div id="aem-design-preview" class="aem-preview-url aem-hidden">
            <label>Style Guide:</label>
            <a id="aem-design-preview-link" href="#" target="_blank" class="aem-preview-link">
              <span id="aem-design-preview-url">-</span> &#8599;
            </a>
          </div>

          <div id="aem-design-actions" class="aem-preview-actions aem-hidden">
            <button id="aem-reject-design" class="aem-btn aem-btn-secondary">&#10007; Reject</button>
            <button id="aem-accept-design" class="aem-btn aem-btn-primary">&#10003; Merge</button>
          </div>
        </div>

        <!-- Multi-Block Generation View -->
        <div id="aem-view-multi-generating" class="aem-view aem-hidden">
          <div class="aem-multi-header">
            <span>Generating <strong id="aem-multi-count">0</strong> blocks</span>
            <small id="aem-multi-status">(select elements on page)</small>
          </div>
          <div id="aem-multi-accordion" class="aem-multi-accordion">
            <div class="aem-multi-empty">Click elements on the page to start generating blocks</div>
          </div>
          <button id="aem-multi-done-btn" class="aem-btn aem-btn-secondary aem-btn-full">Done Selecting</button>
        </div>
      </div>

      <!-- Footer -->
      <div class="aem-sidebar-footer" id="aem-sidebar-footer">
        <button id="aem-settings-btn" class="aem-btn aem-btn-secondary">&#9881; Settings</button>
        <button id="aem-footer-action" class="aem-btn aem-btn-primary aem-hidden">Action</button>
      </div>
    `;

    document.body.appendChild(sidebar);
    attachEventListeners();
  }

  function attachEventListeners() {
    // Header
    sidebar.querySelector('.aem-sidebar-close').addEventListener('click', hide);
    sidebar.querySelector('.aem-sidebar-toggle').addEventListener('click', toggleCollapse);

    // Setup
    sidebar.querySelector('#aem-save-config').addEventListener('click', handleSaveConfig);

    // Dashboard
    sidebar.querySelector('#aem-select-blocks-btn').addEventListener('click', startMultiSelection);

    // Multi-block generation
    sidebar.querySelector('#aem-multi-done-btn').addEventListener('click', cancelMultiSelection);

    // Selection
    sidebar.querySelector('#aem-cancel-selection').addEventListener('click', cancelSelection);

    // Preview
    sidebar.querySelector('#aem-accept-block').addEventListener('click', handleAcceptBlock);
    sidebar.querySelector('#aem-reject-block').addEventListener('click', handleRejectBlock);
    sidebar.querySelector('#aem-copy-code').addEventListener('click', copyCode);
    sidebar.querySelectorAll('.aem-code-tab').forEach(tab => {
      tab.addEventListener('click', () => switchCodeTab(tab.dataset.tab));
    });

    // Page Import
    sidebar.querySelector('#aem-add-section-btn').addEventListener('click', () => startSelection('section'));
    sidebar.querySelector('#aem-save-section').addEventListener('click', saveSection);
    sidebar.querySelector('#aem-cancel-section-edit').addEventListener('click', cancelSectionEdit);

    // Design Import
    sidebar.querySelector('#aem-accept-design').addEventListener('click', handleAcceptDesign);
    sidebar.querySelector('#aem-reject-design').addEventListener('click', handleRejectDesign);

    // Footer
    sidebar.querySelector('#aem-settings-btn').addEventListener('click', () => showView(VIEWS.SETUP));
  }

  // ============ View Management ============

  function showView(viewId) {
    state.currentView = viewId;

    // Hide all views
    sidebar.querySelectorAll('.aem-view').forEach(v => v.classList.add('aem-hidden'));

    // Show requested view
    const view = sidebar.querySelector(`#aem-view-${viewId}`);
    if (view) view.classList.remove('aem-hidden');

    // Update footer based on view
    updateFooter(viewId);
  }

  function updateFooter(viewId) {
    const footer = sidebar.querySelector('#aem-sidebar-footer');
    const settingsBtn = sidebar.querySelector('#aem-settings-btn');
    const actionBtn = sidebar.querySelector('#aem-footer-action');

    settingsBtn.classList.toggle('aem-hidden', viewId === VIEWS.SETUP);

    if (viewId === VIEWS.PAGE_IMPORT) {
      actionBtn.textContent = 'Finish Import';
      actionBtn.classList.remove('aem-hidden');
      actionBtn.onclick = finishPageImport;
      actionBtn.disabled = !state.pageImport?.sections?.length;
    } else if (viewId === VIEWS.PAGE_IMPORT && state.pageImport?.sections?.length) {
      actionBtn.classList.remove('aem-hidden');
    } else {
      actionBtn.classList.add('aem-hidden');
    }
  }

  // ============ Initialize ============

  async function initialize() {
    state.config = await getConfig();
    const savedState = await getState();

    // Check for pending operations
    if (savedState.status === 'generating') {
      showView(VIEWS.GENERATING);
      updateProgress(savedState.progress || {});
    } else if (savedState.status === 'preview') {
      state.previewData = savedState.previewData;
      state.sessionId = savedState.sessionId;
      showView(VIEWS.PREVIEW);
      displayPreview(savedState.previewData);
    } else if (savedState.status === 'page-import') {
      state.pageImport = savedState.pageImport;
      showView(VIEWS.PAGE_IMPORT);
      updatePageImportUI();
      // Auto-continue if there are sections to process
      if (state.pageImport?.blockGenerationQueue?.length > 0) {
        processNextBlock();
      }
    } else if (state.config.githubRepo) {
      showView(VIEWS.DASHBOARD);
      updateDashboard();
    } else {
      showView(VIEWS.SETUP);
    }
  }

  function show() {
    if (!sidebar) {
      createSidebar();
    }
    sidebar.classList.add('aem-visible');
    document.body.classList.add('aem-sidebar-open');
    initialize();
  }

  function hide() {
    if (sidebar) {
      sidebar.classList.remove('aem-visible');
      document.body.classList.remove('aem-sidebar-open');
    }
    cancelSelection();
  }

  function toggleCollapse() {
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.toggle('aem-collapsed');
    const toggleBtn = sidebar.querySelector('.aem-sidebar-toggle');

    if (toggleBtn) {
      toggleBtn.innerHTML = isCollapsed ? '▼' : '▲';
      toggleBtn.title = isCollapsed ? 'Expand' : 'Collapse';
    }
  }

  // ============ Setup ============

  async function handleSaveConfig() {
    const input = sidebar.querySelector('#aem-github-repo').value.trim();
    const statusEl = sidebar.querySelector('#aem-setup-status');

    if (!input) {
      showStatus(statusEl, 'Please enter a GitHub repository', true);
      return;
    }

    // Parse repo
    const urlMatch = input.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
    let owner, repo;

    if (urlMatch) {
      owner = urlMatch[1];
      repo = urlMatch[2].replace(/\.git$/, '');
    } else {
      const parts = input.split('/');
      if (parts.length === 2) {
        [owner, repo] = parts;
      }
    }

    if (!owner || !repo) {
      showStatus(statusEl, 'Invalid format. Use owner/repo or GitHub URL', true);
      return;
    }

    showStatus(statusEl, 'Connecting...', false);

    await saveConfig({
      githubRepo: `${owner}/${repo}`,
      daOrg: owner,
      daSite: repo,
    });

    showStatus(statusEl, 'Connected!', false);

    setTimeout(() => {
      showView(VIEWS.DASHBOARD);
      updateDashboard();
    }, 500);
  }

  function showStatus(el, message, isError) {
    el.textContent = message;
    el.className = `aem-status ${isError ? 'aem-error' : 'aem-success'}`;
    el.classList.remove('aem-hidden');
  }

  // ============ Dashboard ============

  function updateDashboard() {
    const urlEl = sidebar.querySelector('#aem-current-url');
    try {
      const url = new URL(window.location.href);
      urlEl.textContent = url.hostname + url.pathname;
    } catch {
      urlEl.textContent = window.location.href;
    }
  }

  async function loadBlockLibrary() {
    if (!state.config.githubRepo) return;

    const listEl = sidebar.querySelector('#aem-block-list');
    const countEl = sidebar.querySelector('#aem-block-count');

    listEl.innerHTML = '<div class="aem-empty-library">Loading...</div>';

    try {
      const response = await sendMessage({ type: 'GET_BLOCKS' });
      const blocks = response?.blocks || [];

      countEl.textContent = blocks.length;
      state.existingBlocks = blocks;

      if (blocks.length === 0) {
        listEl.innerHTML = '<div class="aem-empty-library">No blocks yet</div>';
      } else {
        listEl.innerHTML = blocks.map(b =>
          `<div class="aem-block-item">${b.name}</div>`
        ).join('');
      }
    } catch (error) {
      listEl.innerHTML = '<div class="aem-empty-library">Failed to load</div>';
    }
  }

  // ============ Element Selection ============

  function startSelection(mode) {
    state.selectionMode = mode;
    state.isSelecting = true;

    if (mode === 'section') {
      // Stay on page import view but show selection active state
      sidebar.querySelector('#aem-add-section-btn').textContent = 'Click an element...';
      sidebar.querySelector('#aem-add-section-btn').disabled = true;
    } else {
      showView(VIEWS.SELECTION);
    }

    createSelectionOverlay();
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
  }

  function cancelSelection() {
    state.isSelecting = false;
    altKeyPressed = false;

    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('keyup', handleKeyUp, true);

    if (overlay) { overlay.remove(); overlay = null; }
    if (tooltip) { tooltip.remove(); tooltip = null; }
    currentElement = null;

    // Reset UI
    const addBtn = sidebar?.querySelector('#aem-add-section-btn');
    if (addBtn) {
      addBtn.textContent = '+ Add Section';
      addBtn.disabled = false;
    }

    if (state.selectionMode === 'block' && state.currentView === VIEWS.SELECTION) {
      showView(VIEWS.DASHBOARD);
    }
  }

  function createSelectionOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'aem-selection-overlay';
    document.body.appendChild(overlay);

    tooltip = document.createElement('div');
    tooltip.className = 'aem-selection-tooltip';
    document.body.appendChild(tooltip);
  }

  function handleMouseMove(event) {
    if (!state.isSelecting) return;

    // Track mouse position for key events
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    // Track Alt key state
    altKeyPressed = event.altKey;

    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || shouldIgnoreElement(element)) {
      hideSelectionOverlay();
      currentElement = null;
      return;
    }

    // Default: select exact element. Hold Alt to find parent container.
    const targetElement = altKeyPressed ? findBestElement(element) : element;
    if (targetElement !== currentElement) {
      currentElement = targetElement;
      updateSelectionOverlay(currentElement);
    }
  }

  function handleClick(event) {
    if (!state.isSelecting || !currentElement) return;
    if (sidebar.contains(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    selectElement(currentElement);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape' && state.isSelecting) {
      cancelSelection();
    }
    // Update selection when Alt is pressed
    if (event.key === 'Alt' && state.isSelecting) {
      altKeyPressed = true;
      // Re-evaluate current element with smart selection
      const element = document.elementFromPoint(lastMouseX, lastMouseY);
      if (element && !shouldIgnoreElement(element)) {
        currentElement = findBestElement(element);
        updateSelectionOverlay(currentElement);
      }
    }
  }

  function handleKeyUp(event) {
    // Update selection when Alt is released
    if (event.key === 'Alt' && state.isSelecting) {
      altKeyPressed = false;
      // Re-evaluate current element with exact selection
      const element = document.elementFromPoint(lastMouseX, lastMouseY);
      if (element && !shouldIgnoreElement(element)) {
        currentElement = element;
        updateSelectionOverlay(currentElement);
      }
    }
  }

  async function selectElement(element) {
    const rect = element.getBoundingClientRect();
    const scrollY = window.scrollY;

    const elementData = {
      html: element.outerHTML.substring(0, 10000),
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      yStart: Math.round(rect.top + scrollY),
      yEnd: Math.round(rect.bottom + scrollY),
      description: getElementDescription(element),
    };

    cancelSelection();

    if (state.selectionMode === 'section') {
      // Add section to page import
      addSection(elementData);
    } else {
      // Start block generation
      await startBlockGeneration(elementData);
    }
  }

  // ============ Block Generation ============

  async function startBlockGeneration(elementData) {
    showView(VIEWS.GENERATING);
    updateProgress({ screenshot: 'active' });

    state.sessionId = generateSessionId();

    await saveState({
      status: 'generating',
      sessionId: state.sessionId,
      progress: { screenshot: 'active' },
    });

    try {
      // Capture screenshot
      updateProgress({ screenshot: 'complete', html: 'active' });

      const response = await sendMessage({
        type: 'GENERATE_BLOCK',
        url: window.location.href,
        elementData,
        sessionId: state.sessionId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Generation failed');
      }

      // Show preview
      state.previewData = response;
      await saveState({
        status: 'preview',
        sessionId: state.sessionId,
        previewData: response,
      });

      showView(VIEWS.PREVIEW);
      displayPreview(response);

    } catch (error) {
      console.error('Block generation failed:', error);
      showView(VIEWS.DASHBOARD);
      alert('Block generation failed: ' + error.message);
      await clearState();
    }
  }

  function updateProgress(progress) {
    const steps = ['screenshot', 'html', 'generate', 'preview'];
    let completed = 0;

    steps.forEach(step => {
      const el = sidebar.querySelector(`#aem-step-${step}`);
      if (!el) return;

      const icon = el.querySelector('.aem-step-icon');

      if (progress[step] === 'complete') {
        el.classList.add('aem-complete');
        el.classList.remove('aem-active');
        icon.textContent = '✓';
        completed++;
      } else if (progress[step] === 'active') {
        el.classList.add('aem-active');
        el.classList.remove('aem-complete');
        icon.textContent = '●';
      } else {
        el.classList.remove('aem-active', 'aem-complete');
        icon.textContent = '○';
      }
    });

    const percent = Math.round((completed / steps.length) * 100);
    sidebar.querySelector('#aem-progress-fill').style.width = `${percent}%`;
    sidebar.querySelector('#aem-progress-percent').textContent = percent;

    if (progress.blockName) {
      sidebar.querySelector('#aem-generating-name').textContent = progress.blockName;
    }
  }

  // ============ Preview ============

  function displayPreview(data) {
    sidebar.querySelector('#aem-preview-name').textContent = data.blockName || 'block';
    sidebar.querySelector('#aem-preview-url-text').textContent = data.previewUrl || '-';
    sidebar.querySelector('#aem-preview-link').href = data.previewUrl || '#';

    state.currentCode = {
      html: data.html || '',
      css: data.css || '',
      js: data.js || '',
    };

    updateCodeDisplay();
  }

  function switchCodeTab(tab) {
    state.currentCodeTab = tab;
    sidebar.querySelectorAll('.aem-code-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    updateCodeDisplay();
  }

  function updateCodeDisplay() {
    const code = state.currentCode[state.currentCodeTab] || '// No code';
    sidebar.querySelector('#aem-code-content').textContent = code;
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(state.currentCode[state.currentCodeTab]);
      const btn = sidebar.querySelector('#aem-copy-code');
      btn.textContent = '✓';
      setTimeout(() => btn.textContent = '📋', 1500);
    } catch (e) {
      alert('Failed to copy');
    }
  }

  async function handleAcceptBlock() {
    // Skip if in page import mode - acceptPageImportBlock handles it
    if (state.pageImport?.blockGenerationQueue) {
      return;
    }

    const btn = sidebar.querySelector('#aem-accept-block');
    btn.disabled = true;
    btn.textContent = 'Merging...';

    try {
      const response = await sendMessage({
        type: 'ACCEPT_BLOCK',
        sessionId: state.sessionId,
        blockName: state.previewData?.blockName,
        branch: state.previewData?.branch,
      });

      if (response.success) {
        await clearState();
        showView(VIEWS.DASHBOARD);
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      alert('Failed to accept: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Accept';
    }
  }

  async function handleRejectBlock() {
    // Skip if in page import mode - page import has its own reject logic
    if (state.pageImport?.blockGenerationQueue) {
      return;
    }

    await sendMessage({ type: 'REJECT_BLOCK', sessionId: state.sessionId });
    await clearState();
    showView(VIEWS.DASHBOARD);
  }

  // ============ Page Import ============

  function startPageImport() {
    state.pageImport = {
      url: window.location.href,
      pageTitle: document.title || window.location.pathname.split('/').pop(),
      sections: [],
      acceptedBlocks: {},
      currentBlockIndex: 0,
    };

    showView(VIEWS.PAGE_IMPORT);
    updatePageImportUI();
  }

  function updatePageImportUI() {
    const pathEl = sidebar.querySelector('#aem-import-page-path');
    const listEl = sidebar.querySelector('#aem-section-list');
    const countEl = sidebar.querySelector('#aem-section-count');
    const actionBtn = sidebar.querySelector('#aem-footer-action');

    pathEl.textContent = new URL(state.pageImport.url).pathname;
    countEl.textContent = state.pageImport.sections.length;

    if (state.pageImport.sections.length === 0) {
      listEl.innerHTML = '<div class="aem-empty-sections">Click "Add Section" to select elements</div>';
      actionBtn.disabled = true;
    } else {
      listEl.innerHTML = state.pageImport.sections.map((s, i) => `
        <div class="aem-section-item" data-index="${i}">
          <div class="aem-section-info">
            <span class="aem-section-name">${s.name || `Section ${i + 1}`}</span>
            <span class="aem-section-type">${s.blockChoice === '__generate__' ? 'Generate new' : s.blockChoice}</span>
          </div>
          <div class="aem-section-actions">
            <button class="aem-icon-btn aem-edit-section" data-index="${i}">&#9998;</button>
            <button class="aem-icon-btn aem-remove-section" data-index="${i}">&times;</button>
          </div>
        </div>
      `).join('');

      // Attach listeners
      listEl.querySelectorAll('.aem-edit-section').forEach(btn => {
        btn.addEventListener('click', () => editSection(parseInt(btn.dataset.index)));
      });
      listEl.querySelectorAll('.aem-remove-section').forEach(btn => {
        btn.addEventListener('click', () => removeSection(parseInt(btn.dataset.index)));
      });

      actionBtn.disabled = false;
    }

    actionBtn.classList.remove('aem-hidden');
    actionBtn.textContent = 'Finish Import';
    actionBtn.onclick = finishPageImport;
  }

  function addSection(elementData) {
    const section = {
      name: '',
      type: '',
      description: elementData.description,
      html: elementData.html,
      yStart: elementData.yStart,
      yEnd: elementData.yEnd,
      blockChoice: '__generate__',
    };

    state.pageImport.sections.push(section);
    state.pageImport.editingIndex = state.pageImport.sections.length - 1;

    updatePageImportUI();
    showSectionEditor(state.pageImport.editingIndex);
  }

  function showSectionEditor(index) {
    const section = state.pageImport.sections[index];
    state.pageImport.editingIndex = index;

    sidebar.querySelector('#aem-section-name').value = section.name || '';
    sidebar.querySelector('#aem-section-type').value = section.type || '';

    // Populate block options
    const optionsEl = sidebar.querySelector('#aem-block-options');
    let html = (state.existingBlocks || []).map(b => `
      <label class="aem-block-option">
        <input type="radio" name="aem-block-choice" value="${b.name}" ${section.blockChoice === b.name ? 'checked' : ''}>
        <span>${b.name}</span>
      </label>
    `).join('');

    html += `
      <label class="aem-block-option">
        <input type="radio" name="aem-block-choice" value="__generate__" ${section.blockChoice === '__generate__' ? 'checked' : ''}>
        <span>Generate new block</span>
      </label>
    `;

    optionsEl.innerHTML = html;

    sidebar.querySelector('#aem-section-editor').classList.remove('aem-hidden');
    sidebar.querySelector('#aem-add-section-btn').classList.add('aem-hidden');
  }

  function hideSectionEditor() {
    sidebar.querySelector('#aem-section-editor').classList.add('aem-hidden');
    sidebar.querySelector('#aem-add-section-btn').classList.remove('aem-hidden');
    state.pageImport.editingIndex = null;
  }

  function saveSection() {
    const index = state.pageImport.editingIndex;
    if (index === null) return;

    const section = state.pageImport.sections[index];
    section.name = sidebar.querySelector('#aem-section-name').value.trim() || `Section ${index + 1}`;
    section.type = sidebar.querySelector('#aem-section-type').value.trim();

    const selected = sidebar.querySelector('input[name="aem-block-choice"]:checked');
    section.blockChoice = selected?.value || '__generate__';

    hideSectionEditor();
    updatePageImportUI();
    savePageImportState();
  }

  function cancelSectionEdit() {
    const index = state.pageImport.editingIndex;
    // Remove if new and unnamed
    if (index !== null && !state.pageImport.sections[index].name) {
      state.pageImport.sections.splice(index, 1);
    }
    hideSectionEditor();
    updatePageImportUI();
  }

  function editSection(index) {
    showSectionEditor(index);
  }

  function removeSection(index) {
    state.pageImport.sections.splice(index, 1);
    updatePageImportUI();
    savePageImportState();
  }

  async function savePageImportState() {
    await saveState({
      status: 'page-import',
      pageImport: state.pageImport,
    });
  }

  async function finishPageImport() {
    if (!state.pageImport?.sections?.length) return;

    console.log('[PageImport] finishPageImport called');
    console.log('[PageImport] sections:', state.pageImport.sections.map(s => ({
      name: s.name,
      blockChoice: s.blockChoice,
    })));

    // Find sections needing generation
    const toGenerate = state.pageImport.sections
      .map((s, i) => ({ index: i, section: s }))
      .filter(x => x.section.blockChoice === '__generate__');

    console.log('[PageImport] toGenerate queue:', toGenerate.length, 'blocks');

    if (toGenerate.length > 0) {
      state.pageImport.blockGenerationQueue = toGenerate;
      state.pageImport.currentBlockIndex = 0;
      await savePageImportState();
      processNextBlock();
    } else {
      composePage();
    }
  }

  async function processNextBlock() {
    const queue = state.pageImport.blockGenerationQueue;
    const idx = state.pageImport.currentBlockIndex;

    console.log('[PageImport] processNextBlock - idx:', idx, 'queue length:', queue?.length);

    if (idx >= queue.length) {
      console.log('[PageImport] All blocks done, calling composePage()');
      composePage();
      return;
    }

    const { index, section } = queue[idx];
    const total = queue.length;
    console.log('[PageImport] Processing block', idx + 1, 'of', total, '- section:', section.name);

    showView(VIEWS.GENERATING);
    sidebar.querySelector('#aem-generating-name').textContent =
      `${section.name || `Section ${index + 1}`} (${idx + 1}/${total})`;
    updateProgress({ screenshot: 'active' });

    try {
      // Ensure description is never empty - use name or generic description as fallback
      const description = section.description || section.name || `Section ${index + 1} content`;

      // Retry logic for transient errors (503, 502, 429, etc.)
      const maxRetries = 3;
      let lastError = null;
      let response = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[PageImport] Generation attempt ${attempt}/${maxRetries} for ${section.name}`);

          response = await sendMessage({
            type: 'GENERATE_BLOCK_FOR_SECTION',
            url: state.pageImport.url,
            section: {
              name: section.name || `section-${index + 1}`,
              type: section.type,
              description: description,
              html: section.html,
              yStart: section.yStart,
              yEnd: section.yEnd,
            },
            sectionIndex: index,
          });

          if (response.success) {
            break; // Success, exit retry loop
          }

          // Check if error is retryable
          const errorMsg = response.error || '';
          const isRetryable = /503|502|429|timeout|overloaded|unavailable/i.test(errorMsg);

          if (!isRetryable || attempt === maxRetries) {
            throw new Error(response.error);
          }

          console.log(`[PageImport] Retryable error: ${errorMsg}, waiting before retry...`);
          lastError = new Error(errorMsg);

          // Wait before retry (exponential backoff: 2s, 4s, 8s)
          const waitTime = Math.pow(2, attempt) * 1000;
          sidebar.querySelector('#aem-generating-name').textContent =
            `${section.name} - Retrying in ${waitTime/1000}s... (${attempt}/${maxRetries})`;
          await new Promise(r => setTimeout(r, waitTime));

        } catch (innerError) {
          const errorMsg = innerError.message || '';
          const isRetryable = /503|502|429|timeout|overloaded|unavailable/i.test(errorMsg);

          if (!isRetryable || attempt === maxRetries) {
            throw innerError;
          }

          console.log(`[PageImport] Retryable error: ${errorMsg}, waiting before retry...`);
          lastError = innerError;

          const waitTime = Math.pow(2, attempt) * 1000;
          sidebar.querySelector('#aem-generating-name').textContent =
            `${section.name} - Retrying in ${waitTime/1000}s... (${attempt}/${maxRetries})`;
          await new Promise(r => setTimeout(r, waitTime));
        }
      }

      if (!response?.success) throw lastError || new Error('Generation failed after retries');

      // Show preview for accept/reject
      state.previewData = response;
      state.pageImport.currentBlockResponse = response;

      showView(VIEWS.PREVIEW);
      displayPreview(response);

      // Override buttons for page import flow
      const acceptBtn = sidebar.querySelector('#aem-accept-block');
      const rejectBtn = sidebar.querySelector('#aem-reject-block');

      acceptBtn.textContent = '✓ Accept & Continue';
      acceptBtn.onclick = acceptPageImportBlock;

      rejectBtn.textContent = '↻ Regenerate';
      rejectBtn.onclick = () => processNextBlock();

    } catch (error) {
      console.error('Block generation failed:', error);

      // Show error with option to skip or retry
      const shouldSkip = confirm(
        `Block generation failed: ${error.message}\n\n` +
        `Click OK to SKIP this section and continue.\n` +
        `Click Cancel to RETRY.`
      );

      if (shouldSkip) {
        // Skip this block and move to next
        console.log('[PageImport] Skipping failed block:', section.name);
        state.pageImport.currentBlockIndex++;
        await savePageImportState();
        processNextBlock();
      }
      // If cancel, user can manually click Regenerate
    }
  }

  async function acceptPageImportBlock() {
    const response = state.pageImport.currentBlockResponse;
    const queue = state.pageImport.blockGenerationQueue;
    const idx = state.pageImport.currentBlockIndex;
    const { index } = queue[idx];

    console.log('[PageImport] acceptPageImportBlock - accepting block', idx + 1, 'blockName:', response.blockName);

    // Store accepted block
    state.pageImport.acceptedBlocks[index] = {
      blockName: response.blockName,
      branch: response.branch,
      sessionId: response.sessionId,
    };

    // Move to next
    state.pageImport.currentBlockIndex++;
    console.log('[PageImport] Moving to next block, new index:', state.pageImport.currentBlockIndex);
    await savePageImportState();

    processNextBlock();
  }

  async function composePage() {
    showView(VIEWS.GENERATING);
    sidebar.querySelector('#aem-generating-name').textContent = 'Composing page...';
    updateProgress({ screenshot: 'complete', html: 'complete', generate: 'active' });

    try {
      const response = await sendMessage({
        type: 'COMPOSE_PAGE',
        url: state.pageImport.url,
        sections: state.pageImport.sections.map((s, i) => ({
          name: s.name,
          type: s.type,
          description: s.description,
          yStart: s.yStart,
          yEnd: s.yEnd,
          blockChoice: state.pageImport.acceptedBlocks[i]?.blockName || s.blockChoice,
          acceptedBlock: state.pageImport.acceptedBlocks[i] || null,
        })),
        pageTitle: state.pageImport.pageTitle,
        acceptedBlocks: state.pageImport.acceptedBlocks,
      });

      if (!response.success) throw new Error(response.error);

      // Show final preview
      updateProgress({ screenshot: 'complete', html: 'complete', generate: 'complete', preview: 'complete' });

      state.previewData = response;
      state.pageImport.branch = response.branch;

      showView(VIEWS.PREVIEW);
      sidebar.querySelector('#aem-preview-name').textContent = 'Imported Page';
      sidebar.querySelector('#aem-preview-url-text').textContent = response.previewUrl || '-';
      sidebar.querySelector('#aem-preview-link').href = response.previewUrl || '#';

      // Hide code section for page
      sidebar.querySelector('.aem-code-section').classList.add('aem-hidden');

      // Override buttons for page finalize
      const acceptBtn = sidebar.querySelector('#aem-accept-block');
      const rejectBtn = sidebar.querySelector('#aem-reject-block');

      acceptBtn.textContent = '✓ Merge to Main';
      acceptBtn.onclick = finalizePageImport;

      rejectBtn.textContent = '✗ Reject';
      rejectBtn.onclick = rejectPageImport;

    } catch (error) {
      console.error('Page composition failed:', error);
      alert('Failed: ' + error.message);
      showView(VIEWS.DASHBOARD);
    }
  }

  async function finalizePageImport() {
    const btn = sidebar.querySelector('#aem-accept-block');
    btn.disabled = true;
    btn.textContent = 'Merging...';

    try {
      const response = await sendMessage({
        type: 'FINALIZE_PAGE',
        branch: state.pageImport.branch,
      });

      if (response.success) {
        await clearState();
        state.pageImport = null;
        sidebar.querySelector('.aem-code-section').classList.remove('aem-hidden');
        showView(VIEWS.DASHBOARD);
        alert('Page imported successfully!');
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      alert('Failed to merge: ' + error.message);
      btn.disabled = false;
      btn.textContent = '✓ Merge to Main';
    }
  }

  async function rejectPageImport() {
    await sendMessage({ type: 'REJECT_PAGE', branch: state.pageImport.branch });
    await clearState();
    state.pageImport = null;
    sidebar.querySelector('.aem-code-section').classList.remove('aem-hidden');
    showView(VIEWS.DASHBOARD);
  }

  // ============ Design Import ============

  async function startDesignImport() {
    showView(VIEWS.DESIGN_IMPORT);

    sidebar.querySelector('#aem-design-status').textContent = 'Extracting design tokens...';
    sidebar.querySelector('.aem-spinner').style.display = 'block';
    sidebar.querySelector('#aem-design-tokens').classList.add('aem-hidden');
    sidebar.querySelector('#aem-design-preview').classList.add('aem-hidden');
    sidebar.querySelector('#aem-design-actions').classList.add('aem-hidden');

    try {
      const response = await sendMessage({
        type: 'IMPORT_DESIGN_SYSTEM',
        url: window.location.href,
      });

      if (!response.success) throw new Error(response.error);

      state.designImport = response;
      displayDesignTokens(response);

    } catch (error) {
      sidebar.querySelector('.aem-spinner').style.display = 'none';
      sidebar.querySelector('#aem-design-status').textContent = 'Error: ' + error.message;
    }
  }

  function displayDesignTokens(data) {
    sidebar.querySelector('.aem-spinner').style.display = 'none';
    sidebar.querySelector('#aem-design-status').textContent = 'Design system extracted!';

    const colorsEl = sidebar.querySelector('#aem-token-colors');
    const fontsEl = sidebar.querySelector('#aem-token-fonts');

    if (data.tokens?.colors) {
      colorsEl.innerHTML = data.tokens.colors.slice(0, 8).map(c => `
        <div class="aem-token-item">
          <span class="aem-token-color" style="background: ${c.value}"></span>
          <span>${c.name || c.value}</span>
        </div>
      `).join('');
    }

    if (data.tokens?.fonts) {
      fontsEl.innerHTML = data.tokens.fonts.slice(0, 4).map(f => `
        <div class="aem-token-item">${f.name || f.value}</div>
      `).join('');
    }

    sidebar.querySelector('#aem-design-tokens').classList.remove('aem-hidden');

    if (data.styleGuideUrl) {
      sidebar.querySelector('#aem-design-preview-url').textContent = data.styleGuideUrl;
      sidebar.querySelector('#aem-design-preview-link').href = data.styleGuideUrl;
      sidebar.querySelector('#aem-design-preview').classList.remove('aem-hidden');
    }

    sidebar.querySelector('#aem-design-actions').classList.remove('aem-hidden');
  }

  async function handleAcceptDesign() {
    const btn = sidebar.querySelector('#aem-accept-design');
    btn.disabled = true;
    btn.textContent = 'Merging...';

    try {
      const response = await sendMessage({
        type: 'FINALIZE_DESIGN_SYSTEM',
        branch: state.designImport.branch,
      });

      if (response.success) {
        state.designImport = null;
        showView(VIEWS.DASHBOARD);
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Merge';
    }
  }

  async function handleRejectDesign() {
    if (state.designImport?.branch) {
      await sendMessage({ type: 'REJECT_DESIGN_SYSTEM', branch: state.designImport.branch });
    }
    state.designImport = null;
    showView(VIEWS.DASHBOARD);
  }

  // ============ Multi-Block Generation ============

  function startMultiSelection() {
    // Reset multi-block state
    state.multiBlockGeneration = {
      isSelecting: true,
      generations: {},
      generationOrder: [],
      queue: [],
      activeCount: 0,
    };

    // Show the multi-generating view
    showView(VIEWS.MULTI_GENERATING);
    renderMultiAccordion();

    // Start selection mode
    state.selectionMode = 'multi';
    state.isSelecting = true;
    createSelectionOverlay();
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleMultiClick, true);
    document.addEventListener('keydown', handleMultiKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
  }

  function cancelMultiSelection() {
    state.multiBlockGeneration.isSelecting = false;
    state.isSelecting = false;
    state.selectionMode = 'block';

    // Remove selection listeners
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleMultiClick, true);
    document.removeEventListener('keydown', handleMultiKeyDown, true);
    document.removeEventListener('keyup', handleKeyUp, true);

    if (overlay) { overlay.remove(); overlay = null; }
    if (tooltip) { tooltip.remove(); tooltip = null; }
    currentElement = null;

    // Update button text
    const doneBtn = sidebar.querySelector('#aem-multi-done-btn');
    if (doneBtn) {
      doneBtn.textContent = 'Back to Dashboard';
      doneBtn.onclick = () => {
        // Only go back if no active generations
        if (state.multiBlockGeneration.activeCount === 0) {
          showView(VIEWS.DASHBOARD);
        } else {
          doneBtn.textContent = 'Generations in progress...';
          setTimeout(() => {
            doneBtn.textContent = 'Back to Dashboard';
          }, 2000);
        }
      };
    }

    updateMultiStatus();
  }

  function handleMultiClick(event) {
    if (!state.isSelecting || !currentElement) return;
    if (sidebar.contains(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    // Get element data
    const rect = currentElement.getBoundingClientRect();
    const scrollY = window.scrollY;

    const elementData = {
      html: currentElement.outerHTML.substring(0, 10000),
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      yStart: Math.round(rect.top + scrollY),
      yEnd: Math.round(rect.bottom + scrollY),
      description: getElementDescription(currentElement),
    };

    // Add to generations and start processing
    handleMultiElementSelected(elementData);

    // Flash the overlay to show selection was recorded
    if (overlay) {
      overlay.style.background = 'rgba(22, 163, 74, 0.3)';
      overlay.style.borderColor = '#16a34a';
      setTimeout(() => {
        overlay.style.background = 'rgba(59, 130, 246, 0.2)';
        overlay.style.borderColor = '#3b82f6';
      }, 200);
    }
  }

  function handleMultiKeyDown(event) {
    if (event.key === 'Escape') {
      cancelMultiSelection();
    }
    if (event.key === 'Alt' && state.isSelecting) {
      altKeyPressed = true;
      const element = document.elementFromPoint(lastMouseX, lastMouseY);
      if (element && !shouldIgnoreElement(element)) {
        currentElement = findBestElement(element);
        updateSelectionOverlay(currentElement);
      }
    }
  }

  function handleMultiElementSelected(elementData) {
    // Generate unique ID for this generation
    const generationId = 'gen-' + generateSessionId();
    const sessionId = generateSessionId();

    // Create generation entry
    const generation = {
      id: generationId,
      sessionId,
      elementData,
      status: 'pending',
      progress: {},
      previewData: null,
      error: null,
      expanded: false,
    };

    // Add to state
    state.multiBlockGeneration.generations[generationId] = generation;
    state.multiBlockGeneration.generationOrder.push(generationId);

    // Check if we can start immediately or need to queue
    if (state.multiBlockGeneration.activeCount < MAX_PARALLEL_GENERATIONS) {
      processMultiBlockGeneration(generationId);
    } else {
      state.multiBlockGeneration.queue.push(generationId);
    }

    // Update UI
    renderMultiAccordion();
    updateMultiStatus();
  }

  async function processMultiBlockGeneration(generationId) {
    const generation = state.multiBlockGeneration.generations[generationId];
    if (!generation) return;

    // Mark as active
    generation.status = 'active';
    generation.progress = { screenshot: 'active' };
    state.multiBlockGeneration.activeCount++;

    // Remove from queue if present
    const queueIndex = state.multiBlockGeneration.queue.indexOf(generationId);
    if (queueIndex > -1) {
      state.multiBlockGeneration.queue.splice(queueIndex, 1);
    }

    renderMultiAccordion();

    try {
      // Update progress stages
      generation.progress = { screenshot: 'complete', html: 'active' };
      renderMultiAccordion();

      generation.progress = { screenshot: 'complete', html: 'complete', generate: 'active' };
      renderMultiAccordion();

      // Call the block generation API
      const response = await sendMessage({
        type: 'GENERATE_BLOCK',
        url: window.location.href,
        elementData: generation.elementData,
        sessionId: generation.sessionId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Generation failed');
      }

      // Check if cancelled while processing
      if (generation.status === 'rejected') {
        return; // Already cancelled, ignore result
      }

      // Update progress
      generation.progress = { screenshot: 'complete', html: 'complete', generate: 'complete', preview: 'complete' };
      generation.status = 'complete';
      generation.previewData = response;
      generation.expanded = true; // Auto-expand completed items

    } catch (error) {
      // Check if cancelled while processing
      if (generation.status === 'rejected') {
        return; // Already cancelled, ignore error
      }
      console.error(`Generation ${generationId} failed:`, error);
      generation.status = 'error';
      generation.error = error.message;
    }

    // Only decrement if not already decremented by cancel
    if (generation.status !== 'rejected') {
      state.multiBlockGeneration.activeCount--;
      processNextFromQueue();
    }

    renderMultiAccordion();
    updateMultiStatus();
  }

  function processNextFromQueue() {
    if (state.multiBlockGeneration.queue.length === 0) return;
    if (state.multiBlockGeneration.activeCount >= MAX_PARALLEL_GENERATIONS) return;

    const nextId = state.multiBlockGeneration.queue.shift();
    if (nextId) {
      processMultiBlockGeneration(nextId);
    }
  }

  function renderMultiAccordion() {
    const accordionEl = sidebar.querySelector('#aem-multi-accordion');
    const countEl = sidebar.querySelector('#aem-multi-count');

    if (!accordionEl) return;

    const order = state.multiBlockGeneration.generationOrder;
    countEl.textContent = order.length;

    if (order.length === 0) {
      accordionEl.innerHTML = '<div class="aem-multi-empty">Click elements on the page to start generating blocks</div>';
      return;
    }

    accordionEl.innerHTML = order.map(id => {
      const gen = state.multiBlockGeneration.generations[id];
      return renderAccordionItem(gen);
    }).join('');

    // Attach event listeners
    accordionEl.querySelectorAll('.aem-accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const id = header.dataset.id;
        toggleAccordionItem(id);
      });
    });

    accordionEl.querySelectorAll('.aem-multi-accept-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleMultiAcceptBlock(btn.dataset.id);
      });
    });

    accordionEl.querySelectorAll('.aem-multi-reject-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleMultiRejectBlock(btn.dataset.id);
      });
    });

    accordionEl.querySelectorAll('.aem-multi-retry-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRetryBlock(btn.dataset.id);
      });
    });

    accordionEl.querySelectorAll('.aem-multi-cancel-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleCancelBlock(btn.dataset.id);
      });
    });
  }

  function renderAccordionItem(gen) {
    const statusClass = `aem-status-${gen.status}`;
    const expandedClass = gen.expanded ? 'aem-expanded' : '';
    const badgeClass = `aem-badge-${gen.status}`;

    const badgeText = {
      pending: 'Queued',
      active: 'Generating',
      complete: 'Ready',
      error: 'Error',
      accepted: 'Accepted',
      rejected: 'Rejected',
    }[gen.status] || gen.status;

    // Determine title
    const title = gen.previewData?.blockName ||
                  gen.elementData?.description?.substring(0, 30) ||
                  `Block ${state.multiBlockGeneration.generationOrder.indexOf(gen.id) + 1}`;

    // Build content based on status
    let content = '';

    if (gen.status === 'active') {
      content = `
        <div class="aem-accordion-progress">
          ${renderProgressStep('screenshot', 'Screenshot', gen.progress)}
          ${renderProgressStep('html', 'Extract HTML', gen.progress)}
          ${renderProgressStep('generate', 'Generate with Claude', gen.progress)}
          ${renderProgressStep('preview', 'Create preview', gen.progress)}
        </div>
      `;
    } else if (gen.status === 'error') {
      content = `
        <div class="aem-accordion-error">${gen.error || 'Unknown error'}</div>
        <div class="aem-accordion-actions">
          <button class="aem-btn aem-btn-secondary aem-multi-retry-btn" data-id="${gen.id}">Retry</button>
        </div>
      `;
    } else if (gen.status === 'complete') {
      content = `
        <div class="aem-accordion-preview">
          <a href="${gen.previewData?.previewUrl || '#'}" target="_blank" class="aem-accordion-preview-url">
            ${gen.previewData?.previewUrl || 'Preview'} ↗
          </a>
        </div>
        <div class="aem-accordion-actions">
          <button class="aem-btn aem-btn-secondary aem-multi-reject-btn" data-id="${gen.id}">✗ Reject</button>
          <button class="aem-btn aem-btn-primary aem-multi-accept-btn" data-id="${gen.id}">✓ Accept</button>
        </div>
      `;
    } else if (gen.status === 'accepted') {
      content = `
        <div class="aem-accordion-preview">
          <span style="color: #16a34a;">✓ Block merged to main</span>
        </div>
      `;
    } else if (gen.status === 'rejected') {
      content = `
        <div class="aem-accordion-preview">
          <span style="color: #6b7280;">Block rejected</span>
        </div>
      `;
    } else if (gen.status === 'pending') {
      content = `
        <div style="padding: 8px; color: #64748b; font-size: 12px;">
          Waiting to start... (${state.multiBlockGeneration.queue.indexOf(gen.id) + 1} in queue)
        </div>
      `;
    }

    return `
      <div class="aem-accordion-item ${statusClass} ${expandedClass}">
        <div class="aem-accordion-header" data-id="${gen.id}">
          <span class="aem-accordion-chevron">▶</span>
          ${gen.status === 'active' ? '<div class="aem-accordion-spinner"></div>' : ''}
          <span class="aem-accordion-title">${escapeHtml(title)}</span>
          <span class="aem-accordion-badge ${badgeClass}">${badgeText}</span>
          ${['pending', 'active'].includes(gen.status) ? `<button class="aem-multi-cancel-btn" data-id="${gen.id}" title="Cancel">✕</button>` : ''}
        </div>
        <div class="aem-accordion-content">
          ${content}
        </div>
      </div>
    `;
  }

  function renderProgressStep(step, label, progress) {
    const status = progress[step];
    let icon = '○';
    let className = '';

    if (status === 'complete') {
      icon = '✓';
      className = 'aem-step-complete';
    } else if (status === 'active') {
      icon = '●';
      className = 'aem-step-active';
    }

    return `
      <div class="aem-accordion-step ${className}">
        <span class="aem-accordion-step-icon">${icon}</span>
        <span>${label}</span>
      </div>
    `;
  }

  function toggleAccordionItem(generationId) {
    const gen = state.multiBlockGeneration.generations[generationId];
    if (gen) {
      gen.expanded = !gen.expanded;
      renderMultiAccordion();
    }
  }

  function updateMultiStatus() {
    const statusEl = sidebar.querySelector('#aem-multi-status');
    if (!statusEl) return;

    const { activeCount, queue, generationOrder } = state.multiBlockGeneration;
    const total = generationOrder.length;
    const completed = generationOrder.filter(id =>
      ['complete', 'accepted', 'rejected', 'error'].includes(state.multiBlockGeneration.generations[id]?.status)
    ).length;

    if (state.multiBlockGeneration.isSelecting) {
      statusEl.textContent = `(${activeCount} running, ${queue.length} queued)`;
    } else if (activeCount > 0) {
      statusEl.textContent = `(${completed}/${total} complete)`;
    } else if (total > 0) {
      statusEl.textContent = '(all complete)';
    } else {
      statusEl.textContent = '(select elements on page)';
    }
  }

  async function handleMultiAcceptBlock(generationId) {
    const gen = state.multiBlockGeneration.generations[generationId];
    if (!gen || gen.status !== 'complete') return;

    const itemEl = sidebar.querySelector(`.aem-accordion-item[class*="${generationId}"]`);
    const btn = sidebar.querySelector(`.aem-multi-accept-btn[data-id="${generationId}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Merging...';
    }

    try {
      const response = await sendMessage({
        type: 'ACCEPT_BLOCK',
        sessionId: gen.sessionId,
        blockName: gen.previewData?.blockName,
        branch: gen.previewData?.branch,
      });

      if (response.success) {
        gen.status = 'accepted';
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      console.error('Accept failed:', error);
      alert('Failed to accept: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✓ Accept';
      }
      return;
    }

    renderMultiAccordion();
    updateMultiStatus();
  }

  async function handleMultiRejectBlock(generationId) {
    const gen = state.multiBlockGeneration.generations[generationId];
    if (!gen) return;

    await sendMessage({ type: 'REJECT_BLOCK', sessionId: gen.sessionId });
    gen.status = 'rejected';

    renderMultiAccordion();
    updateMultiStatus();
  }

  function handleCancelBlock(generationId) {
    const gen = state.multiBlockGeneration.generations[generationId];
    if (!gen || !['pending', 'active'].includes(gen.status)) return;

    // Remove from queue if pending
    const queueIndex = state.multiBlockGeneration.queue.indexOf(generationId);
    if (queueIndex > -1) {
      state.multiBlockGeneration.queue.splice(queueIndex, 1);
    }

    // If active, decrement count and process next
    if (gen.status === 'active') {
      state.multiBlockGeneration.activeCount--;
      processNextFromQueue();
    }

    // Mark as cancelled (treated like rejected)
    gen.status = 'rejected';
    gen.error = 'Cancelled by user';

    renderMultiAccordion();
    updateMultiStatus();
  }

  function handleRetryBlock(generationId) {
    const gen = state.multiBlockGeneration.generations[generationId];
    if (!gen || gen.status !== 'error') return;

    // Reset and retry
    gen.status = 'pending';
    gen.error = null;
    gen.progress = {};

    if (state.multiBlockGeneration.activeCount < MAX_PARALLEL_GENERATIONS) {
      processMultiBlockGeneration(generationId);
    } else {
      state.multiBlockGeneration.queue.push(generationId);
    }

    renderMultiAccordion();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============ Helpers ============

  function sendMessage(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, resolve);
    });
  }

  const IGNORED_TAGS = ['html', 'body', 'script', 'style', 'link', 'meta', 'head', 'noscript'];

  function shouldIgnoreElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    if (element.closest('#aem-importer-sidebar')) return true;
    if (element.classList.contains('aem-selection-overlay')) return true;
    if (element.classList.contains('aem-selection-tooltip')) return true;
    return IGNORED_TAGS.includes(element.tagName.toLowerCase());
  }

  function findBestElement(element) {
    const preferredTags = ['section', 'article', 'aside', 'main', 'header', 'footer', 'nav', 'div', 'form', 'figure'];
    const blockClasses = ['block', 'section', 'container', 'wrapper', 'component', 'card', 'hero', 'banner'];

    let current = element;
    let best = element;
    let depth = 0;

    while (current && depth < 10) {
      if (shouldIgnoreElement(current)) {
        current = current.parentElement;
        depth++;
        continue;
      }

      const hasBlockClass = current.classList &&
        Array.from(current.classList).some(c => blockClasses.some(bc => c.toLowerCase().includes(bc)));

      if (hasBlockClass || (preferredTags.includes(current.tagName.toLowerCase()) && current.tagName.toLowerCase() !== 'div')) {
        best = current;
      }

      current = current.parentElement;
      depth++;
    }

    return best;
  }

  function getElementDescription(element) {
    const h = element.querySelector('h1, h2, h3, h4, h5, h6');
    if (h) return h.textContent.trim().substring(0, 100);

    const p = element.querySelector('p');
    if (p) return p.textContent.trim().substring(0, 100);

    return `${element.tagName.toLowerCase()}${element.className ? '.' + element.className.split(' ')[0] : ''}`;
  }

  function updateSelectionOverlay(element) {
    if (!overlay || !element) return;

    const rect = element.getBoundingClientRect();
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = 'block';

    if (tooltip) {
      const tag = element.tagName.toLowerCase();
      const cls = element.classList.length > 0 ? `.${Array.from(element.classList).slice(0, 2).join('.')}` : '';
      tooltip.textContent = `${tag}${cls} (${Math.round(rect.width)}×${Math.round(rect.height)})`;
      tooltip.style.left = `${rect.left + window.scrollX}px`;
      tooltip.style.top = `${rect.top + window.scrollY - 28}px`;
      tooltip.style.display = 'block';
    }
  }

  function hideSelectionOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (tooltip) tooltip.style.display = 'none';
  }

  // ============ Message Listener ============

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'OPEN_SIDEBAR') {
      show();
      sendResponse({ success: true });
    } else if (message.type === 'GENERATION_PROGRESS') {
      updateProgress(message.progress);
    }
    return true;
  });

  // ============ Export ============

  window.__aemBlockImporterSidebar = { show, hide };

  console.log('AEM Block Importer: Full sidebar loaded');
})();
