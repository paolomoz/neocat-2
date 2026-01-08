import {
  Env,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  SuggestedBlock,
  Block,
  QualityTier,
} from './types';
import { getBlocks, getBlockStats, getBlockById } from './database';
import { searchBlocks, SearchResult } from './embeddings';

// Bedrock configuration
const AWS_REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-20250514-v1:0';

// ============================================
// Hybrid Search: Vector + LLM
// ============================================

/**
 * Use vector search to find semantically relevant blocks for a query.
 * Falls back to database search if Vectorize is not available.
 */
async function findRelevantBlocks(
  env: Env,
  userQuery: string,
  options?: { tier?: string; minQuality?: number; topK?: number }
): Promise<Block[]> {
  const topK = options?.topK || 20;

  // Try vector search first
  if (env.AI && env.VECTOR_INDEX) {
    try {
      const vectorResults = await searchBlocks(env, userQuery, {
        topK,
        tier: options?.tier,
        minQuality: options?.minQuality,
      });

      // Fetch full block data for results
      const blocks = await Promise.all(
        vectorResults.map((r) => getBlockById(env.DB, r.id))
      );

      const validBlocks = blocks.filter(Boolean) as Block[];
      if (validBlocks.length > 0) {
        return validBlocks;
      }
      // Fall through to database search if no results
    } catch (error) {
      console.error('Vector search failed, falling back to database:', error);
    }
  }

  // Fallback: use database with quality filters
  return getBlocks(env.DB, {
    tier: options?.tier as QualityTier,
    minQuality: options?.minQuality,
    limit: topK,
  });
}

/**
 * Build block context from vector search results for LLM.
 * More focused than the old approach - only includes relevant blocks.
 */
async function buildBlockContextHybrid(
  env: Env,
  userQuery: string
): Promise<{ context: string; relevantBlocks: Block[] }> {
  // Get semantically relevant blocks
  const relevantBlocks = await findRelevantBlocks(env, userQuery, { topK: 20 });
  const stats = await getBlockStats(env.DB);

  // Format blocks for LLM context
  const blockList = relevantBlocks.map((block) => ({
    id: block.id,
    name: block.block_name,
    variant: block.block_variant,
    tier: block.quality_tier || 'unrated',
    score: block.quality_score || 0,
    desc: (block as Block & { description?: string }).description ||
      `A ${block.block_name} block`,
    hasJs: block.has_javascript,
    interactive: block.has_interactivity,
  }));

  const context = JSON.stringify({
    searchQuery: userQuery,
    totalInDatabase: stats.total,
    relevantBlocks: blockList,
    tierCounts: stats.by_tier,
  });

  return { context, relevantBlocks };
}

// Legacy fallback: Build a condensed block index for the LLM context
async function buildBlockContext(db: D1Database): Promise<string> {
  const blocks = await getBlocks(db, { limit: 500 });
  const stats = await getBlockStats(db);

  // Group blocks by type with minimal metadata
  const grouped: Record<string, Array<{
    id: string;
    tier: string;
    score: number;
    desc: string;
  }>> = {};

  for (const block of blocks) {
    const key = block.block_name;
    if (!grouped[key]) grouped[key] = [];

    // Only keep top 5 per type to limit context size
    if (grouped[key].length < 5) {
      grouped[key].push({
        id: block.id,
        tier: block.quality_tier || 'unrated',
        score: block.quality_score || 0,
        desc: ((block as Block & { description?: string }).description || `A ${block.block_name} block`).substring(0, 100),
      });
    }
  }

  return JSON.stringify({
    totalBlocks: stats.total,
    blockTypes: Object.keys(grouped).length,
    tierCounts: stats.by_tier,
    blocks: grouped,
  });
}

// Build the system prompt with block context
function buildSystemPrompt(blockContext: string, isHybridSearch: boolean = false): string {
  const contextDescription = isHybridSearch
    ? `I've already searched the database using semantic similarity to find blocks relevant to the user's query. Here are the most relevant matches:`
    : `You have access to a database of blocks extracted from real EDS websites. Here is the current inventory:`;

  return `You are an EDS Block Collection assistant helping users find the right blocks for their AEM Edge Delivery Services web projects.

${contextDescription}

${blockContext}

QUALITY TIERS:
- Gold (98-100): Reference quality - Block Collection level, best for production
- Silver (93-97): Excellent implementations
- Bronze (85-92): Good implementations
- Unrated (<85): Below threshold - needs improvement

YOUR BEHAVIOR:
1. Review the relevant blocks and suggest 2-4 that best match the user's needs
2. Prioritize blocks with higher quality scores and gold/silver tiers
3. If the request is ambiguous, ask ONE clarifying question about:
   - Visual style preferences (minimal, bold, corporate, playful)
   - Quality tier preference (recommend gold for production)
   - Specific features needed (images, CTAs, animations, icons)
4. For each suggestion, briefly explain why it matches their needs

RESPONSE FORMAT:
You MUST respond with valid JSON in this exact format:
{
  "message": "Your conversational response explaining the suggestions",
  "suggestedBlockIds": ["block-id-1", "block-id-2"],
  "matchReasons": {"block-id-1": "Brief reason why this matches", "block-id-2": "Brief reason"},
  "followUpQuestion": "Optional question if clarification needed, or null",
  "quickReplies": ["Option 1", "Option 2", "Option 3"]
}

QUICK REPLIES:
- When asking a follow-up question, ALWAYS include 2-4 quickReplies that the user can click
- Keep each reply short (2-5 words)
- Make them clear choices that directly answer your question
- Examples: ["Show alternatives", "Use this one"], ["Gold tier only", "Any quality"], ["Yes, with images", "Text only"]

IMPORTANT:
- Only suggest blocks from the provided list - they've been pre-filtered for relevance
- Use the exact block IDs from the list
- Keep responses concise and helpful
- If no blocks seem like a good match, say so honestly`;
}

