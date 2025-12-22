import { ExtractedBlock, ExtractedColumn, ExtractedStyles } from './content-extractor';
import { DesignTokens } from './design-analyzer';

export interface GeneratedBlock {
  blockName: string;
  html: string;
  js: string;
  css: string;
}

/**
 * Generate a complete EDS block from extracted content
 */
export function buildBlock(extracted: ExtractedBlock, designTokens?: DesignTokens): GeneratedBlock {
  const blockName = generateBlockName(extracted);

  return {
    blockName,
    html: generateHTML(blockName, extracted),
    js: generateJS(blockName, extracted),
    css: generateCSS(blockName, extracted, designTokens),
  };
}

/**
 * Generate a meaningful block name
 */
function generateBlockName(extracted: ExtractedBlock): string {
  const parts: string[] = [];

  // Base name from type
  switch (extracted.type) {
    case 'tabs':
      parts.push('tabs');
      break;
    case 'cards':
      parts.push('cards');
      break;
    case 'columns':
      parts.push('columns');
      break;
    case 'hero':
      parts.push('hero');
      break;
    case 'accordion':
      parts.push('accordion');
      break;
    case 'carousel':
      parts.push('carousel');
      break;
    default:
      parts.push('content');
  }

  // Add column count for multi-column layouts
  if (extracted.columns.length >= 2) {
    parts.push(String(extracted.columns.length));
  }

  // Add feature hints
  const hasImages = extracted.columns.some(c => c.image);
  const hasCTAs = extracted.columns.some(c => c.cta);

  if (hasImages && extracted.type !== 'hero') {
    parts.push('media');
  }

  return parts.join('-');
}

/**
 * Generate clean EDS HTML structure
 */
