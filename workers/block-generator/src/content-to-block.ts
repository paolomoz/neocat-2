/**
 * Content to Block Generation
 *
 * This module handles Step 2 of the two-step block generation:
 * Generate EDS block code (HTML/CSS/JS) from a BlockContentModel.
 *
 * This step should be as deterministic as possible:
 * - No content invention/hallucination
 * - All content comes from the model
 * - Structure is driven by block type
 */

import {
  BlockContentModel,
  ContentItem,
  ContentCell,
  ContentElement,
} from './types';
import { AnthropicConfig } from './design-analyzer';

// =============================================================================
// Block Generation Types
// =============================================================================

export interface GeneratedBlock {
  blockName: string;
  html: string;
  css: string;
  js: string;
}

// =============================================================================
// HTML Generation (Deterministic)
// =============================================================================

/**
 * Generate EDS block HTML from content model
 * This is completely deterministic - no LLM involved
 */
export function generateBlockHtml(model: BlockContentModel): string {
  const blockName = model.blockName;
  const rows: string[] = [];

  for (const item of model.content.items) {
    const cells: string[] = [];

    for (const cell of item.cells) {
      const cellContent = cell.elements
        .map(el => renderElement(el))
        .filter(Boolean)
        .join('\n');

      if (cellContent) {
        cells.push(`    <div>${cellContent}</div>`);
      }
    }

    if (cells.length > 0) {
      rows.push(`  <div>\n${cells.join('\n')}\n  </div>`);
    }
  }

  return `<div class="${blockName}">\n${rows.join('\n')}\n</div>`;
}

/**
 * Render a single content element to HTML
 */
