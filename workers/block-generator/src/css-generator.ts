import { LayoutAnalysis, LayoutPattern } from './types';

/**
 * Generates the CSS styles for a block
 */
export function generateCSS(analysis: LayoutAnalysis): string {
  const { blockName, pattern, structure } = analysis;

  switch (pattern) {
    case 'grid':
      return generateGridCSS(blockName, structure.rowCount);
    case 'columns':
      return generateColumnsCSS(blockName, structure.columnCount);
    case 'hero':
      return generateHeroCSS(blockName);
    case 'media-text':
      return generateMediaTextCSS(blockName);
    case 'list':
      return generateListCSS(blockName);
    case 'accordion':
      return generateAccordionCSS(blockName);
    case 'text-only':
      return generateTextOnlyCSS(blockName);
    case 'single-image':
      return generateSingleImageCSS(blockName);
    default:
      return generateDefaultCSS(blockName);
  }
}

function generateGridCSS(blockName: string, itemCount: number): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName} > ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 24px;
}

.${blockName} > ul > li {
  background-color: var(--background-color);
  border: 1px solid var(--light-color, #eee);
  border-radius: 8px;
  overflow: hidden;
  transition: box-shadow 0.2s ease;
}

.${blockName} > ul > li:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.${blockName}-card-image {
  line-height: 0;
}

.${blockName}-card-image picture,
.${blockName}-card-image img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}

.${blockName}-card-body {
  padding: 16px;
}

.${blockName}-card-body h2,
.${blockName}-card-body h3,
.${blockName}-card-body h4 {
  margin: 0 0 8px;
  font-size: var(--heading-font-size-s, 20px);
}

.${blockName}-card-body p {
  margin: 0;
  color: var(--text-color, #333);
}

@media (min-width: 900px) {
  .${blockName} > ul {
    grid-template-columns: repeat(${Math.min(itemCount, 4)}, 1fr);
  }
}
`;
}

function generateColumnsCSS(blockName: string, columnCount: number): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName} > div {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.${blockName} > div > div {
  flex: 1;
}

.${blockName}-img-col {
  line-height: 0;
}

.${blockName}-img-col picture,
.${blockName}-img-col img {
  width: 100%;
  height: auto;
  border-radius: 8px;
}

@media (min-width: 900px) {
  .${blockName} > div {
    flex-direction: row;
    align-items: flex-start;
  }

  .${blockName}-${columnCount}-cols > div > div {
    flex: 1 1 ${Math.floor(100 / columnCount)}%;
  }
}
`;
}

function generateHeroCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  position: relative;
  min-height: 400px;
  display: flex;
  flex-direction: column;
}

.${blockName}-image {
  position: absolute;
  inset: 0;
  z-index: -1;
}