function generateHTML(blockName: string, extracted: ExtractedBlock): string {
  const lines: string[] = [];

  lines.push(`<div class="${blockName}">`);

  // Add title row if present
  if (extracted.title) {
    lines.push('  <div>');
    lines.push('    <div>');
    lines.push(`      <h2>${escapeHtml(extracted.title)}</h2>`);
    if (extracted.subtitle) {
      lines.push(`      <p>${escapeHtml(extracted.subtitle)}</p>`);
    }
    lines.push('    </div>');
    lines.push('  </div>');
  }

  // Add content rows based on type
  switch (extracted.type) {
    case 'columns':
      // Single row with multiple column cells
      lines.push('  <div>');
      for (const col of extracted.columns) {
        lines.push('    <div>');
        // Image first, then heading, description, CTA
        if (col.image) {
          lines.push(`      <picture>`);
          lines.push(`        <source type="image/webp" srcset="${escapeHtml(col.image.src)}?width=750&format=webp">`);
          lines.push(`        <img src="${escapeHtml(col.image.src)}" alt="${escapeHtml(col.image.alt)}" loading="lazy">`);
          lines.push(`      </picture>`);
        }
        if (col.heading) {
          const level = col.headingLevel || 3;
          lines.push(`      <h${level}>${escapeHtml(col.heading)}</h${level}>`);
        }
        if (col.description) {
          lines.push(`      <p>${escapeHtml(col.description)}</p>`);
        }
        if (col.cta) {
          lines.push(`      <p><a href="${escapeHtml(col.cta.href)}">${escapeHtml(col.cta.text)}</a></p>`);
        }
        lines.push('    </div>');
      }
      lines.push('  </div>');
      break;

    case 'tabs':
      // Single row with multiple cells (for tabs that show one at a time)
      lines.push('  <div>');
      for (const col of extracted.columns) {
        lines.push('    <div>');
        lines.push(...generateColumnContent(col, 6));
        lines.push('    </div>');
      }
      lines.push('  </div>');
      break;

    case 'cards':
      // Each card is a row with image and content cells
      for (const col of extracted.columns) {
        lines.push('  <div>');
        if (col.image) {
          lines.push('    <div>');
          lines.push(`      <picture>`);
          lines.push(`        <source type="image/webp" srcset="${escapeHtml(col.image.src)}?width=750&format=webp">`);
          lines.push(`        <img src="${escapeHtml(col.image.src)}" alt="${escapeHtml(col.image.alt)}" loading="lazy">`);
          lines.push(`      </picture>`);
          lines.push('    </div>');
        }
        lines.push('    <div>');
        if (col.heading) {
          const level = col.headingLevel || 3;
          lines.push(`      <h${level}>${escapeHtml(col.heading)}</h${level}>`);
        }
        if (col.description) {
          lines.push(`      <p>${escapeHtml(col.description)}</p>`);
        }
        if (col.cta) {
          lines.push(`      <p><a href="${escapeHtml(col.cta.href)}">${escapeHtml(col.cta.text)}</a></p>`);
        }
        lines.push('    </div>');
        lines.push('  </div>');
      }
      break;

    case 'hero':
      // Single structure with image and content
      const heroCol = extracted.columns[0] || {};
      if (heroCol.image) {
        lines.push('  <div>');
        lines.push('    <div>');
        lines.push(`      <picture>`);
        lines.push(`        <source type="image/webp" srcset="${escapeHtml(heroCol.image.src)}?width=2000&format=webp" media="(min-width: 600px)">`);
        lines.push(`        <source type="image/webp" srcset="${escapeHtml(heroCol.image.src)}?width=750&format=webp">`);
        lines.push(`        <img src="${escapeHtml(heroCol.image.src)}" alt="${escapeHtml(heroCol.image.alt)}" loading="eager">`);
        lines.push(`      </picture>`);
        lines.push('    </div>');
        lines.push('  </div>');
      }
      lines.push('  <div>');
      lines.push('    <div>');
      if (heroCol.heading) {
        lines.push(`      <h1>${escapeHtml(heroCol.heading)}</h1>`);
      }
      if (heroCol.description) {
        lines.push(`      <p>${escapeHtml(heroCol.description)}</p>`);
      }
      if (heroCol.cta) {
        lines.push(`      <p><a href="${escapeHtml(heroCol.cta.href)}">${escapeHtml(heroCol.cta.text)}</a></p>`);
      }
      lines.push('    </div>');
      lines.push('  </div>');
      break;

    case 'carousel':
      // Each slide is a row with image cell and content cell
      for (const col of extracted.columns) {
        lines.push('  <div>');
        // Image cell
        if (col.image) {
          lines.push('    <div>');
          lines.push(`      <picture>`);
          lines.push(`        <source type="image/webp" srcset="${escapeHtml(col.image.src)}?width=2000&format=webp" media="(min-width: 600px)">`);
          lines.push(`        <source type="image/webp" srcset="${escapeHtml(col.image.src)}?width=750&format=webp">`);
          lines.push(`        <img src="${escapeHtml(col.image.src)}" alt="${escapeHtml(col.image.alt)}" loading="lazy">`);
          lines.push(`      </picture>`);
          lines.push('    </div>');
        }
        // Content cell (overlay box)
        const hasContent = col.heading || col.description || col.cta;
        if (hasContent) {
          lines.push('    <div>');
          if (col.heading) {
            const level = col.headingLevel || 2;
            lines.push(`      <h${level}>${escapeHtml(col.heading)}</h${level}>`);
          }
          if (col.description) {
            lines.push(`      <p>${escapeHtml(col.description)}</p>`);
          }
          if (col.cta) {
            lines.push(`      <p><a href="${escapeHtml(col.cta.href)}">${escapeHtml(col.cta.text)}</a></p>`);
          }
          lines.push('    </div>');
        }
        lines.push('  </div>');
      }
      break;

    default:
      // Generic content
      for (const col of extracted.columns) {
        lines.push('  <div>');
        lines.push('    <div>');
        lines.push(...generateColumnContent(col, 6));
        lines.push('    </div>');
        lines.push('  </div>');
      }
  }

  lines.push('</div>');

  return lines.join('\n');
}

/**
 * Generate content for a single column
 */
