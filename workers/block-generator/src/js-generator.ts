import { LayoutAnalysis, LayoutPattern } from './types';

/**
 * Generates the JavaScript decoration function for a block
 */
export function generateJS(analysis: LayoutAnalysis): string {
  const { blockName, pattern, structure } = analysis;

  switch (pattern) {
    case 'grid':
      return generateGridJS(blockName, structure.hasImages);
    case 'columns':
      return generateColumnsJS(blockName, structure.columnCount);
    case 'hero':
      return generateHeroJS(blockName);
    case 'media-text':
      return generateMediaTextJS(blockName);
    case 'list':
      return generateListJS(blockName);
    case 'accordion':
      return generateAccordionJS(blockName);
    case 'text-only':
      return generateTextOnlyJS(blockName);
    case 'single-image':
      return generateSingleImageJS(blockName);
    default:
      return generateDefaultJS(blockName);
  }
}

function generateGridJS(blockName: string, hasImages: boolean): string {
  const imageOptimization = hasImages
    ? `
  // Optimize images
  ul.querySelectorAll('picture > img').forEach((img) => {
    img.closest('picture').replaceWith(
      createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }])
    );
  });`
    : '';

  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  // Transform rows into list items
  const ul = document.createElement('ul');
  [...block.children].forEach((row) => {
    const li = document.createElement('li');
    while (row.firstElementChild) li.append(row.firstElementChild);

    // Classify cells
    [...li.children].forEach((div) => {
      if (div.children.length === 1 && div.querySelector('picture')) {
        div.className = '${blockName}-card-image';
      } else {
        div.className = '${blockName}-card-body';
      }
    });

    ul.append(li);
  });
${imageOptimization}
  block.replaceChildren(ul);
}
`;
}

function generateColumnsJS(blockName: string, columnCount: number): string {
  return `export default function decorate(block) {
  const cols = [...block.firstElementChild.children];
  block.classList.add(\`${blockName}-\${cols.length}-cols\`);

  // Setup image columns
  [...block.children].forEach((row) => {
    [...row.children].forEach((col) => {
      const pic = col.querySelector('picture');
      if (pic) {
        const picWrapper = pic.closest('div');
        if (picWrapper && picWrapper.children.length === 1) {
          picWrapper.classList.add('${blockName}-img-col');
        }
      }
    });
  });
}
`;
}

function generateHeroJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  // Find the image and content sections
  const rows = [...block.children];

  rows.forEach((row) => {
    const cells = [...row.children];
    cells.forEach((cell) => {
      const pic = cell.querySelector('picture');
      if (pic) {
        cell.classList.add('${blockName}-image');
        // Optimize hero image with eager loading
        const img = pic.querySelector('img');
        if (img) {
          pic.replaceWith(
            createOptimizedPicture(img.src, img.alt, true, [{ width: '2000' }])
          );
        }
      } else if (cell.querySelector('h1, h2, h3, h4, h5, h6')) {
        cell.classList.add('${blockName}-content');
      }
    });
  });
}
`;
}

function generateMediaTextJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const row = block.firstElementChild;
  if (!row) return;

  const cells = [...row.children];

  cells.forEach((cell, index) => {
    const pic = cell.querySelector('picture');
    if (pic) {
      cell.classList.add('${blockName}-media');
      // Optimize image
      const img = pic.querySelector('img');
      if (img) {
        pic.replaceWith(
          createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }])
        );
      }
    } else {
      cell.classList.add('${blockName}-text');
    }
  });

  // Add orientation class based on image position
  const firstCell = cells[0];
  if (firstCell?.querySelector('picture')) {
    block.classList.add('${blockName}-media-left');
  } else {
    block.classList.add('${blockName}-media-right');
  }
}
`;
}

function generateListJS(blockName: string): string {
  return `export default function decorate(block) {
  const list = block.querySelector('ul, ol');
  if (list) {
    list.classList.add('${blockName}-items');

    // Add classes to list items
    [...list.children].forEach((li) => {
      li.classList.add('${blockName}-item');

      // Check for icons or images
      const icon = li.querySelector('picture, img, svg');
      if (icon) {
        li.classList.add('${blockName}-item-with-icon');
      }
    });
  }
}
`;
}

function generateAccordionJS(blockName: string): string {
  return `export default function decorate(block) {
  const items = [...block.children];

  items.forEach((item) => {
    const cells = [...item.children];
    if (cells.length >= 2) {
      const header = cells[0];
      const content = cells[1];

      // Create accordion structure
      header.classList.add('${blockName}-header');
      content.classList.add('${blockName}-content');

      // Add toggle functionality
      header.addEventListener('click', () => {
        item.classList.toggle('${blockName}-open');
      });

      // Add accessibility
      header.setAttribute('role', 'button');
      header.setAttribute('aria-expanded', 'false');
      content.setAttribute('aria-hidden', 'true');
    }
  });
}
`;
}

function generateTextOnlyJS(blockName: string): string {
  return `export default function decorate(block) {
  // Add semantic classes to text elements
  block.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    heading.classList.add('${blockName}-heading');
  });

  block.querySelectorAll('p').forEach((p) => {
    p.classList.add('${blockName}-text');
  });

  // Style links as buttons if they're standalone
  block.querySelectorAll('p > a:only-child').forEach((link) => {
    link.classList.add('${blockName}-cta');
  });
}
`;
}

function generateSingleImageJS(blockName: string): string {
  return `import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const pic = block.querySelector('picture');
  if (pic) {
    const img = pic.querySelector('img');
    if (img) {
      // Create optimized responsive picture
      pic.replaceWith(
        createOptimizedPicture(img.src, img.alt, false, [
          { media: '(min-width: 600px)', width: '2000' },
          { width: '750' },
        ])
      );
    }
  }

  // Check for caption
  const caption = block.querySelector('figcaption, p');
  if (caption && !caption.querySelector('picture')) {
    caption.classList.add('${blockName}-caption');
  }
}
`;
}

function generateDefaultJS(blockName: string): string {
  return `export default function decorate(block) {
  // Add classes to rows and cells
  [...block.children].forEach((row, rowIndex) => {
    row.classList.add('${blockName}-row', \`${blockName}-row-\${rowIndex + 1}\`);

    [...row.children].forEach((cell, cellIndex) => {
      cell.classList.add('${blockName}-cell', \`${blockName}-cell-\${cellIndex + 1}\`);

      // Detect and mark image cells
      if (cell.children.length === 1 && cell.querySelector('picture')) {
        cell.classList.add('${blockName}-img-col');
      }
    });
  });
}
`;
}