function renderElement(element: ContentElement): string {
  switch (element.type) {
    case 'heading':
      const level = element.level || 2;
      return `<h${level}>${escapeHtml(element.text || '')}</h${level}>`;

    case 'paragraph':
      return `<p>${escapeHtml(element.text || '')}</p>`;

    case 'image':
      const alt = escapeHtml(element.alt || '');
      // Use picture element for responsive images
      return `<picture><img src="${escapeHtml(element.src || '')}" alt="${alt}"></picture>`;

    case 'link':
      const href = element.href || '#';
      const text = escapeHtml(element.text || '');
      return `<p class="button-container"><a href="${escapeHtml(href)}" class="button">${text}</a></p>`;

    case 'list':
      const items = (element.listItems || [])
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('\n');
      return `<ul>\n${items}\n</ul>`;

    case 'raw':
      return element.html || '';

    default:
      return '';
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =============================================================================
// JavaScript Generation (Template-based)
// =============================================================================

/**
 * Generate JavaScript decoration function based on block type
 */
export function generateBlockJs(model: BlockContentModel): string {
  const blockName = model.blockName;

  switch (model.blockType) {
    case 'carousel':
      return generateCarouselJs(blockName);
    case 'cards':
      return generateCardsJs(blockName);
    case 'tabs':
      return generateTabsJs(blockName);
    case 'accordion':
      return generateAccordionJs(blockName);
    case 'columns':
      return generateColumnsJs(blockName);
    case 'hero':
      return generateHeroJs(blockName);
    default:
      return generateDefaultJs(blockName);
  }
}

function generateCarouselJs(blockName: string): string {
  return `export default function decorate(block) {
  const rows = [...block.children];
  if (rows.length === 0) return;

  // Create carousel structure
  const wrapper = document.createElement('div');
  wrapper.className = '${blockName}-wrapper';

  const track = document.createElement('div');
  track.className = '${blockName}-track';

  // Process each row as a slide
  rows.forEach((row, index) => {
    row.classList.add('${blockName}-slide');
    if (index === 0) row.classList.add('active');

    const cells = [...row.children];
    if (cells[0]) cells[0].classList.add('${blockName}-image');
    if (cells[1]) cells[1].classList.add('${blockName}-content');

    track.appendChild(row);
  });

  wrapper.appendChild(track);

  // Navigation buttons
  const prevBtn = document.createElement('button');
  prevBtn.className = '${blockName}-nav ${blockName}-nav--prev';
  prevBtn.setAttribute('aria-label', 'Previous slide');
  prevBtn.innerHTML = '❮';

  const nextBtn = document.createElement('button');
  nextBtn.className = '${blockName}-nav ${blockName}-nav--next';
  nextBtn.setAttribute('aria-label', 'Next slide');
  nextBtn.innerHTML = '❯';

  // Dots navigation
  const dots = document.createElement('div');
  dots.className = '${blockName}-dots';
  rows.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.className = '${blockName}-dot' + (index === 0 ? ' active' : '');
    dot.setAttribute('aria-label', \`Go to slide \${index + 1}\`);
    dot.dataset.slide = index.toString();
    dots.appendChild(dot);
  });

  // Append all elements
  block.innerHTML = '';
  block.appendChild(wrapper);
  block.appendChild(prevBtn);
  block.appendChild(nextBtn);
  block.appendChild(dots);

  // State
  let currentSlide = 0;
  const totalSlides = rows.length;

  function goToSlide(index) {
    if (index < 0) index = totalSlides - 1;
    if (index >= totalSlides) index = 0;
    currentSlide = index;

    track.style.transform = \`translateX(-\${currentSlide * 100}%)\`;

    // Update active states
    track.querySelectorAll('.${blockName}-slide').forEach((slide, i) => {
      slide.classList.toggle('active', i === currentSlide);
    });
    dots.querySelectorAll('.${blockName}-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === currentSlide);
    });
  }

  // Event listeners
  prevBtn.addEventListener('click', () => goToSlide(currentSlide - 1));
  nextBtn.addEventListener('click', () => goToSlide(currentSlide + 1));
  dots.addEventListener('click', (e) => {
    const dot = e.target.closest('.${blockName}-dot');
    if (dot) goToSlide(parseInt(dot.dataset.slide, 10));
  });

  // Auto-advance (optional)
  // setInterval(() => goToSlide(currentSlide + 1), 5000);
}
`;
}

function generateCardsJs(blockName: string): string {
  return `export default function decorate(block) {
  [...block.children].forEach((row) => {
    row.classList.add('${blockName}-card');

    const cells = [...row.children];
    if (cells[0]) cells[0].classList.add('${blockName}-card-image');
    if (cells[1]) cells[1].classList.add('${blockName}-card-content');
    if (cells[2]) cells[2].classList.add('${blockName}-card-cta');
  });
}
`;
}

function generateTabsJs(blockName: string): string {
  return `export default function decorate(block) {
  const rows = [...block.children];
  if (rows.length === 0) return;

  // Create tab list
  const tabList = document.createElement('div');
  tabList.className = '${blockName}-tablist';
  tabList.setAttribute('role', 'tablist');

  // Create panels container
  const panels = document.createElement('div');
  panels.className = '${blockName}-panels';

  rows.forEach((row, index) => {
    const cells = [...row.children];
    const titleCell = cells[0];
    const contentCell = cells[1];

    // Create tab button
    const tab = document.createElement('button');
    tab.className = '${blockName}-tab' + (index === 0 ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    tab.textContent = titleCell?.textContent || \`Tab \${index + 1}\`;
    tab.dataset.tab = index.toString();
    tabList.appendChild(tab);

    // Create panel
    const panel = document.createElement('div');
    panel.className = '${blockName}-panel' + (index === 0 ? ' active' : '');
    panel.setAttribute('role', 'tabpanel');
    if (contentCell) panel.appendChild(contentCell);
    panels.appendChild(panel);
  });

  block.innerHTML = '';
  block.appendChild(tabList);
  block.appendChild(panels);

  // Tab switching
  tabList.addEventListener('click', (e) => {
    const tab = e.target.closest('.${blockName}-tab');
    if (!tab) return;

    const index = parseInt(tab.dataset.tab, 10);

    tabList.querySelectorAll('.${blockName}-tab').forEach((t, i) => {
      t.classList.toggle('active', i === index);
      t.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });

    panels.querySelectorAll('.${blockName}-panel').forEach((p, i) => {
      p.classList.toggle('active', i === index);
    });
  });
}
`;
}

function generateAccordionJs(blockName: string): string {
  return `export default function decorate(block) {
  [...block.children].forEach((row, index) => {
    const cells = [...row.children];
    const titleCell = cells[0];
    const contentCell = cells[1];

    row.className = '${blockName}-item';

    // Create header
    const header = document.createElement('button');
    header.className = '${blockName}-header';
    header.setAttribute('aria-expanded', 'false');
    header.innerHTML = \`<span>\${titleCell?.textContent || ''}</span><span class="${blockName}-icon">+</span>\`;

    // Create body
    const body = document.createElement('div');
    body.className = '${blockName}-body';
    if (contentCell) body.appendChild(contentCell);

    row.innerHTML = '';
    row.appendChild(header);
    row.appendChild(body);

    // Toggle functionality
    header.addEventListener('click', () => {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', !expanded);
      row.classList.toggle('open', !expanded);
      header.querySelector('.${blockName}-icon').textContent = expanded ? '+' : '−';
    });
  });
}
`;
}

function generateColumnsJs(blockName: string): string {
  return `export default function decorate(block) {
  const columns = [...block.children];
  block.classList.add(\`${blockName}-\${columns.length}\`);

  columns.forEach((col, index) => {
    col.classList.add('${blockName}-column');

    const cells = [...col.children];
    if (cells[0]) cells[0].classList.add('${blockName}-column-image');
    if (cells[1]) cells[1].classList.add('${blockName}-column-content');
  });
}
`;
}

function generateHeroJs(blockName: string): string {
  return `export default function decorate(block) {
  const row = block.children[0];
  if (!row) return;

  const cells = [...row.children];
  if (cells[0]) cells[0].classList.add('${blockName}-image');
  if (cells[1]) cells[1].classList.add('${blockName}-content');

  // If first cell is image, move it to background
  const firstImg = cells[0]?.querySelector('img');
  if (firstImg) {
    block.classList.add('${blockName}-with-bg');
  }
}
`;
}

function generateDefaultJs(blockName: string): string {
  return `export default function decorate(block) {
  [...block.children].forEach((row) => {
    row.classList.add('${blockName}-row');

    [...row.children].forEach((cell, index) => {
      cell.classList.add('${blockName}-cell');
      cell.classList.add(\`${blockName}-cell-\${index + 1}\`);
    });
  });
}
`;
}

// =============================================================================
// CSS Generation (Template + Customization)
// =============================================================================

/**
 * Generate CSS for the block based on type and styling info
 */
export function generateBlockCss(model: BlockContentModel): string {
  const blockName = model.blockName;
  const styling = model.styling || {};

  switch (model.blockType) {
    case 'carousel':
      return generateCarouselCss(blockName, styling);
    case 'cards':
      return generateCardsCss(blockName, styling);
    case 'tabs':
      return generateTabsCss(blockName, styling);
    case 'accordion':
      return generateAccordionCss(blockName, styling);
    case 'columns':
      return generateColumnsCss(blockName, styling);
    case 'hero':
      return generateHeroCss(blockName, styling);
    default:
      return generateDefaultCss(blockName, styling);
  }
}

function generateCarouselCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName} {
  position: relative;
  overflow: hidden;
}

.${blockName}-wrapper {
  overflow: hidden;
}

.${blockName}-track {
  display: flex;
  transition: transform 0.5s ease-in-out;
}

.${blockName}-slide {
  flex: 0 0 100%;
  display: flex;
  flex-direction: column;
}

@media (min-width: 900px) {
  .${blockName}-slide {
    flex-direction: row;
  }
}

.${blockName}-image {
  flex: 1;
}

.${blockName}-image img {
  width: 100%;
  height: auto;
  object-fit: cover;
}

.${blockName}-content {
  flex: 1;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.${blockName}-content h2 {
  margin: 0 0 1rem;
}

.${blockName}-content p {
  margin: 0 0 1rem;
}

.${blockName}-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.9);
  border: none;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 1.5rem;
  z-index: 10;
  transition: background 0.2s;
}