function generateColumnContent(col: ExtractedColumn, indent: number): string[] {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);

  if (col.image) {
    lines.push(`${pad}<picture>`);
    lines.push(`${pad}  <source type="image/webp" srcset="${escapeHtml(col.image.src)}?width=750&format=webp">`);
    lines.push(`${pad}  <img src="${escapeHtml(col.image.src)}" alt="${escapeHtml(col.image.alt)}" loading="lazy">`);
    lines.push(`${pad}</picture>`);
  }

  if (col.heading) {
    const level = col.headingLevel || 3;
    lines.push(`${pad}<h${level}>${escapeHtml(col.heading)}</h${level}>`);
  }

  if (col.description) {
    lines.push(`${pad}<p>${escapeHtml(col.description)}</p>`);
  }

  if (col.cta) {
    lines.push(`${pad}<p><a href="${escapeHtml(col.cta.href)}">${escapeHtml(col.cta.text)}</a></p>`);
  }

  return lines;
}

/**
 * Generate JS decoration function
 */
function generateJS(blockName: string, extracted: ExtractedBlock): string {
  switch (extracted.type) {
    case 'tabs':
      return generateTabsJS(blockName);
    case 'columns':
      return generateColumnsJS(blockName, extracted.columns.length);
    case 'cards':
      return generateCardsJS(blockName);
    case 'hero':
      return generateHeroJS(blockName);
    case 'carousel':
      return generateCarouselJS(blockName);
    default:
      return generateDefaultJS(blockName);
  }
}

function generateTabsJS(blockName: string): string {
  return `export default function decorate(block) {
  // Get all content panels
  const rows = [...block.children];
  const titleRow = rows.find(row => row.querySelector('h2:only-child'));
  const contentRow = rows.find(row => row.children.length > 1);

  if (!contentRow) return;

  const panels = [...contentRow.children];

  // Create tab navigation
  const nav = document.createElement('nav');
  nav.className = '${blockName}-nav';

  const tabList = document.createElement('ul');
  tabList.setAttribute('role', 'tablist');

  panels.forEach((panel, index) => {
    const heading = panel.querySelector('h2, h3, h4');
    const title = heading?.textContent || \`Tab \${index + 1}\`;

    // Create tab button
    const tab = document.createElement('li');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    tab.setAttribute('tabindex', index === 0 ? '0' : '-1');
    tab.textContent = title;
    tab.addEventListener('click', () => activateTab(index));
    tabList.appendChild(tab);

    // Setup panel
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
    panel.classList.add('${blockName}-panel');
    if (index === 0) panel.classList.add('${blockName}-panel-active');

    // Remove heading from panel (it's now in tab)
    if (heading) heading.remove();
  });

  nav.appendChild(tabList);

  // Insert nav before content
  if (titleRow) {
    titleRow.after(nav);
  } else {
    block.prepend(nav);
  }

  function activateTab(activeIndex) {
    tabList.querySelectorAll('li').forEach((tab, i) => {
      tab.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      tab.setAttribute('tabindex', i === activeIndex ? '0' : '-1');
    });

    panels.forEach((panel, i) => {
      panel.setAttribute('aria-hidden', i === activeIndex ? 'false' : 'true');
      panel.classList.toggle('${blockName}-panel-active', i === activeIndex);
    });
  }
}
`;
}

function generateColumnsJS(blockName: string, colCount: number): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const rows = [...block.children];

  rows.forEach((row) => {
    const cols = [...row.children];

    // If this row has multiple columns, it's the columns container
    if (cols.length > 1) {
      row.classList.add('${blockName}-row');

      cols.forEach((col) => {
        col.classList.add('${blockName}-col');

        // Optimize images
        col.querySelectorAll('picture > img').forEach((img) => {
          const picture = img.closest('picture');
          if (picture) {
            picture.replaceWith(
              createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }])
            );
          }
        });
      });
    }
  });
}
`;
}

function generateCardsJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const ul = document.createElement('ul');

  [...block.children].forEach((row) => {
    const li = document.createElement('li');

    while (row.firstElementChild) {
      const cell = row.firstElementChild;

      // Classify cell content
      if (cell.children.length === 1 && cell.querySelector('picture')) {
        cell.className = '${blockName}-card-image';
      } else {
        cell.className = '${blockName}-card-body';
      }

      li.append(cell);
    }

    ul.append(li);
  });

  // Optimize images
  ul.querySelectorAll('picture > img').forEach((img) => {
    img.closest('picture')?.replaceWith(
      createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }])
    );
  });

  block.replaceChildren(ul);
}
`;
}

function generateHeroJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const rows = [...block.children];

  rows.forEach((row) => {
    const cells = [...row.children];

    cells.forEach((cell) => {
      const pic = cell.querySelector('picture');

      if (pic) {
        cell.classList.add('${blockName}-image');
        // Optimize with eager loading for hero
        const img = pic.querySelector('img');
        if (img) {
          pic.replaceWith(
            createOptimizedPicture(img.src, img.alt, true, [{ width: '2000' }])
          );
        }
      } else if (cell.querySelector('h1, h2')) {
        cell.classList.add('${blockName}-content');
      }
    });
  });
}
`;
}

function generateCarouselJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const slides = [...block.children];
  let currentSlide = 0;

  // Create carousel wrapper
  const wrapper = document.createElement('div');
  wrapper.className = '${blockName}-wrapper';

  // Create slides container
  const slidesContainer = document.createElement('div');
  slidesContainer.className = '${blockName}-slides';

  slides.forEach((slide, index) => {
    slide.classList.add('${blockName}-slide');
    slide.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
    if (index === 0) slide.classList.add('${blockName}-slide-active');

    // Optimize images
    slide.querySelectorAll('picture > img').forEach((img) => {
      const picture = img.closest('picture');
      if (picture) {
        picture.replaceWith(
          createOptimizedPicture(img.src, img.alt, index === 0, [{ width: '2000' }])
        );
      }
    });

    slidesContainer.appendChild(slide);
  });

  wrapper.appendChild(slidesContainer);

  // Create navigation
  const nav = document.createElement('div');
  nav.className = '${blockName}-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = '${blockName}-prev';
  prevBtn.setAttribute('aria-label', 'Previous slide');
  prevBtn.innerHTML = '&#10094;';
  prevBtn.addEventListener('click', () => goToSlide(currentSlide - 1));

  const nextBtn = document.createElement('button');
  nextBtn.className = '${blockName}-next';
  nextBtn.setAttribute('aria-label', 'Next slide');
  nextBtn.innerHTML = '&#10095;';
  nextBtn.addEventListener('click', () => goToSlide(currentSlide + 1));

  nav.appendChild(prevBtn);
  nav.appendChild(nextBtn);
  wrapper.appendChild(nav);

  // Create indicators
  const indicators = document.createElement('div');
  indicators.className = '${blockName}-indicators';

  slides.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.className = '${blockName}-indicator';
    dot.setAttribute('aria-label', \`Go to slide \${index + 1}\`);
    if (index === 0) dot.classList.add('${blockName}-indicator-active');
    dot.addEventListener('click', () => goToSlide(index));
    indicators.appendChild(dot);
  });

  wrapper.appendChild(indicators);
  block.replaceChildren(wrapper);

  function goToSlide(index) {
    const slideCount = slides.length;
    currentSlide = ((index % slideCount) + slideCount) % slideCount;

    slides.forEach((slide, i) => {
      slide.classList.toggle('${blockName}-slide-active', i === currentSlide);
      slide.setAttribute('aria-hidden', i === currentSlide ? 'false' : 'true');
    });

    indicators.querySelectorAll('.${blockName}-indicator').forEach((dot, i) => {
      dot.classList.toggle('${blockName}-indicator-active', i === currentSlide);
    });
  }

  // Auto-advance every 5 seconds
  let autoplayInterval = setInterval(() => goToSlide(currentSlide + 1), 5000);

  // Pause on hover
  block.addEventListener('mouseenter', () => clearInterval(autoplayInterval));
  block.addEventListener('mouseleave', () => {
    autoplayInterval = setInterval(() => goToSlide(currentSlide + 1), 5000);
  });
}
`;
}

