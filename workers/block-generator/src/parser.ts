import { parseHTML } from 'linkedom';
import { BlockGeneratorError, ExtractedContent } from './types';

/**
 * Parses HTML and extracts content matching the CSS selector
 */
export function extractContent(html: string, selector: string): ExtractedContent {
  let document;

  try {
    const parsed = parseHTML(html);
    document = parsed.document;
  } catch (error) {
    throw new BlockGeneratorError(
      `Failed to parse HTML: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PARSE_ERROR'
    );
  }

  const element = document.querySelector(selector);

  if (!element) {
    throw new BlockGeneratorError(
      `Selector "${selector}" did not match any elements`,
      'SELECTOR_NOT_FOUND'
    );
  }

  return {
    outerHTML: element.outerHTML,
    innerHTML: element.innerHTML,
    tagName: element.tagName.toLowerCase(),
    className: element.className || '',
    childCount: element.children.length,
  };
}

/**
 * Parses HTML string and returns the document for further analysis
 */
export function parseHTMLDocument(html: string) {
  try {
    const { document } = parseHTML(html);
    return document;
  } catch (error) {
    throw new BlockGeneratorError(
      `Failed to parse HTML: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PARSE_ERROR'
    );
  }
}

/**
 * Gets an element from a document by selector
 */
export function getElement(document: Document, selector: string): Element {
  const element = document.querySelector(selector);

  if (!element) {
    throw new BlockGeneratorError(
      `Selector "${selector}" did not match any elements`,
      'SELECTOR_NOT_FOUND'
    );
  }

  return element;
}
