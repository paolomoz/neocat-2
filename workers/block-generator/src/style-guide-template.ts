/**
 * Style Guide Template
 * Defines the structure of the design system preview page.
 * This template is used when generating preview pages during design system import.
 */

import type { ExtractedDesign } from './types';

/** Escape HTML special characters */
function escape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate the complete style guide HTML from an extracted design
 */
export function generateStyleGuideHTML(design: ExtractedDesign, sourceUrl: string): string {
  return `<body>
  <header></header>
  <main>
${renderIntro(sourceUrl)}
${renderFoundation(design)}
${renderComponents(design)}
${renderStructureLayout(design)}
  </main>
  <footer></footer>
</body>`;
}

// =============================================================================
// Section Renderers
// =============================================================================

function renderIntro(sourceUrl: string): string {
  return `    <div>
      <h1>Style Guide</h1>
      <p>Design system imported from <a href="${sourceUrl}">${sourceUrl}</a></p>
    </div>

    <hr/>`;
}

function renderFoundation(design: ExtractedDesign): string {
  return `
    <div>
      <h2>Foundation</h2>
    </div>

${renderColors(design)}
${renderTypographyFoundation(design)}
${renderSpacing(design)}
${renderBorder(design)}`;
}

function renderColors(design: ExtractedDesign): string {
  const colors = [
    { name: 'Primary', value: design.colors.primary },
    { name: 'Secondary', value: design.colors.secondary },
    { name: 'Link', value: design.colors.link },
    { name: 'Text', value: design.colors.text },
    { name: 'Background', value: design.colors.background },
    { name: 'Dark', value: design.colors.dark },
  ];

  const swatches = colors.map(c => `
    <div>
      <table>
        <tr>
          <th>color-swatch</th>
        </tr>
        <tr>
          <td>
            <p>${c.name}</p>
            <p>${c.value}</p>
          </td>
        </tr>
      </table>
    </div>`).join('\n');

  return `    <div>
      <h3>Color</h3>
      <p>Core color palette extracted from the source website.</p>
    </div>
${swatches}

    <hr/>`;
}