function generateDefaultJS(blockName: string): string {
  return `export default function decorate(block) {
  [...block.children].forEach((row, i) => {
    row.classList.add('${blockName}-row');

    [...row.children].forEach((col, j) => {
      col.classList.add('${blockName}-col');
    });
  });
}
`;
}

/**
 * Generate CSS that matches the original design
 */
function generateCSS(blockName: string, extracted: ExtractedBlock, designTokens?: DesignTokens): string {
  const styles = extracted.styles;
  const colCount = styles.columnCount;

  switch (extracted.type) {
    case 'tabs':
      return generateTabsCSS(blockName, styles, designTokens);
    case 'columns':
      return generateColumnsCSS(blockName, colCount, styles, designTokens);
    case 'cards':
      return generateCardsCSS(blockName, colCount, styles, designTokens);
    case 'hero':
      return generateHeroCSS(blockName, styles, designTokens);
    case 'carousel':
      return generateCarouselCSS(blockName, styles, designTokens);
    default:
      return generateDefaultCSS(blockName, styles, designTokens);
  }
}

function generateTabsCSS(blockName: string, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  const dt = {
    colors: designTokens?.colors || {},
    typography: designTokens?.typography || {},
    spacing: designTokens?.spacing || {},
    layout: designTokens?.layout || {},
    effects: designTokens?.effects || {},
  };

  const bgColor = dt.colors.background || styles.backgroundColor || 'var(--background-color, #fff)';
  const textColor = dt.colors.text || styles.textColor || 'var(--text-color, #333)';
  const headingColor = dt.colors.heading || styles.headingColor || 'var(--heading-color, #1a1a1a)';
  const linkColor = dt.colors.link || dt.colors.primary || styles.linkColor || 'var(--link-color, #3b63fb)';

  return `/* ${blockName} - Tabs Block */
.${blockName} {
  padding: 40px 0;
  background: ${bgColor};
}

.${blockName} > div:first-child h2 {
  font-size: var(--heading-font-size-l, 32px);
  color: ${headingColor};
  margin: 0 0 24px;
  text-align: center;
}

.${blockName}-nav {
  margin-bottom: 32px;
}

.${blockName}-nav ul {
  display: flex;
  justify-content: center;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
  border-bottom: 2px solid var(--light-color, #eee);
}

.${blockName}-nav li {
  padding: 12px 24px;
  cursor: pointer;
  font-weight: 600;
  color: var(--dark-color, #666);
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color 0.2s, border-color 0.2s;
}

.${blockName}-nav li:hover {
  color: ${linkColor};
}

.${blockName}-nav li[aria-selected="true"] {
  color: ${linkColor};
  border-bottom-color: ${linkColor};
}

.${blockName}-panel {
  display: none;
  padding: 24px;
}

.${blockName}-panel-active {
  display: block;
}

.${blockName}-panel h3, .${blockName}-panel h4 {
  font-size: var(--heading-font-size-m, 24px);
  color: ${headingColor};
  margin: 0 0 12px;
}

.${blockName}-panel p {
  color: ${textColor};
  line-height: 1.6;
  margin: 0 0 16px;
}

.${blockName}-panel a {
  color: ${linkColor};
  font-weight: 600;
  text-decoration: none;
}

.${blockName}-panel a:hover {
  text-decoration: underline;
}

/* Columns layout for tab content */
.${blockName} > div:last-child {
  display: grid;
  grid-template-columns: repeat(${styles.columnCount}, 1fr);
  gap: 32px;
}

@media (max-width: 900px) {
  .${blockName}-nav ul {
    flex-wrap: wrap;
  }

  .${blockName} > div:last-child {
    grid-template-columns: 1fr;
  }
}
`;
}

