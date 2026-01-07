/**
 * XPath Generator for AEM Block Importer
 *
 * Generates unique, reliable XPath expressions for DOM elements.
 */

(function () {
  'use strict';

  /**
   * Check if element has siblings with same tag
   */
  function hasNextSiblingWithSameTag(element) {
    let sibling = element.nextElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) {
        return true;
      }
      sibling = sibling.nextElementSibling;
    }
    return false;
  }

  /**
   * Get element's position among siblings with same tag
   */
  function getElementIndex(element) {
    let index = 1;
    let sibling = element.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === element.tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    return index;
  }

  /**
   * Check if element needs index in XPath
   */
  function needsIndex(element) {
    const index = getElementIndex(element);
    return index > 1 || hasNextSiblingWithSameTag(element);
  }

  /**
   * Generate XPath for an element
   *
   * Strategies:
   * 1. ID-based (most reliable)
   * 2. Build path with indices from nearest ID ancestor
   * 3. Full path from root if no IDs
   */
  function generateXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    // Strategy 1: Direct ID
    if (element.id) {
      return `//*[@id="${element.id}"]`;
    }

    // Build path from element to root or nearest ID
    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      // Check for ID on current element
      if (current.id && current !== element) {
        parts.unshift(`*[@id="${current.id}"]`);
        break;
      }

      const tagName = current.tagName.toLowerCase();

      // Skip html and body as they're implicit
      if (tagName === 'html' || tagName === 'body') {
        current = current.parentElement;
        continue;
      }

      // Build part with index if needed
      const index = getElementIndex(current);
      const needsIdx = needsIndex(current);
      const part = needsIdx ? `${tagName}[${index}]` : tagName;

      parts.unshift(part);
      current = current.parentElement;
    }

    // If we didn't find an ID ancestor, prepend //
    if (parts.length > 0 && !parts[0].includes('@id')) {
      return '//' + parts.join('/');
    }

    return '/' + parts.join('/');
  }

  /**
   * Generate CSS selector as fallback
   */
  function generateCssSelector(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    // ID selector
    if (element.id) {
      return `#${element.id}`;
    }

    // Class-based selector
    const parts = [];
    let current = element;
    let depth = 0;
    const maxDepth = 5;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < maxDepth) {
      const tagName = current.tagName.toLowerCase();

      if (tagName === 'html' || tagName === 'body') {
        break;
      }

      let part = tagName;

      // Add ID if available
      if (current.id) {
        parts.unshift(`#${current.id}`);
        break;
      }

      // Add class if available (first non-generic class)
      const classes = Array.from(current.classList).filter(
        (c) =>
          !c.startsWith('js-') &&
          !c.startsWith('is-') &&
          !c.startsWith('has-') &&
          c.length > 2
      );

      if (classes.length > 0) {
        part += `.${classes[0]}`;
      }

      // Add nth-child if needed
      if (needsIndex(current)) {
        part += `:nth-child(${getElementIndex(current)})`;
      }

      parts.unshift(part);
      current = current.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }

  /**
   * Validate XPath by testing it
   */
  function validateXPath(xpath, expectedElement) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue === expectedElement;
    } catch (e) {
      return false;
    }
  }

  /**
   * Extract background images from an element and its ancestors/descendants
   */
  function extractBackgroundImages(element) {
    const images = [];
    const seenUrls = new Set();

    function addBgImage(url, source) {
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        // Resolve relative URLs
        try {
          const resolvedUrl = new URL(url, window.location.href).href;
          images.push({ src: resolvedUrl, alt: 'Background', role: 'background', source });
        } catch (e) {
          images.push({ src: url, alt: 'Background', role: 'background', source });
        }
      }
    }

    function extractFromElement(el, source) {
      const computed = window.getComputedStyle(el);
      const bgImage = computed.backgroundImage;

      if (bgImage && bgImage !== 'none') {
        // Extract all URLs from background-image
        const urlMatches = bgImage.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
        for (const match of urlMatches) {
          addBgImage(match[1], source);
        }
      }
    }

    // Check the element itself
    extractFromElement(element, 'container');

    // Check ancestors (up to 5 levels)
    let parent = element.parentElement;
    for (let i = 0; i < 5 && parent && parent !== document.body; i++) {
      extractFromElement(parent, `parent-${i + 1}`);
      parent = parent.parentElement;
    }

    // Check descendants
    element.querySelectorAll('*').forEach((el, idx) => {
      extractFromElement(el, `descendant-${idx}`);
    });

    return images;
  }

  /**
   * Get element info including XPath, CSS selector, and HTML
   */
  function getElementInfo(element) {
    const xpath = generateXPath(element);
    const cssSelector = generateCssSelector(element);
    const rect = element.getBoundingClientRect();

    // Extract background images from CSS
    const backgroundImages = extractBackgroundImages(element);

    return {
      xpath,
      cssSelector,
      html: element.outerHTML,
      tagName: element.tagName.toLowerCase(),
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      isValid: validateXPath(xpath, element),
      backgroundImages, // NEW: CSS background images
    };
  }

  // Export to window
  window.XPathGenerator = {
    generateXPath,
    generateCssSelector,
    validateXPath,
    getElementInfo,
  };
})();