.${blockName}-nav:hover {
  background: #fff;
}

.${blockName}-nav--prev {
  left: 1rem;
}

.${blockName}-nav--next {
  right: 1rem;
}

.${blockName}-dots {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  padding: 1rem;
}

.${blockName}-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: none;
  background: #ccc;
  cursor: pointer;
  transition: background 0.2s;
}

.${blockName}-dot.active,
.${blockName}-dot:hover {
  background: #333;
}
`;
}

function generateCardsCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName} {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
}

.${blockName}-card {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  background: #fff;
}

.${blockName}-card-image img {
  width: 100%;
  height: auto;
  aspect-ratio: 16/9;
  object-fit: cover;
}

.${blockName}-card-content {
  padding: 1.5rem;
}

.${blockName}-card-content h2,
.${blockName}-card-content h3 {
  margin: 0 0 0.5rem;
}

.${blockName}-card-content p {
  margin: 0 0 1rem;
  color: #666;
}

.${blockName}-card-cta {
  padding: 0 1.5rem 1.5rem;
}
`;
}

function generateTabsCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName}-tablist {
  display: flex;
  border-bottom: 1px solid #ddd;
}

.${blockName}-tab {
  padding: 1rem 1.5rem;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 1rem;
  color: #666;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.${blockName}-tab.active,
.${blockName}-tab:hover {
  color: #333;
  border-bottom-color: #333;
}

.${blockName}-panel {
  display: none;
  padding: 2rem;
}

.${blockName}-panel.active {
  display: block;
}
`;
}

function generateAccordionCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName}-item {
  border-bottom: 1px solid #ddd;
}

.${blockName}-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 1rem;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  text-align: left;
}

.${blockName}-header:hover {
  background: #f5f5f5;
}

.${blockName}-icon {
  font-size: 1.5rem;
  color: #666;
}

.${blockName}-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
}

.${blockName}-item.open .${blockName}-body {
  max-height: 500px;
  padding: 0 1rem 1rem;
}
`;
}

function generateColumnsCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName} {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
}

.${blockName}-column {
  flex: 1;
  min-width: 250px;
}

.${blockName}-column-image img {
  width: 100%;
  height: auto;
}

.${blockName}-column-content h2,
.${blockName}-column-content h3 {
  margin: 1rem 0 0.5rem;
}

.${blockName}-column-content p {
  margin: 0;
  color: #666;
}

.${blockName}-2 .${blockName}-column {
  flex: 0 0 calc(50% - 1rem);
}

.${blockName}-3 .${blockName}-column {
  flex: 0 0 calc(33.333% - 1.33rem);
}

.${blockName}-4 .${blockName}-column {
  flex: 0 0 calc(25% - 1.5rem);
}

@media (max-width: 768px) {
  .${blockName}-column {
    flex: 0 0 100%;
  }
}
`;
}

function generateHeroCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName} {
  position: relative;
  min-height: 400px;
}

.${blockName}-with-bg .${blockName}-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
}

.${blockName}-with-bg .${blockName}-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.${blockName}-with-bg .${blockName}-content {
  position: relative;
  z-index: 1;
  padding: 4rem 2rem;
  max-width: 600px;
}

.${blockName}-content h1,
.${blockName}-content h2 {
  margin: 0 0 1rem;
  font-size: 2.5rem;
}

.${blockName}-content p {
  margin: 0 0 1.5rem;
  font-size: 1.25rem;
}
`;
}