function generateColumnsCSS(blockName: string, colCount: number, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  const dt = {
    colors: designTokens?.colors || {},
    typography: designTokens?.typography || {},
    spacing: designTokens?.spacing || {},
    layout: designTokens?.layout || {},
    effects: designTokens?.effects || {},
  };

  const bgColor = dt.colors.background || styles.backgroundColor || 'var(--background-color, #fff)';
  const textColor = dt.colors.text || styles.textColor || 'var(--text-color, #333)';
  const headingColor = dt.colors.heading || dt.colors.primary || styles.headingColor || '#1a1a1a';
  const linkColor = dt.colors.link || dt.colors.primary || styles.linkColor || '#3b63fb';

  const headingFontSize = dt.typography.headingFontSize || '24px';
  const headingFontWeight = dt.typography.headingFontWeight || '400';
  const bodyFontSize = dt.typography.bodyFontSize || '16px';
  const gap = dt.spacing.gap || '40px';
  const padding = dt.spacing.padding || '48px 0';

  return `/* ${blockName} - Columns Block */
.${blockName} {
  padding: ${padding};
  background: ${bgColor};
}

/* Main title */
.${blockName} > div:first-child h2 {
  font-size: 36px;
  font-weight: 300;
  color: ${headingColor};
  margin: 0 0 40px;
}

/* Columns container */
.${blockName}-row {
  display: grid;
  grid-template-columns: repeat(${colCount}, 1fr);
  gap: 40px;
}

/* Individual column */
.${blockName}-col {
  display: flex;
  flex-direction: column;
}

/* Column image */
.${blockName}-col picture,
.${blockName}-col img {
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  margin-bottom: 24px;
}

/* Column heading */
.${blockName}-col h2,
.${blockName}-col h3,
.${blockName}-col h4 {
  font-size: 24px;
  font-weight: 400;
  color: ${headingColor};
  margin: 0 0 16px;
}

/* Column description */
.${blockName}-col p {
  color: ${textColor};
  font-size: 16px;
  line-height: 1.6;
  margin: 0 0 16px;
}

/* CTA link */
.${blockName}-col a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: ${linkColor};
  font-size: 16px;
  font-weight: 400;
  text-decoration: none;
  margin-top: auto;
}

.${blockName}-col a:hover {
  text-decoration: underline;
}

.${blockName}-col a::after {
  content: '→';
  font-size: 18px;
}

/* Responsive */
@media (max-width: 900px) {
  .${blockName}-row {
    grid-template-columns: 1fr;
    gap: 48px;
  }

  .${blockName} > div:first-child h2 {
    font-size: 28px;
  }
}
`;
}

function generateCardsCSS(blockName: string, colCount: number, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  const dt = {
    colors: designTokens?.colors || {},
    typography: designTokens?.typography || {},
    spacing: designTokens?.spacing || {},
    layout: designTokens?.layout || {},
    effects: designTokens?.effects || {},
  };

  const bgColor = dt.colors.background || styles.backgroundColor || 'var(--background-color, #fff)';
  const textColor = dt.colors.text || styles.textColor || 'var(--text-color, #333)';
  const headingColor = dt.colors.heading || styles.headingColor || 'var(--heading-color, #1a1a1a)';
  const linkColor = dt.colors.link || dt.colors.primary || styles.linkColor || 'var(--link-color, #3b63fb)';
  const borderRadius = dt.layout.borderRadius || '12px';
  const boxShadow = dt.layout.boxShadow || '0 2px 8px rgba(0, 0, 0, 0.08)';

  return `/* ${blockName} - Cards Block */
.${blockName} {
  padding: 40px 0;
}

.${blockName} > ul {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 24px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.${blockName} > ul > li {
  background: ${bgColor};
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s, box-shadow 0.2s;
}

.${blockName} > ul > li:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.${blockName}-card-image {
  aspect-ratio: 16 / 9;
  overflow: hidden;
}

.${blockName}-card-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.${blockName}-card-body {
  padding: 20px;
}

.${blockName}-card-body h3, .${blockName}-card-body h4 {
  font-size: var(--heading-font-size-s, 20px);
  color: ${headingColor};
  margin: 0 0 8px;
}

.${blockName}-card-body p {
  color: ${textColor};
  line-height: 1.5;
  margin: 0 0 12px;
}

.${blockName}-card-body a {
  color: ${linkColor};
  font-weight: 600;
  text-decoration: none;
}

.${blockName}-card-body a:hover {
  text-decoration: underline;
}

@media (min-width: 900px) {
  .${blockName} > ul {
    grid-template-columns: repeat(${Math.min(colCount, 4)}, 1fr);
  }
}
`;
}