function renderTypographyFoundation(design: ExtractedDesign): string {
  return `    <div>
      <h3>Typography</h3>
    </div>

    <div>
      <h4>Heading Font</h4>
      <p><strong>${escape(design.typography.headingFont)}</strong></p>
      <p>Weight: ${design.typography.headingFontWeight || '600'}</p>
    </div>

    <div>
      <h4>Body Font</h4>
      <p><strong>${escape(design.typography.bodyFont)}</strong></p>
      <p>Line height: ${design.typography.lineHeight}</p>
    </div>

    <div>
      <h4>Type Scale</h4>
    </div>

    <div>
      <table>
        <tr>
          <th>type-scale</th>
        </tr>
        <tr>
          <td>
            <p>XXL</p>
            <p>${design.typography.headingSizes.xxl}</p>
          </td>
          <td>
            <p>XL</p>
            <p>${design.typography.headingSizes.xl}</p>
          </td>
          <td>
            <p>L</p>
            <p>${design.typography.headingSizes.l}</p>
          </td>
          <td>
            <p>M</p>
            <p>${design.typography.headingSizes.m}</p>
          </td>
          <td>
            <p>S</p>
            <p>${design.typography.headingSizes.s}</p>
          </td>
          <td>
            <p>XS</p>
            <p>${design.typography.headingSizes.xs}</p>
          </td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderSpacing(design: ExtractedDesign): string {
  return `    <div>
      <h3>Spacing</h3>
    </div>

    <div>
      <table>
        <tr>
          <th>spacing</th>
        </tr>
        <tr>
          <td>
            <p>Section Padding</p>
            <p>${design.layout.sectionPadding}</p>
          </td>
          <td>
            <p>Max Width</p>
            <p>${design.layout.maxWidth}</p>
          </td>
          <td>
            <p>Nav Height</p>
            <p>${design.layout.navHeight}</p>
          </td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderBorder(design: ExtractedDesign): string {
  return `    <div>
      <h3>Border</h3>
    </div>

    <div>
      <table>
        <tr>
          <th>border-radius</th>
        </tr>
        <tr>
          <td>
            <p>Button Radius</p>
            <p>${design.buttons.borderRadius}</p>
          </td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderComponents(design: ExtractedDesign): string {
  return `
    <div>
      <h2>Components</h2>
    </div>

${renderTypographyComponents()}
${renderButtons()}
${renderTextButtons()}
${renderLinks(design)}
${renderLists()}
${renderBlockquote()}
${renderImages()}
${renderColumns()}
${renderCards()}
${renderDivider()}
${renderRichText()}`;
}

function renderTypographyComponents(): string {
  const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const samples = headings.map((h, i) => `
    <div>
      <${h}>Heading ${i + 1}</${h}>
      <p>The quick brown fox jumps over the lazy dog.</p>
    </div>`).join('\n');

  return `    <div>
      <h3>Typography</h3>
    </div>
${samples}

    <hr/>`;
}

function renderButtons(): string {
  return `    <div>
      <h3>Buttons</h3>
    </div>

    <div>
      <h4>Primary Button</h4>
      <p><a href="#">Button Label</a></p>
      <p><a href="#">Button with Longer Label</a></p>
    </div>

    <div>
      <h4>Secondary Button</h4>
      <p><a href="#"><em>Button Label</em></a></p>
      <p><a href="#"><em>Button with Longer Label</em></a></p>
    </div>

    <hr/>`;
}

function renderTextButtons(): string {
  return `    <div>
      <h4>Text Button</h4>
      <p><a href="#">Learn More</a></p>
      <p><a href="#">View Details</a></p>
    </div>

    <div>
      <table>
        <tr>
          <th>Section Metadata</th>
        </tr>
        <tr>
          <td>Style</td>
          <td>text-buttons</td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderLinks(design: ExtractedDesign): string {
  return `    <div>
      <h3>Links</h3>
    </div>

    <div>
      <p>This is a paragraph with an <a href="#">inline link</a> that demonstrates the link styling. Links use the color ${design.colors.link} and change to ${design.colors.linkHover} on hover.</p>
    </div>

    <hr/>`;
}

function renderLists(): string {
  return `    <div>
      <h3>Lists</h3>
    </div>

    <div>
      <h4>Unordered List</h4>
      <ul>
        <li>First list item</li>
        <li>Second list item with more text to demonstrate wrapping behavior across multiple lines</li>
        <li>Third list item
          <ul>
            <li>Nested item one</li>
            <li>Nested item two</li>
          </ul>
        </li>
        <li>Fourth list item</li>
      </ul>
    </div>

    <div>
      <h4>Ordered List</h4>
      <ol>
        <li>First numbered item</li>
        <li>Second numbered item</li>
        <li>Third numbered item
          <ol>
            <li>Nested numbered item</li>
            <li>Another nested item</li>
          </ol>
        </li>
        <li>Fourth numbered item</li>
      </ol>
    </div>

    <hr/>`;
}

function renderBlockquote(): string {
  return `    <div>
      <h3>Blockquote</h3>
    </div>

    <div>
      <blockquote>
        <p>"Design is not just what it looks like and feels like. Design is how it works."</p>
      </blockquote>
      <p>— Steve Jobs</p>
    </div>

    <hr/>`;
}

function renderImages(): string {
  return `    <div>
      <h3>Images</h3>
    </div>

    <div>
      <p><img src="/icons/image-placeholder.svg" alt="Sample image placeholder"></p>
      <p><em>Image caption example</em></p>
    </div>

    <hr/>`;
}

function renderColumns(): string {
  return `    <div>
      <h3>Columns</h3>
    </div>

    <div>
      <table>
        <tr>
          <th>Columns</th>
        </tr>
        <tr>
          <td>
            <p><strong>Column 1</strong></p>
            <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
          </td>
          <td>
            <p><strong>Column 2</strong></p>
            <p>Sed do eiusmod tempor incididunt ut labore et dolore.</p>
          </td>
          <td>
            <p><strong>Column 3</strong></p>
            <p>Ut enim ad minim veniam, quis nostrud exercitation.</p>
          </td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderCards(): string {
  return `    <div>
      <h3>Cards</h3>
    </div>

    <div>
      <table>
        <tr>
          <th>Cards</th>
        </tr>
        <tr>
          <td>
            <p><strong>Card Title</strong></p>
            <p>Card description text goes here. This demonstrates how card content looks.</p>
            <p><a href="#">Learn More</a></p>
          </td>
          <td>
            <p><strong>Card Title</strong></p>
            <p>Another card with similar content structure for comparison.</p>
            <p><a href="#">Learn More</a></p>
          </td>
          <td>
            <p><strong>Card Title</strong></p>
            <p>Third card completing the row of three cards.</p>
            <p><a href="#">Learn More</a></p>
          </td>
        </tr>
      </table>
    </div>

    <hr/>`;
}

function renderDivider(): string {
  return `    <div>
      <h3>Divider</h3>
    </div>

    <hr/>`;
}

function renderRichText(): string {
  return `    <div>
      <h3>Rich Text</h3>
    </div>

    <div>
      <p>This section demonstrates <strong>bold text</strong>, <em>italic text</em>, and <strong><em>bold italic text</em></strong>. You can also use <code>inline code</code> for technical terms.</p>
      <p>Here is a <a href="#">text link</a> and here is <u>underlined text</u> for emphasis.</p>
    </div>

    <hr/>`;
}

function renderStructureLayout(design: ExtractedDesign): string {
  return `
    <div>
      <h2>Structure &amp; Layout</h2>
    </div>

    <div>
      <h3>Section Backgrounds</h3>
    </div>

    <div>
      <table>
        <tr>
          <th>Section Metadata</th>
        </tr>
        <tr>
          <td>Style</td>
          <td>highlight</td>
        </tr>
      </table>
    </div>

    <div>
      <p>This section demonstrates the highlight/light background style using the light color: ${design.colors.light}</p>
      <p><a href="#">Call to Action Button</a></p>
    </div>

    <div>
      <table>
        <tr>
          <th>Section Metadata</th>
        </tr>
        <tr>
          <td>Style</td>
          <td>dark</td>
        </tr>
      </table>
    </div>

    <div>
      <p>This section demonstrates the dark background style using the dark color: ${design.colors.dark}</p>
      <p><a href="#">Call to Action Button</a></p>
    </div>`;
}
