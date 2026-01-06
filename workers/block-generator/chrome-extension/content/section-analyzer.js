/**
 * Section Analyzer for AEM Block Importer
 *
 * Detects page sections for sequential import.
 * Works alongside the /analyze endpoint for server-side analysis.
 */

(function () {
  'use strict';

  /**
   * Common section indicators in class names
   */
  const SECTION_INDICATORS = [
    'section',
    'block',
    'module',
    'component',
    'container',
    'wrapper',
    'row',
    'hero',
    'banner',
    'header',
    'footer',
    'nav',
    'card',
    'grid',
    'feature',
    'cta',
    'testimonial',
    'gallery',
    'slider',
    'carousel',
  ];

  /**
   * Tags that typically represent sections
   */
  const SECTION_TAGS = ['section', 'article', 'aside', 'main', 'header', 'footer', 'nav'];

  /**
   * Check if element looks like a section
   */
  function isSectionCandidate(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();

    // Check tag name
    if (SECTION_TAGS.includes(tagName)) {
      return true;
    }

    // Check class names
    const classes = Array.from(element.classList);
    for (const className of classes) {
      const lowerClass = className.toLowerCase();
      if (SECTION_INDICATORS.some((ind) => lowerClass.includes(ind))) {
        return true;
      }
    }

    // Check for significant size (likely a content block)
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Must be reasonably sized
    if (rect.width < viewportWidth * 0.5) {
      return false;
    }

    if (rect.height < 100) {
      return false;
    }

    // Divs with substantial height relative to viewport
    if (tagName === 'div' && rect.height > viewportHeight * 0.2) {
      return true;
    }

    return false;
  }

  /**
   * Get section boundaries (Y coordinates)
   */
  function getSectionBounds(element) {
    const rect = element.getBoundingClientRect();
    const scrollY = window.scrollY;

    return {
      yStart: rect.top + scrollY,
      yEnd: rect.bottom + scrollY,
      height: rect.height,
      width: rect.width,
    };
  }

  /**
   * Get descriptive name for section
   */
  function getSectionName(element) {
    // Try common patterns for section naming
    const tagName = element.tagName.toLowerCase();

    // ID-based naming
    if (element.id) {
      return element.id
        .replace(/[-_]/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .trim();
    }

    // Class-based naming
    const classes = Array.from(element.classList);
    for (const className of classes) {
      const lowerClass = className.toLowerCase();
      for (const indicator of SECTION_INDICATORS) {
        if (lowerClass.includes(indicator)) {
          return className
            .replace(/[-_]/g, ' ')
            .replace(/([A-Z])/g, ' $1')
            .trim();
        }
      }
    }

    // Semantic tag naming
    if (SECTION_TAGS.includes(tagName)) {
      return tagName.charAt(0).toUpperCase() + tagName.slice(1);
    }

    // Heading-based naming
    const heading = element.querySelector('h1, h2, h3');
    if (heading) {
      return heading.textContent.trim().slice(0, 50);
    }

    return `Section`;
  }

  /**
   * Detect sections in the current page
   */
  function detectSections() {
    const sections = [];
    const seen = new Set();

    // Find main content area
    const main =
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;

    // Walk through potential section elements
    const candidates = main.querySelectorAll('section, article, [class*="section"], [class*="block"], [class*="container"] > div');

    candidates.forEach((element) => {
      if (!isSectionCandidate(element)) {
        return;
      }

      // Skip if we've already captured a parent or child
      const bounds = getSectionBounds(element);

      // Check for overlap with existing sections
      let isOverlapping = false;
      for (const existing of sections) {
        const overlap =
          Math.max(0, Math.min(bounds.yEnd, existing.yEnd) - Math.max(bounds.yStart, existing.yStart));
        const overlapRatio = overlap / Math.min(bounds.height, existing.height);

        if (overlapRatio > 0.5) {
          isOverlapping = true;
          break;
        }
      }

      if (isOverlapping) {
        return;
      }

      // Create section entry
      const key = `${bounds.yStart}-${bounds.yEnd}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      sections.push({
        element,
        name: getSectionName(element),
        ...bounds,
        xpath: window.XPathGenerator?.generateXPath(element),
        html: element.outerHTML,
      });
    });

    // Sort by Y position
    sections.sort((a, b) => a.yStart - b.yStart);

    return sections;
  }

  /**
   * Highlight a specific section
   */
  function highlightSection(section, index) {
    // Remove existing highlights
    document.querySelectorAll('.aem-section-highlight').forEach((el) => el.remove());

    const highlight = document.createElement('div');
    highlight.className = 'aem-section-highlight';
    highlight.style.cssText = `
      position: absolute;
      left: 0;
      top: ${section.yStart}px;
      width: 100%;
      height: ${section.height}px;
      background: rgba(59, 130, 246, 0.1);
      border: 2px dashed #3b82f6;
      pointer-events: none;
      z-index: 2147483640;
      box-sizing: border-box;
    `;

    const label = document.createElement('div');
    label.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      background: #3b82f6;
      color: white;
      padding: 4px 8px;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      font-weight: 500;
      border-radius: 0 0 4px 0;
    `;
    label.textContent = `Section ${index + 1}: ${section.name}`;
    highlight.appendChild(label);

    document.body.appendChild(highlight);

    // Scroll section into view
    section.element.scrollIntoView({ block: 'center', behavior: 'smooth' });

    return highlight;
  }

  /**
   * Clear section highlights
   */
  function clearHighlights() {
    document.querySelectorAll('.aem-section-highlight').forEach((el) => el.remove());
  }

  // Export to window
  window.SectionAnalyzer = {
    detectSections,
    highlightSection,
    clearHighlights,
    isSectionCandidate,
    getSectionName,
  };
})();
