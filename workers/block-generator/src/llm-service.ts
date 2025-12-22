import { Env, LLMModel } from './types';

/**
 * Configuration for LLM calls
 */
export interface LLMConfig {
  model: LLMModel;
  env: Env;
}

/**
 * Image content for vision models
 */
export interface ImageContent {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg';
  label?: string;
}

/**
 * Unified interface for calling LLMs with vision capabilities
 */
export async function callLLMWithVision(
  images: ImageContent[],
  prompt: string,
  config: LLMConfig,
  maxTokens: number = 8192
): Promise<string> {
  switch (config.model) {
    case 'claude-sonnet':
      return callClaude(images, prompt, config.env, maxTokens, 'sonnet');
    case 'claude-opus':
      return callClaude(images, prompt, config.env, maxTokens, 'opus');
    case 'gemini-flash':
      return callGemini(images, prompt, config.env, maxTokens);
    case 'cerebras-qwen':
      return callCerebras(images, prompt, config.env, maxTokens);
    default:
      throw new Error(`Unsupported model: ${config.model}`);
  }
}

/**
 * Call Claude (Anthropic) API
 */
async function callClaude(
  images: ImageContent[],
  prompt: string,
  env: Env,
  maxTokens: number,
  variant: 'sonnet' | 'opus' = 'sonnet'
): Promise<string> {
  // Build content array with images and prompt
  const content: Array<{ type: string; source?: any; text?: string }> = [];

  for (const image of images) {
    if (image.label) {
      content.push({ type: 'text', text: image.label });
    }
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64
      }
    });
  }
  content.push({ type: 'text', text: prompt });

  let response: Response;

  if (env.ANTHROPIC_USE_BEDROCK === '1' && env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK) {
    const region = env.ANTHROPIC_AWS_REGION || 'us-east-1';
    const defaultModel = variant === 'opus'
      ? 'anthropic.claude-opus-4-20250514-v1:0'
      : 'anthropic.claude-sonnet-4-20250514-v1:0';
    const model = variant === 'opus'
      ? (env.ANTHROPIC_MODEL_OPUS || defaultModel)
      : (env.ANTHROPIC_MODEL_SONNET || defaultModel);
    const bedrockUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;

    response = await fetch(bedrockUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
    });
  } else if (env.ANTHROPIC_API_KEY) {
    const directModel = variant === 'opus' ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: directModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
    });
  } else {
    throw new Error('No Anthropic API configuration provided');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) {
    throw new Error('No text response from Claude');
  }

  return textContent.text;
}

/**
 * Call Google Gemini API
 */
async function callGemini(
  images: ImageContent[],
  prompt: string,
  env: Env,
  maxTokens: number
): Promise<string> {
  if (!env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY not configured');
  }

  // Build parts array with images and text
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];

  for (const image of images) {
    if (image.label) {
      parts.push({ text: image.label });
    }
    parts.push({
      inline_data: {
        mime_type: image.mediaType,
        data: image.base64
      }
    });
  }
  parts.push({ text: prompt });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GOOGLE_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    candidates: Array<{
      content: {
        parts: Array<{ text?: string }>;
      };
    }>;
  };

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No text response from Gemini');
  }

  return text;
}

/**
 * Call Cerebras API (OpenAI-compatible)
 * Note: Cerebras may have limited vision support - using text description fallback
 */
async function callCerebras(
  images: ImageContent[],
  prompt: string,
  env: Env,
  maxTokens: number
): Promise<string> {
  if (!env.CEREBRAS_API_KEY) {
    throw new Error('CEREBRAS_API_KEY not configured');
  }

  // Cerebras uses OpenAI-compatible API format
  // Build messages with image URLs (base64 data URIs)
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  for (const image of images) {
    if (image.label) {
      content.push({ type: 'text', text: image.label });
    }
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mediaType};base64,${image.base64}`
      }
    });
  }
  content.push({ type: 'text', text: prompt });

  const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'qwen-3-32b',
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cerebras API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    choices: Array<{
      message: {
        content: string;
      };
    }>;
  };

  const text = result.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('No text response from Cerebras');
  }

  return text;
}

/**
 * Get display name for model
 */
export function getModelDisplayName(model: LLMModel): string {
  switch (model) {
    case 'claude-sonnet':
      return 'Claude Sonnet 4';
    case 'claude-opus':
      return 'Claude Opus 4';
    case 'gemini-flash':
      return 'Gemini 2.0 Flash';
    case 'cerebras-qwen':
      return 'Cerebras Qwen 3';
    default:
      return model;
  }
}

/**
 * Check if model is available based on env config
 */
export function isModelAvailable(model: LLMModel, env: Env): boolean {
  switch (model) {
    case 'claude-sonnet':
    case 'claude-opus':
      return !!(env.ANTHROPIC_API_KEY || (env.ANTHROPIC_USE_BEDROCK === '1' && env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK));
    case 'gemini-flash':
      return !!env.GOOGLE_API_KEY;
    case 'cerebras-qwen':
      return !!env.CEREBRAS_API_KEY;
    default:
      return false;
  }
}