function generateDefaultCss(blockName: string, styling: BlockContentModel['styling']): string {
  return `.${blockName} {
  padding: 2rem 0;
}

.${blockName}-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1rem;
}

.${blockName}-cell {
  flex: 1;
  min-width: 200px;
}

.${blockName}-cell img {
  width: 100%;
  height: auto;
}
`;
}

// =============================================================================
// Full Block Generation (Deterministic)
// =============================================================================

/**
 * Generate complete block (HTML + CSS + JS) from content model
 *
 * This is the deterministic generation path - no LLM involved.
 * Use this for reliable, faithful content reproduction.
 */
export function generateBlockFromModel(model: BlockContentModel): GeneratedBlock {
  return {
    blockName: model.blockName,
    html: generateBlockHtml(model),
    css: generateBlockCss(model),
    js: generateBlockJs(model),
  };
}

// =============================================================================
// LLM-Enhanced Generation (For styling refinement)
// =============================================================================

/**
 * Generate block with LLM assistance for styling
 *
 * Uses the content model as the source of truth for content,
 * but allows LLM to enhance styling based on screenshot.
 */
export async function generateBlockWithStyling(
  model: BlockContentModel,
  screenshotBase64: string,
  extractedCssStyles: string,
  config: AnthropicConfig
): Promise<GeneratedBlock> {
  // Start with deterministic generation
  const baseBlock = generateBlockFromModel(model);

  // Build prompt for styling enhancement only
  const prompt = buildStylingPrompt(model, baseBlock, extractedCssStyles);

  // Call LLM for CSS enhancement
  const enhancedCss = await callClaudeForStyling(
    screenshotBase64,
    prompt,
    config
  );

  return {
    ...baseBlock,
    css: enhancedCss || baseBlock.css,
  };
}

function buildStylingPrompt(
  model: BlockContentModel,
  baseBlock: GeneratedBlock,
  extractedCssStyles: string
): string {
  return `Enhance the CSS for this ${model.blockType} block to match the screenshot.

EXTRACTED CSS VALUES FROM ORIGINAL PAGE:
${extractedCssStyles}

CURRENT CSS (enhance this):
${baseBlock.css}

HTML STRUCTURE (do not change, for reference only):
${baseBlock.html}

REQUIREMENTS:
1. Use the EXACT colors from EXTRACTED CSS VALUES above
2. Match fonts, spacing, and layout from the original
3. Keep the same selector structure
4. DO NOT add section/container backgrounds (those are controlled separately)
5. Focus on: colors, typography, spacing, shadows, borders, button styles

Return ONLY the enhanced CSS code, no explanation.`;
}

async function callClaudeForStyling(
  imageBase64: string,
  prompt: string,
  config: AnthropicConfig
): Promise<string | null> {
  try {
    let response: Response;

    if (config.useBedrock && config.bedrockToken) {
      const region = config.bedrockRegion || 'us-east-1';
      const model = config.bedrockModel || 'anthropic.claude-sonnet-4-20250514-v1:0';
      const bedrockUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;

      response = await fetch(bedrockUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.bedrockToken}`,
        },
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
    } else if (config.apiKey) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
    } else {
      return null;
    }

    if (!response.ok) {
      console.error('Claude API error for styling:', response.status);
      return null;
    }

    const result = await response.json() as { content: Array<{ type: string; text?: string }> };
    const textContent = result.content?.find(c => c.type === 'text');

    if (textContent?.text) {
      // Extract CSS from response (may be in code block)
      const cssMatch = textContent.text.match(/```css\s*([\s\S]*?)```/) ||
                       textContent.text.match(/```\s*([\s\S]*?)```/);
      return cssMatch ? cssMatch[1].trim() : textContent.text.trim();
    }

    return null;
  } catch (error) {
    console.error('Error calling Claude for styling:', error);
    return null;
  }
}