.${blockName}-image picture,
.${blockName}-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.${blockName}-content {
  padding: 60px 20px;
  max-width: 800px;
  margin: auto;
  text-align: center;
  color: var(--background-color, #fff);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.${blockName}-content h1,
.${blockName}-content h2 {
  font-size: var(--heading-font-size-xxl, 48px);
  margin: 0 0 16px;
}

.${blockName}-content p {
  font-size: var(--body-font-size-m, 20px);
  margin: 0 0 24px;
}

.${blockName}-content a {
  display: inline-block;
  padding: 12px 24px;
  background-color: var(--link-color, #3b63fb);
  color: var(--background-color, #fff);
  text-decoration: none;
  border-radius: 4px;
  font-weight: 600;
  transition: background-color 0.2s ease;
}

.${blockName}-content a:hover {
  background-color: var(--link-hover-color, #1d3ecf);
}

@media (min-width: 900px) {
  .${blockName} {
    min-height: 500px;
  }

  .${blockName}-content {
    padding: 80px 40px;
  }
}
`;
}

function generateMediaTextCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName} > div {
  display: flex;
  flex-direction: column;
  gap: 32px;
  align-items: center;
}

.${blockName}-media,
.${blockName}-text {
  flex: 1;
}

.${blockName}-media {
  line-height: 0;
}

.${blockName}-media picture,
.${blockName}-media img {
  width: 100%;
  height: auto;
  border-radius: 8px;
}

.${blockName}-text h2,
.${blockName}-text h3 {
  margin: 0 0 16px;
  font-size: var(--heading-font-size-l, 32px);
}

.${blockName}-text p {
  margin: 0 0 16px;
  line-height: 1.6;
}

.${blockName}-text a {
  display: inline-block;
  padding: 12px 24px;
  background-color: var(--link-color, #3b63fb);
  color: var(--background-color, #fff);
  text-decoration: none;
  border-radius: 4px;
  font-weight: 600;
}

@media (min-width: 900px) {
  .${blockName} > div {
    flex-direction: row;
  }

  .${blockName}.${blockName}-media-right > div {
    flex-direction: row-reverse;
  }

  .${blockName}-media,
  .${blockName}-text {
    flex: 1 1 50%;
  }
}
`;
}

function generateListCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName}-items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.${blockName}-item {
  padding: 16px 0;
  border-bottom: 1px solid var(--light-color, #eee);
}

.${blockName}-item:last-child {
  border-bottom: none;
}

.${blockName}-item-with-icon {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.${blockName}-item-with-icon picture,
.${blockName}-item-with-icon img,
.${blockName}-item-with-icon svg {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.${blockName}-item h3,
.${blockName}-item h4 {
  margin: 0 0 8px;
  font-size: var(--heading-font-size-s, 18px);
}

.${blockName}-item p {
  margin: 0;
  color: var(--text-color, #333);
}
`;
}

function generateAccordionCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName} > div {
  border: 1px solid var(--light-color, #eee);
  border-radius: 8px;
  margin-bottom: -1px;
}

.${blockName} > div:first-child {
  border-radius: 8px 8px 0 0;
}

.${blockName} > div:last-child {
  border-radius: 0 0 8px 8px;
  margin-bottom: 0;
}

.${blockName}-header {
  padding: 16px 20px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: var(--light-color, #f8f8f8);
  transition: background-color 0.2s ease;
}

.${blockName}-header:hover {
  background-color: var(--background-color, #fff);
}

.${blockName}-header::after {
  content: '+';
  font-size: 24px;
  font-weight: 300;
  color: var(--text-color, #333);
  transition: transform 0.2s ease;
}

.${blockName}-open .${blockName}-header::after {
  transform: rotate(45deg);
}

.${blockName}-content {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.${blockName}-open .${blockName}-content {
  max-height: 500px;
  padding: 16px 20px;
}

.${blockName}-content p {
  margin: 0;
  line-height: 1.6;
}
`;
}

function generateTextOnlyCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
  max-width: 800px;
  margin: 0 auto;
}

.${blockName}-heading {
  margin: 0 0 16px;
  font-size: var(--heading-font-size-l, 32px);
}

.${blockName}-text {
  margin: 0 0 16px;
  line-height: 1.6;
  color: var(--text-color, #333);
}

.${blockName}-text:last-child {
  margin-bottom: 0;
}

.${blockName}-cta {
  display: inline-block;
  padding: 12px 24px;
  background-color: var(--link-color, #3b63fb);
  color: var(--background-color, #fff);
  text-decoration: none;
  border-radius: 4px;
  font-weight: 600;
  transition: background-color 0.2s ease;
}

.${blockName}-cta:hover {
  background-color: var(--link-hover-color, #1d3ecf);
}
`;
}

function generateSingleImageCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
  text-align: center;
}

.${blockName} picture,
.${blockName} img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

.${blockName}-caption {
  margin: 16px 0 0;
  font-size: var(--body-font-size-s, 14px);
  color: var(--dark-color, #666);
  font-style: italic;
}
`;
}

function generateDefaultCSS(blockName: string): string {
  return `/* ${blockName} block styles */
.${blockName} {
  padding: 40px 0;
}

.${blockName}-row {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 16px;
}

.${blockName}-row:last-child {
  margin-bottom: 0;
}

.${blockName}-cell {
  flex: 1;
}

.${blockName}-img-col {
  line-height: 0;
}

.${blockName}-img-col picture,
.${blockName}-img-col img {
  width: 100%;
  height: auto;
  border-radius: 8px;
}

@media (min-width: 900px) {
  .${blockName}-row {
    flex-direction: row;
    align-items: flex-start;
  }
}
`;
}
