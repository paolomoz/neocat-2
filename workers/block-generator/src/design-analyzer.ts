import { ExtractedBlock } from './content-extractor';

/**
 * Design tokens extracted from visual analysis (legacy)
 */
export interface DesignTokens {
  colors: {
    primary?: string;
    secondary?: string;
    background?: string;
    text?: string;
    heading?: string;
    link?: string;
    accent?: string;
  };
  typography: {
    headingFontFamily?: string;
    bodyFontFamily?: string;
    headingFontSize?: string;
    bodyFontSize?: string;
    headingFontWeight?: string;
    lineHeight?: string;
  };
  spacing: {
    padding?: string;
    gap?: string;
    margin?: string;
  };
  layout: {
    borderRadius?: string;
    boxShadow?: string;
    border?: string;
  };
  effects: {
    overlay?: string;
    gradient?: string;
    textShadow?: string;
  };
}

/**
 * Generated block code from visual analysis
 */
export interface GeneratedBlockCode {
  blockName: string;
  html: string;
  css: string;
  js: string;
}

/**
 * Build the prompt for full block code generation
 */
function buildCodeGenerationPrompt(extracted: ExtractedBlock): string {
  // Serialize the extracted content for Claude
  const contentSummary = extracted.columns.map((col, i) => {
    const parts: string[] = [];
    if (col.image) parts.push(`image: "${col.image.src}"`);
    if (col.heading) parts.push(`heading: "${col.heading}"`);
    if (col.description) parts.push(`description: "${col.description}"`);
    if (col.cta) parts.push(`cta: { text: "${col.cta.text}", href: "${col.cta.href}" }`);
    return `Item ${i + 1}: { ${parts.join(', ')} }`;
  }).join('\n');

  return `Analyze this screenshot of a web component and generate code to reproduce its EXACT visual design as an AEM Edge Delivery Services (EDS) block.

## Extracted Content
The following content was extracted from the DOM:
${contentSummary}

## Component Type Detected: ${extracted.type}
${extracted.title ? `Title: "${extracted.title}"` : ''}

## Your Task
Generate a complete EDS block that visually matches the screenshot. Pay close attention to:
- Layout positioning (where text overlays appear, left/right/center/bottom)
- Background treatments (overlays, gradients, semi-transparent boxes)
- Typography (sizes, weights, colors, shadows)
- Spacing and padding
- Button/CTA styling
- Navigation elements (arrows, dots) and their styling
- Any animations or transitions

## EDS Block Structure Requirements
EDS blocks follow this HTML pattern:
\`\`\`html
<div class="{block-name} block">
  <div><!-- row 1 -->
    <div><!-- cell 1 --></div>
    <div><!-- cell 2 --></div>
  </div>
  <div><!-- row 2 -->
    <div><!-- cell --></div>
  </div>
</div>
\`\`\`

The JS decoration function transforms this into the final rendered structure.

## Return Format
Return a JSON object with this exact structure:
{
  "blockName": "descriptive-block-name",
  "html": "<!-- The EDS block HTML markup with actual content substituted -->",
  "css": "/* Complete CSS to reproduce the visual design */",
  "js": "/* ES module: export default function decorate(block) { ... } */"
}

## Important Guidelines
1. Use the ACTUAL content from the extracted data above (real text, real image URLs)
2. The CSS must precisely match the visual appearance in the screenshot
3. The JS should import createOptimizedPicture from '../../scripts/aem.js' if transforming images
4. For carousels: include slide transitions, navigation, and auto-play if visible
5. Match colors exactly - use the hex values you see
6. Position text overlays exactly as shown (e.g., left side with semi-transparent background)
7. Include hover states if buttons/links are present

Return ONLY the JSON object, no additional text.`;
}

