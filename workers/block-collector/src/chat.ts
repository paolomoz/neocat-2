import {
  Env,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  SuggestedBlock,
  Block,
  QualityTier,
} from './types';
import { getBlocks, getBlockStats } from './database';

// Bedrock configuration
const AWS_REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-20250514-v1:0';

// Build a condensed block index for the LLM context
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
        desc: (block.description || `A ${block.block_name} block`).substring(0, 100),
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
function buildSystemPrompt(blockContext: string): string {
  return `You are an EDS Block Collection assistant helping users find the right blocks for their AEM Edge Delivery Services web projects.

You have access to a database of blocks extracted from real EDS websites. Here is the current inventory:

${blockContext}

QUALITY TIERS:
- Gold (85+): Production-ready, excellent accessibility and performance - best for production use
- Silver (70-84): Good quality, may need minor adjustments
- Bronze (50-69): Usable but may need significant improvements
- Unrated: Not yet scored

YOUR BEHAVIOR:
1. When a user describes what they need, suggest 2-4 matching blocks from the database
2. If the request is ambiguous, ask ONE clarifying question about:
   - Visual style preferences (minimal, bold, corporate, playful)
   - Quality tier preference (recommend gold for production)
   - Specific features needed (images, CTAs, animations, icons)
3. For each suggestion, briefly explain why it matches their needs
4. Focus on the block_name and quality metrics

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
- Only suggest blocks that exist in the provided inventory
- Use the exact block IDs from the inventory
- Keep responses concise and helpful
- If no blocks match, say so honestly and suggest alternatives`;
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

    // Build block context
    const blockContext = await buildBlockContext(env.DB);
    const systemPrompt = buildSystemPrompt(blockContext);

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