// Parse the LLM response to extract structured data
interface ParsedLLMResponse {
  message: string;
  suggestedBlockIds: string[];
  matchReasons: Record<string, string>;
  followUpQuestion: string | null;
  quickReplies: string[];
}

function parseAIResponse(response: string): ParsedLLMResponse {
  // Try to extract JSON from the response
  let jsonStr = response;

  // Check if wrapped in markdown code block
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      message: parsed.message || response,
      suggestedBlockIds: parsed.suggestedBlockIds || [],
      matchReasons: parsed.matchReasons || {},
      followUpQuestion: parsed.followUpQuestion || null,
      quickReplies: parsed.quickReplies || [],
    };
  } catch {
    // Fallback: treat entire response as message
    return {
      message: response,
      suggestedBlockIds: [],
      matchReasons: {},
      followUpQuestion: null,
      quickReplies: [],
    };
  }
}

// Enrich block IDs with full block data
async function enrichBlockSuggestions(
  db: D1Database,
  blockIds: string[],
  matchReasons: Record<string, string>
): Promise<SuggestedBlock[]> {
  if (blockIds.length === 0) return [];

  const blocks = await getBlocks(db, { limit: 500 });
  const blockMap = new Map(blocks.map(b => [b.id, b]));

  const suggestions: SuggestedBlock[] = [];
  for (const id of blockIds) {
    const block = blockMap.get(id);
    if (block) {
      suggestions.push({
        id: block.id,
        blockName: block.block_name,
        qualityTier: block.quality_tier || 'unrated',
        qualityScore: block.quality_score || 0,
        description: (block as Block & { description?: string }).description || `A ${block.block_name} block`,
        matchReason: matchReasons[id] || 'Matches your requirements',
      });
    }
  }

  return suggestions;
}

// Main chat request handler
export async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // Check for Bedrock token
  if (!env.AWS_BEARER_TOKEN_BEDROCK) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Chat not configured (missing Bedrock token)',
      message: 'The chat feature requires AWS Bedrock credentials to be configured.',
      sessionId: crypto.randomUUID(),
    } as ChatResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as ChatRequest;
    const sessionId = body.sessionId || crypto.randomUUID();

    // Extract the latest user message for semantic search
    const latestUserMessage = body.messages
      .filter((m) => m.role === 'user')
      .pop()?.content || '';

    // Use hybrid search if Vectorize is available
    const useHybridSearch = !!(env.AI && env.VECTOR_INDEX);
    let blockContext: string;
    let relevantBlocks: Block[] = [];

    if (useHybridSearch && latestUserMessage) {
      const hybrid = await buildBlockContextHybrid(env, latestUserMessage);
      blockContext = hybrid.context;
      relevantBlocks = hybrid.relevantBlocks;
    } else {
      blockContext = await buildBlockContext(env.DB);
    }

    const systemPrompt = buildSystemPrompt(blockContext, useHybridSearch);

    // Prepare messages for Claude
    const messages = body.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Call Bedrock API
    const bedrockUrl = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL_ID)}/invoke`;

    const response = await fetch(bedrockUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.AWS_BEARER_TOKEN_BEDROCK}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);

      // Parse error for better messaging
      let errorMessage = 'Sorry, I encountered an error processing your request. Please try again.';
      if (response.status === 401) {
        errorMessage = 'Authentication failed. The API key may be invalid or expired.';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit exceeded. Please try again in a moment.';
      } else if (response.status === 400) {
        errorMessage = 'Invalid request format.';
      }

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          console.error('Claude API error message:', errorJson.error.message);
        }
      } catch {
        // Not JSON, use raw text
      }

      return new Response(JSON.stringify({
        success: false,
        error: `Claude API error: ${response.status}`,
        message: errorMessage,
        sessionId,
      } as ChatResponse), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textContent = result.content.find(c => c.type === 'text');
    if (!textContent?.text) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No response from AI',
        message: 'Sorry, I didn\'t get a response. Please try again.',
        sessionId,
      } as ChatResponse), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse the structured response
    const parsed = parseAIResponse(textContent.text);

    // Enrich with full block data
    const suggestedBlocks = await enrichBlockSuggestions(
      env.DB,
      parsed.suggestedBlockIds,
      parsed.matchReasons
    );

    return new Response(JSON.stringify({
      success: true,
      message: parsed.message,
      suggestedBlocks,
      followUpQuestion: parsed.followUpQuestion || undefined,
      quickReplies: parsed.quickReplies.length > 0 ? parsed.quickReplies : undefined,
      sessionId,
    } as ChatResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Chat handler error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Sorry, something went wrong. Please try again.',
      sessionId: crypto.randomUUID(),
    } as ChatResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