function generateHeroCSS(blockName: string, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  const dt = {
    colors: designTokens?.colors || {},
    typography: designTokens?.typography || {},
    spacing: designTokens?.spacing || {},
    layout: designTokens?.layout || {},
    effects: designTokens?.effects || {},
  };

  const headingColor = dt.colors.heading || styles.headingColor || '#fff';
  const textColor = dt.colors.text || styles.textColor || 'rgba(255, 255, 255, 0.9)';
  const linkColor = dt.colors.link || dt.colors.primary || styles.linkColor || '#fff';
  const overlay = dt.effects.overlay || 'rgba(0,0,0,0.3)';
  const gradient = dt.effects.gradient || `linear-gradient(to bottom, ${overlay}, rgba(0,0,0,0.6))`;

  return `/* ${blockName} - Hero Block */
.${blockName} {
  position: relative;
  min-height: 500px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  color: ${textColor};
}

.${blockName}-image {
  position: absolute;
  inset: 0;
  z-index: -1;
}

.${blockName}-image::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,0.6));
}

.${blockName}-image picture,
.${blockName}-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.${blockName}-content {
  position: relative;
  z-index: 1;
  max-width: 800px;
  margin: 0 auto;
  padding: 60px 20px;
  text-align: center;
}

.${blockName}-content h1, .${blockName}-content h2 {
  font-size: var(--heading-font-size-xxl, 48px);
  color: ${headingColor};
  margin: 0 0 16px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.${blockName}-content p {
  font-size: var(--body-font-size-m, 20px);
  margin: 0 0 24px;
}

.${blockName}-content a {
  display: inline-block;
  padding: 14px 32px;
  background: ${linkColor};
  color: #1a1a1a;
  font-weight: 600;
  text-decoration: none;
  border-radius: 4px;
  transition: transform 0.2s;
}

.${blockName}-content a:hover {
  transform: scale(1.05);
}

@media (max-width: 600px) {
  .${blockName} {
    min-height: 400px;
  }

  .${blockName}-content h1, .${blockName}-content h2 {
    font-size: var(--heading-font-size-xl, 36px);
  }
}
`;
}

