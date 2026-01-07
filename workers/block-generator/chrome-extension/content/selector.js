/**
 * Element Selector for AEM Block Importer
 *
 * Provides visual element selection overlay for capturing blocks.
 * Supports two modes:
 * - 'block': Full block generation (default when injected)
 * - 'section': Section selection for page import
 */

(function () {
  'use strict';

  // State
  let isActive = false;
  let currentElement = null;
  let overlay = null;
  let tooltip = null;
  let selectionMode = 'block'; // 'block' or 'section'

  // Elements to ignore during selection
  const IGNORED_TAGS = ['html', 'body', 'script', 'style', 'link', 'meta', 'head', 'noscript'];
  const IGNORED_SELECTORS = [
    '.aem-block-importer-overlay',
    '.aem-block-importer-tooltip',
    '[class*="aem-block-importer"]',
  ];

  /**
   * Check if element should be ignored
   */
  function shouldIgnore(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    const tagName = element.tagName.toLowerCase();
    if (IGNORED_TAGS.includes(tagName)) {
      return true;
    }

    for (const selector of IGNORED_SELECTORS) {
      if (element.matches && element.matches(selector)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find best selectable ancestor
   * Prefers semantic block-level elements over inline/wrapper elements
   */
  function findBestElement(element) {
    // Block-level semantic elements that make good block boundaries
    const preferredTags = [
      'section',
      'article',
      'aside',
      'main',
      'header',
      'footer',
      'nav',
      'div',
      'form',
      'figure',
      'table',
      'ul',
      'ol',
    ];

    // Common wrapper classes that indicate a block
    const blockClasses = [
      'block',
      'section',
      'container',
      'wrapper',
      'component',
      'module',
      'card',
      'hero',
      'banner',
      'grid',
      'row',
    ];

    let current = element;
    let bestMatch = element;
    let depth = 0;
    const maxDepth = 10;

    while (current && depth < maxDepth) {
      if (shouldIgnore(current)) {
        current = current.parentElement;
        depth++;
        continue;
      }

      const tagName = current.tagName.toLowerCase();
      const hasBlockClass =
        current.classList &&
        Array.from(current.classList).some((c) =>
          blockClasses.some((bc) => c.toLowerCase().includes(bc))
        );

      // Prefer elements with block-indicating classes
      if (hasBlockClass) {
        bestMatch = current;
      }
      // Or semantic block elements
      else if (preferredTags.includes(tagName) && tagName !== 'div') {
        bestMatch = current;
      }

      current = current.parentElement;
      depth++;
    }

    return bestMatch;
  }

  /**
   * Create overlay element
   */
  function createOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'aem-block-importer-overlay';
    document.body.appendChild(overlay);
  }

  /**
   * Create tooltip element
   */
  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.className = 'aem-block-importer-tooltip';
    document.body.appendChild(tooltip);
  }

  /**
   * Update overlay position to match element
   */
  function updateOverlay(element) {
    if (!overlay || !element) return;

    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    overlay.style.left = `${rect.left + scrollX}px`;
    overlay.style.top = `${rect.top + scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = 'block';
  }

  /**
   * Update tooltip position and content
   */
  function updateTooltip(element) {
    if (!tooltip || !element) return;

    const rect = element.getBoundingClientRect();
    const tagName = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const classes = element.classList.length > 0 ? `.${Array.from(element.classList).slice(0, 2).join('.')}` : '';

    tooltip.textContent = `${tagName}${id}${classes} (${Math.round(rect.width)}×${Math.round(rect.height)})`;

    // Position tooltip above element
    const scrollY = window.scrollY;
    let top = rect.top + scrollY - 28;

    // If too close to top, show below
    if (top < scrollY + 10) {
      top = rect.bottom + scrollY + 8;
    }

    tooltip.style.left = `${rect.left + window.scrollX}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.display = 'block';
  }

  /**
   * Hide overlay and tooltip
   */
  function hideOverlay() {
    if (overlay) {
      overlay.style.display = 'none';
    }
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  /**
   * Handle mouse move
   */
  function handleMouseMove(event) {
    if (!isActive) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || shouldIgnore(element)) {
      hideOverlay();
      currentElement = null;
      return;
    }

    // Find best selectable element
    const bestElement = findBestElement(element);

    if (bestElement !== currentElement) {
      currentElement = bestElement;
      updateOverlay(currentElement);
      updateTooltip(currentElement);
    }
  }

  /**
   * Handle click - select element
   */
  function handleClick(event) {
    if (!isActive || !currentElement) return;

    event.preventDefault();
    event.stopPropagation();

    // Scroll element into view if needed
    const rect = currentElement.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      currentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
      // Wait for scroll to complete
      setTimeout(() => selectElement(), 100);
    } else {
      selectElement();
    }
  }

  /**
   * Select the current element and send to background
   */
  function selectElement() {
    if (!currentElement) return;

    // Get element info
    const info = window.XPathGenerator.getElementInfo(currentElement);

    // Highlight as selected
    overlay.classList.add('selected');

    // Calculate Y coordinates (absolute position on page)
    const rect = currentElement.getBoundingClientRect();
    const scrollY = window.scrollY;
    const yStart = Math.round(rect.top + scrollY);
    const yEnd = Math.round(rect.bottom + scrollY);

    if (selectionMode === 'section') {
      // Section selection mode - send simplified data for page import
      chrome.runtime.sendMessage({
        type: 'SECTION_SELECTED',
        data: {
          xpath: info.xpath,
          html: info.html,
          yStart,
          yEnd,
          description: getElementDescription(currentElement),
        },
      });
    } else {
      // Block selection mode - full block generation flow
      chrome.runtime.sendMessage({
        type: 'ELEMENT_SELECTED',
        data: {
          xpath: info.xpath,
          html: info.html,
          bounds: info.bounds,
          cssSelector: info.cssSelector,
        },
      });
    }

    // Deactivate after short delay
    setTimeout(() => {
      deactivate();
    }, 300);
  }

  /**
   * Get a brief description of the element for section naming
   */
  function getElementDescription(element) {
    // Try to get meaningful text content
    const headings = element.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length > 0) {
      return headings[0].textContent.trim().substring(0, 100);
    }

    // Try first paragraph
    const paragraphs = element.querySelectorAll('p');
    if (paragraphs.length > 0) {
      return paragraphs[0].textContent.trim().substring(0, 100);
    }

    // Fall back to element tag/class info
    const tagName = element.tagName.toLowerCase();
    const className = element.className ? `.${element.className.split(' ')[0]}` : '';
    return `${tagName}${className}`;
  }

  /**
   * Handle keydown - ESC to cancel
   */
  function handleKeyDown(event) {
    if (!isActive) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      deactivate();
      // Send appropriate cancel message based on mode
      const cancelType = selectionMode === 'section' ? 'SECTION_SELECTION_CANCELLED' : 'SELECTION_CANCELLED';
      chrome.runtime.sendMessage({ type: cancelType });
    }
  }

  /**
   * Activate selection mode
   */
  function activate() {
    if (isActive) return;

    isActive = true;

    // Create UI elements
    createOverlay();
    createTooltip();

    // Add event listeners
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);

    // Add body class for cursor
    document.body.classList.add('aem-block-importer-active');

    console.log('AEM Block Importer: Selection mode activated');
  }

  /**
   * Deactivate selection mode
   */
  function deactivate() {
    if (!isActive) return;

    isActive = false;

    // Remove event listeners
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);

    // Remove UI elements
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }

    // Remove body class
    document.body.classList.remove('aem-block-importer-active');

    currentElement = null;

    console.log('AEM Block Importer: Selection mode deactivated');
  }

  // Track overlay state for screenshot capture
  let overlayHiddenForScreenshot = false;

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'CANCEL_SELECTION':
      case 'CANCEL_SECTION_SELECTION':
        deactivate();
        sendResponse({ success: true });
        break;

      case 'START_SECTION_MODE':
        // Switch to section selection mode
        selectionMode = 'section';
        if (!isActive) {
          activate();
        }
        console.log('AEM Block Importer: Section selection mode activated');
        sendResponse({ success: true });
        break;

      case 'HIDE_OVERLAY_FOR_SCREENSHOT':
        // Hide the selection overlay before screenshot capture
        // This prevents the overlay color from polluting the screenshot
        if (overlay && overlay.style.display !== 'none') {
          overlay.style.display = 'none';
          overlayHiddenForScreenshot = true;
          console.log('Selector overlay hidden for screenshot capture');
        }
        if (tooltip && tooltip.style.display !== 'none') {
          tooltip.style.display = 'none';
        }
        sendResponse({ success: true });
        break;

      case 'RESTORE_OVERLAY_AFTER_SCREENSHOT':
        // Restore the overlay after screenshot capture
        if (overlayHiddenForScreenshot && overlay && isActive) {
          overlay.style.display = 'block';
          console.log('Selector overlay restored after screenshot capture');
        }
        overlayHiddenForScreenshot = false;
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // Auto-activate when script is injected (block mode by default)
  selectionMode = 'block';
  activate();
})();
