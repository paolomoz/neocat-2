// ============================================
// Vectorize Embedding Service
// ============================================
//
// Provides semantic search capabilities for blocks using
// Cloudflare Vectorize and Workers AI embeddings.

import { Env, Block } from './types';

// BGE Base English model - 768 dimensions, good balance of quality and speed
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

// ============================================
// Types
// ============================================

export interface EmbeddingInput {
  blockId: string;
  blockName: string;
  html: string;
  description: string;
  qualityTier: string;
  qualityScore: number;
  siteId: string;
}

export interface SearchOptions {
  topK?: number;
  minQuality?: number;
  tier?: string;
  siteId?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: {
    blockName: string;
    qualityTier: string;
    qualityScore: number;
    siteId: string;
  };
}

// ============================================
// Embedding Text Generation
// ============================================

/**
 * Build the text to be embedded for a block.
 * Combines block name, description, and HTML structure.
 */
export function buildEmbeddingText(input: EmbeddingInput): string {
  const parts = [
    `Block Type: ${input.blockName}`,
    `Quality: ${input.qualityTier} (score: ${input.qualityScore})`,
    '',
    `Description: ${input.description}`,
    '',
    'HTML Structure:',
    input.html,
  ];

  // Limit to ~8000 chars to stay within model limits
  return parts.join('\n').slice(0, 8000);
}

/**
 * Generate a text description from block data for embedding.
 * Used when description is not already available.
 */
export function generateBlockDescription(block: Block): string {
  const parts: string[] = [];

  // Block type and variant
  parts.push(`A ${block.block_name} block`);
  if (block.block_variant) {
    parts.push(`(${block.block_variant} variant)`);
  }

  // Quality information
  if (block.quality_tier && block.quality_tier !== 'unrated') {
    parts.push(`with ${block.quality_tier} quality`);
  }

  // Content characteristics from HTML analysis
  const html = block.cleaned_html || block.html || '';

  if (html.includes('<img') || html.includes('<picture')) {
    parts.push('containing images');
  }
  if (html.includes('<video')) {
    parts.push('with video content');
  }
  if (html.includes('<a ')) {
    const linkCount = (html.match(/<a /g) || []).length;
    parts.push(`with ${linkCount} link${linkCount > 1 ? 's' : ''}`);
  }
  if (html.includes('<ul') || html.includes('<ol')) {
    parts.push('with list elements');
  }
  if (html.includes('<form')) {
    parts.push('containing a form');
  }

  // Headings
  const headings = html.match(/<h[1-6][^>]*>([^<]*)</gi);
  if (headings && headings.length > 0) {
    const headingTexts = headings
      .map(h => h.replace(/<[^>]+>/g, '').trim())
      .filter(t => t.length > 0)
      .slice(0, 3);
    if (headingTexts.length > 0) {
      parts.push(`with headings: "${headingTexts.join('", "')}"`);
    }
  }

  // Interactivity
  if (block.has_javascript) {
    parts.push('with JavaScript functionality');
  }
  if (block.has_interactivity) {
    parts.push('with interactive elements');
  }

  return parts.join(' ');
}

// ============================================
// Embedding Generation
// ============================================

/**
 * Generate an embedding vector for the given text using Workers AI.
 */
export async function generateEmbedding(
  ai: Ai,
  text: string
): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, {
    text: [text],
  }) as { data: number[][] };

  // Workers AI returns { data: number[][] }
  if (!result.data || !result.data[0]) {
    throw new Error('Failed to generate embedding: no data returned');
  }

  return result.data[0];
}

// ============================================
// Vectorize Operations
// ============================================

/**
 * Upsert a block's embedding into Vectorize.
 */
export async function upsertBlockEmbedding(
  env: Env,
  input: EmbeddingInput
): Promise<void> {
  const text = buildEmbeddingText(input);
  const vector = await generateEmbedding(env.AI, text);

  await env.VECTOR_INDEX.upsert([
    {
      id: input.blockId,
      values: vector,
      metadata: {
        blockName: input.blockName,
        qualityTier: input.qualityTier,
        qualityScore: input.qualityScore,
        siteId: input.siteId,
      },
    },
  ]);
}

/**
 * Delete a block's embedding from Vectorize.
 */
export async function deleteBlockEmbedding(
  env: Env,
  blockId: string
): Promise<void> {
  await env.VECTOR_INDEX.deleteByIds([blockId]);
}

/**
 * Search for blocks similar to the query text.
 */
export async function searchBlocks(
  env: Env,
  query: string,
  options?: SearchOptions
): Promise<SearchResult[]> {
  const vector = await generateEmbedding(env.AI, query);

  // Build metadata filter
  // Note: Vectorize only supports equality filters, not numeric comparisons
  const filter: Record<string, string> = {};
  if (options?.tier) {
    filter.qualityTier = options.tier;
  }
  if (options?.siteId) {
    filter.siteId = options.siteId;
  }

  const results = await env.VECTOR_INDEX.query(vector, {
    topK: options?.topK || 20,
    returnMetadata: 'all',
    filter: Object.keys(filter).length > 0 ? filter : undefined,
  });

  // Post-filter by minQuality since Vectorize doesn't support numeric filters
  let matches = results.matches || [];
  if (options?.minQuality) {
    matches = matches.filter(
      (m) => (m.metadata?.qualityScore as number) >= options.minQuality!
    );
  }

  return matches.map((m) => ({
    id: m.id,
    score: m.score,
    metadata: {
      blockName: (m.metadata?.blockName as string) || '',
      qualityTier: (m.metadata?.qualityTier as string) || 'unrated',
      qualityScore: (m.metadata?.qualityScore as number) || 0,
      siteId: (m.metadata?.siteId as string) || '',
    },
  }));
}

// ============================================
// Batch Operations
// ============================================

/**
 * Upsert multiple block embeddings in a batch.
 * More efficient than individual upserts.
 */
export async function upsertBlockEmbeddingsBatch(
  env: Env,
  inputs: EmbeddingInput[]
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  // Process in batches of 10 to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);

    try {
      // Generate all embeddings for this batch
      const texts = batch.map((input) => buildEmbeddingText(input));
      const result = await env.AI.run(EMBEDDING_MODEL, { text: texts }) as { data: number[][] };

      if (!result.data) {
        failed += batch.length;
        continue;
      }

      // Build vector records
      const vectors = batch.map((input, idx) => ({
        id: input.blockId,
        values: result.data[idx],
        metadata: {
          blockName: input.blockName,
          qualityTier: input.qualityTier,
          qualityScore: input.qualityScore,
          siteId: input.siteId,
        },
      }));

      // Upsert to Vectorize
      await env.VECTOR_INDEX.upsert(vectors);
      success += batch.length;
    } catch (error) {
      console.error(`Failed to process batch starting at ${i}:`, error);
      failed += batch.length;
    }
  }

  return { success, failed };
}