function generateCarouselCSS(blockName: string, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  // Use design tokens if available, fall back to extracted styles or defaults
  const dt = {
    colors: designTokens?.colors || {},
    typography: designTokens?.typography || {},
    spacing: designTokens?.spacing || {},
    layout: designTokens?.layout || {},
    effects: designTokens?.effects || {},
  };

  const textColor = dt.colors.text || styles.textColor || '#fff';
  const headingColor = dt.colors.heading || styles.headingColor || '#fff';
  const primaryColor = dt.colors.primary || '#fff';
  const bgColor = dt.colors.background || 'transparent';

  const headingFontSize = dt.typography.headingFontSize || 'var(--heading-font-size-xxl, 48px)';
  const headingFontWeight = dt.typography.headingFontWeight || '700';
  const bodyFontSize = dt.typography.bodyFontSize || 'var(--body-font-size-m, 18px)';
  const fontFamily = dt.typography.headingFontFamily || 'inherit';

  const padding = dt.spacing.padding || '0';
  const borderRadius = dt.layout.borderRadius || '0';

  const overlay = dt.effects.overlay || 'rgba(0, 0, 0, 0.3)';
  const gradient = dt.effects.gradient || `linear-gradient(to bottom, transparent 50%, ${overlay})`;
  const textShadow = dt.effects.textShadow || '0 2px 4px rgba(0, 0, 0, 0.5)';

  return `/* ${blockName} - Carousel Block */
.${blockName} {
  position: relative;
  overflow: hidden;
  background: ${bgColor};
  border-radius: ${borderRadius};
}

.${blockName}-wrapper {
  position: relative;
}

.${blockName}-slides {
  position: relative;
  min-height: 400px;
}

.${blockName}-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.5s ease-in-out;
  display: flex;
  align-items: center;
  justify-content: center;
}

.${blockName}-slide-active {
  opacity: 1;
  position: relative;
}

.${blockName}-slide > div {
  position: relative;
  width: 100%;
  height: 100%;
}

.${blockName}-slide > div::after {
  content: '';
  position: absolute;
  inset: 0;
  background: ${gradient};
  pointer-events: none;
}

.${blockName}-slide picture,
.${blockName}-slide img {
  width: 100%;
  height: 100%;
  min-height: 400px;
  object-fit: cover;
}

.${blockName}-slide h1,
.${blockName}-slide h2 {
  position: absolute;
  bottom: 80px;
  left: 40px;
  right: 40px;
  font-family: ${fontFamily};
  font-size: ${headingFontSize};
  font-weight: ${headingFontWeight};
  color: ${headingColor};
  text-shadow: ${textShadow};
  margin: 0;
  z-index: 1;
}

.${blockName}-slide p {
  position: absolute;
  bottom: 40px;
  left: 40px;
  right: 40px;
  font-size: ${bodyFontSize};
  color: ${textColor};
  text-shadow: ${textShadow};
  margin: 0;
  z-index: 1;
}

.${blockName}-slide a {
  display: inline-block;
  padding: 12px 24px;
  background: ${primaryColor};
  color: #1a1a1a;
  font-weight: 600;
  text-decoration: none;
  border-radius: 4px;
  transition: transform 0.2s;
  z-index: 1;
}

.${blockName}-slide a:hover {
  transform: scale(1.05);
}

/* Navigation arrows */
.${blockName}-nav {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  display: flex;
  justify-content: space-between;
  padding: 0 16px;
  pointer-events: none;
  z-index: 10;
}

.${blockName}-prev,
.${blockName}-next {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  color: #1a1a1a;
  font-size: 20px;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.2s, transform 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.${blockName}-prev:hover,
.${blockName}-next:hover {
  background: #fff;
  transform: scale(1.1);
}

/* Indicators */
.${blockName}-indicators {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  z-index: 10;
}

.${blockName}-indicator {
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  padding: 0;
  transition: background 0.2s;
}

.${blockName}-indicator-active,
.${blockName}-indicator:hover {
  background: #fff;
}

@media (max-width: 600px) {
  .${blockName}-slides {
    min-height: 300px;
  }

  .${blockName}-slide picture,
  .${blockName}-slide img {
    min-height: 300px;
  }

  .${blockName}-slide h1,
  .${blockName}-slide h2 {
    font-size: var(--heading-font-size-l, 28px);
    bottom: 60px;
    left: 20px;
    right: 20px;
  }

  .${blockName}-slide p {
    bottom: 24px;
    left: 20px;
    right: 20px;
  }

  .${blockName}-prev,
  .${blockName}-next {
    width: 36px;
    height: 36px;
    font-size: 16px;
  }
}
`;
}

function generateDefaultCSS(blockName: string, styles: ExtractedStyles, designTokens?: DesignTokens): string {
  return `/* ${blockName} Block */
.${blockName} {
  padding: 40px 0;
}

.${blockName}-row {
  display: flex;
  flex-direction: column;
  gap: 24px;
  margin-bottom: 24px;
}

.${blockName}-col {
  flex: 1;
}

@media (min-width: 900px) {
  .${blockName}-row {
    flex-direction: row;
  }
}
`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