const DESIGN_ANALYSIS_PROMPT = `Analyze this screenshot of a web component and extract precise design tokens.

Return a JSON object with the following structure (use exact CSS values where possible):

{
  "colors": {
    "primary": "#hex or rgb() - main brand/accent color",
    "secondary": "#hex or rgb() - secondary color if present",
    "background": "#hex or rgb() - background color",
    "text": "#hex or rgb() - main text color",
    "heading": "#hex or rgb() - heading text color",
    "link": "#hex or rgb() - link color",
    "accent": "#hex or rgb() - any accent/highlight color"
  },
  "typography": {
    "headingFontFamily": "font family name or generic (sans-serif, serif)",
    "bodyFontFamily": "font family name or generic",
    "headingFontSize": "size in px (e.g., '48px', '32px')",
    "bodyFontSize": "size in px (e.g., '16px', '18px')",
    "headingFontWeight": "weight (e.g., '300', '400', '600', '700')",
    "lineHeight": "line height (e.g., '1.5', '1.6')"
  },
  "spacing": {
    "padding": "padding value (e.g., '40px', '24px 32px')",
    "gap": "gap between items (e.g., '24px', '40px')",
    "margin": "margins if notable"
  },
  "layout": {
    "borderRadius": "border radius (e.g., '8px', '12px', '0')",
    "boxShadow": "box shadow if present (e.g., '0 2px 8px rgba(0,0,0,0.1)')",
    "border": "border if present (e.g., '1px solid #ddd')"
  },
  "effects": {
    "overlay": "overlay color if image has overlay (e.g., 'rgba(0,0,0,0.4)')",
    "gradient": "gradient if present (e.g., 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.6))')",
    "textShadow": "text shadow if present"
  }
}

Be precise with color values - try to identify exact hex codes. If you can't determine a value, omit that field.
Only return the JSON object, no other text.`;

export interface AnthropicConfig {
  useBedrock?: boolean;
  bedrockToken?: string;
  bedrockRegion?: string;
  bedrockModel?: string;
  apiKey?: string; // Direct Anthropic API key (fallback)
}

/**
 * Analyze a screenshot using Claude Vision API to extract design tokens
 */
export async function analyzeDesign(
  screenshotBase64: string,
  config: AnthropicConfig
): Promise<DesignTokens> {
  let response: Response;

  if (config.useBedrock && config.bedrockToken) {
    // Use AWS Bedrock
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
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: DESIGN_ANALYSIS_PROMPT,
              },
            ],
          },
        ],
      }),
    });
  } else if (config.apiKey) {
    // Use direct Anthropic API
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: DESIGN_ANALYSIS_PROMPT,
              },
            ],
          },
        ],
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

  // Extract the text response
  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) {
    throw new Error('No text response from Claude');
  }

  // Parse the JSON response
  try {
    // Try to extract JSON from the response (in case there's extra text)
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    return JSON.parse(jsonMatch[0]) as DesignTokens;
  } catch (parseError) {
    console.error('Failed to parse design tokens:', textContent.text);
    // Return empty tokens on parse failure
    return {
      colors: {},
      typography: {},
      spacing: {},
      layout: {},
      effects: {},
    };
  }
}

/**
 * Merge design tokens with extracted styles, preferring vision-based tokens
 */
export function mergeDesignTokens(
  visionTokens: DesignTokens,
  extractedStyles: Record<string, string | undefined>
): DesignTokens {
  return {
    colors: {
      primary: visionTokens.colors.primary || extractedStyles.headingColor,
      secondary: visionTokens.colors.secondary,
      background: visionTokens.colors.background || extractedStyles.backgroundColor,
      text: visionTokens.colors.text || extractedStyles.textColor,
      heading: visionTokens.colors.heading || extractedStyles.headingColor,
      link: visionTokens.colors.link || extractedStyles.linkColor,
      accent: visionTokens.colors.accent,
    },
    typography: {
      ...visionTokens.typography,
    },
    spacing: {
      padding: visionTokens.spacing.padding || extractedStyles.padding,
      gap: visionTokens.spacing.gap || extractedStyles.gap,
      margin: visionTokens.spacing.margin,
    },
    layout: {
      borderRadius: visionTokens.layout.borderRadius || extractedStyles.borderRadius,
      boxShadow: visionTokens.layout.boxShadow || extractedStyles.boxShadow,
      border: visionTokens.layout.border,
    },
    effects: {
      ...visionTokens.effects,
    },
  };
}

/**
 * Generate complete block code by having Claude analyze the screenshot
 * and generate HTML, CSS, and JS to reproduce the design
 */
export async function generateBlockCode(
  screenshotBase64: string,
  extracted: ExtractedBlock,
  config: AnthropicConfig
): Promise<GeneratedBlockCode> {
  const prompt = buildCodeGenerationPrompt(extracted);

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
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
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
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
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

  // Parse the JSON response
  try {
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const parsed = JSON.parse(jsonMatch[0]) as GeneratedBlockCode;

    // Validate required fields
    if (!parsed.blockName || !parsed.html || !parsed.css || !parsed.js) {
      throw new Error('Missing required fields in generated code');
    }

    return parsed;
  } catch (parseError) {
    console.error('Failed to parse generated code:', textContent.text);
    throw new Error('Failed to parse Claude response as valid block code');
  }
}
