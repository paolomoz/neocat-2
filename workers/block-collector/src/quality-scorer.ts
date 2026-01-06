import {
  QualityScore,
  QualityBreakdown,
  QualityIssue,
  QualityTier,
  Block,
} from './types';
import { getBlocks, deleteBlocksBelowQuality } from './database';

// ============================================
// Quality Scoring Weights
// ============================================

const WEIGHTS: Record<keyof QualityBreakdown, number> = {
  performance: 0.25,
  accessibility: 0.20,
  semanticHtml: 0.15,
  codeQuality: 0.15,
  responsive: 0.15,
  edsCompliance: 0.10,
};

// ============================================
// Quality Tier Thresholds
// ============================================

function getTier(score: number): QualityTier {
  if (score >= 98) return 'gold';      // Reference quality - Block Collection level (98-100)
  if (score >= 93) return 'silver';    // Excellent implementations (93-97)
  if (score >= 85) return 'bronze';    // Good implementations (85-92)
  return 'unrated';                     // Below threshold (<85) - needs improvement
}

// ============================================
// Individual Scoring Functions
// ============================================

interface ScoringContext {
  html: string;
  cleanedHtml?: string;
  hasJavaScript: boolean;
  hasInteractivity: boolean;
}

function scorePerformance(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // Start at 40, earn up to 60 more points (allows reaching 100)
  let score = 40;
  const issues: QualityIssue[] = [];

  // === INLINE STYLES (+20 / -10) ===
  const inlineStyles = (ctx.html.match(/style="/g) || []).length;
  if (inlineStyles === 0) {
    score += 20;
  } else if (inlineStyles <= 2) {
    score += 10;
  } else if (inlineStyles > 5) {
    score -= 10;
    issues.push({
      category: 'performance',
      severity: 'warning',
      message: `Excessive inline styles (${inlineStyles})`,
    });
  }

  // === HTML SIZE (+15 / -15) ===
  const htmlSize = ctx.html.length;
  if (htmlSize < 2000) {
    score += 15;
  } else if (htmlSize < 5000) {
    score += 10;
  } else if (htmlSize < 15000) {
    score += 5;
  } else if (htmlSize > 30000) {
    score -= 15;
    issues.push({
      category: 'performance',
      severity: 'error',
      message: `Large block HTML (${Math.round(htmlSize / 1000)}KB)`,
    });
  }

  // === INLINE SCRIPTS (+15 / -15) ===
  const scripts = ctx.html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  if (scripts.length === 0) {
    score += 15;
  } else {
    score -= 15;
    issues.push({
      category: 'performance',
      severity: 'warning',
      message: 'Inline scripts detected',
    });
  }

  // === IMAGE OPTIMIZATION (+20 / -10) ===
  if (ctx.html.includes('<img')) {
    let imgScore = 0;

    // Lazy loading
    if (ctx.html.includes('loading="lazy"') || ctx.html.includes("loading='lazy'")) {
      imgScore += 10;
    } else {
      score -= 5;
      issues.push({
        category: 'performance',
        severity: 'info',
        message: 'Images missing lazy loading',
      });
    }

    // Image dimensions
    if (ctx.html.includes('width=') && ctx.html.includes('height=')) {
      imgScore += 10;
    } else {
      score -= 5;
      issues.push({
        category: 'performance',
        severity: 'info',
        message: 'Images missing dimensions',
      });
    }

    score += imgScore;
  } else {
    score += 10; // No images - partial credit
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

function scoreAccessibility(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // Start at 50 - EDS blocks are accessible by default when following patterns
  let score = 50;
  const issues: QualityIssue[] = [];

  // === IMAGE ACCESSIBILITY (+25) ===
  const imgs = ctx.html.match(/<img[^>]*>/gi) || [];
  if (imgs.length > 0) {
    let imgsWithAlt = 0;
    for (const img of imgs) {
      if (img.includes('alt=')) imgsWithAlt++;
    }
    const altCoverage = imgsWithAlt / imgs.length;
    if (altCoverage === 1) {
      score += 25; // All images have alt (empty alt="" is valid for decorative)
    } else if (altCoverage >= 0.8) {
      score += 18;
    } else {
      score += 8;
      issues.push({
        category: 'accessibility',
        severity: 'warning',
        message: 'Some images missing alt text',
      });
    }
  } else {
    score += 15; // No images is fine
  }

  // === LINK ACCESSIBILITY (+15) ===
  const links = ctx.html.match(/<a[^>]*>/gi) || [];
  if (links.length > 0) {
    const badLinks = links.filter(l => l.includes('href=""') || l.includes("href='#'"));
    if (badLinks.length === 0) {
      score += 15;
    } else {
      score += 8;
    }
  } else {
    score += 12;
  }

  // === ARIA/ROLE (+10 bonus, no penalty for simple blocks) ===
  const hasAria = ctx.html.includes('aria-');
  const hasRole = ctx.html.includes('role=');
  if (hasAria || hasRole) {
    score += 10; // Bonus for ARIA usage
  } else {
    score += 5; // No penalty - simple blocks don't need ARIA
  }

  // === HEADING STRUCTURE (+10) ===
  const headings = ctx.html.match(/<h[1-6][^>]*>/gi) || [];
  if (headings.length > 0) {
    score += 10;
  } else {
    score += 5;
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

function scoreSemanticHtml(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // EDS blocks use div-based structure with semantic class names - this is by design
  // Score based on proper structure, headings, and lists rather than HTML5 semantic tags
  let score = 60; // Start higher - div structure is valid for EDS
  const issues: QualityIssue[] = [];

  // === HEADING STRUCTURE (+20) ===
  const headings = ctx.html.match(/<h[1-6][^>]*>/gi) || [];
  if (headings.length > 0) {
    const levels = headings.map((h) => parseInt(h.charAt(2)));
    let hasSkip = false;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        hasSkip = true;
        break;
      }
    }
    if (!hasSkip && headings.length >= 2) {
      score += 20; // Good hierarchy with multiple headings
    } else if (!hasSkip) {
      score += 15;
    } else {
      score += 8;
      issues.push({
        category: 'semanticHtml',
        severity: 'info',
        message: 'Heading levels skipped',
      });
    }
  } else {
    score += 10; // No headings is neutral for many block types
  }

  // === LIST USAGE (+15) ===
  const hasListElements = ctx.html.includes('<ul') || ctx.html.includes('<ol');
  const hasListItems = (ctx.html.match(/<li/gi) || []).length > 0;

  if (hasListElements && hasListItems) {
    score += 15; // Proper list usage
  } else if (hasListElements || hasListItems) {
    score += 10;
  } else {
    score += 8; // No lists is neutral
  }

  // === BONUS: Semantic elements when present (+15) ===
  const semanticTags = ['article', 'section', 'nav', 'aside', 'header', 'footer', 'figure', 'details', 'summary'];
  let semanticCount = 0;
  for (const tag of semanticTags) {
    if (ctx.html.toLowerCase().includes(`<${tag}`)) semanticCount++;
  }
  if (semanticCount >= 2) {
    score += 15;
  } else if (semanticCount >= 1) {
    score += 10;
  } else {
    score += 5; // No penalty - divs are standard for EDS
  }

  // === PICTURE ELEMENT (+10) - EDS standard for images ===
  if (ctx.html.includes('<picture')) {
    score += 10;
  } else if (ctx.html.includes('<img')) {
    score += 5;
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

function scoreCodeQuality(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // Start at 35, earn up to 65 more points (allows reaching 100)
  let score = 35;
  const issues: QualityIssue[] = [];

  // === CLASS NAMING QUALITY (+25 / -10) ===
  const classes = ctx.html.match(/class="([^"]+)"/g) || [];
  const classNames = classes.flatMap((c) =>
    c.replace('class="', '').replace('"', '').split(/\s+/)
  ).filter(c => c.length > 0);

  if (classNames.length > 0) {
    // Check for BEM-like or consistent naming
    const hasBemLike = classNames.some(c => c.includes('__') || c.includes('--'));
    const hasKebabCase = classNames.filter(c => c.includes('-')).length / classNames.length > 0.5;
    const hasCamelCase = classNames.some(c => /[a-z][A-Z]/.test(c));

    // Consistent class lengths (not too short, not too long)
    const avgClassLength = classNames.reduce((sum, c) => sum + c.length, 0) / classNames.length;
    const goodClassLength = avgClassLength >= 3 && avgClassLength <= 25;

    // Check for utility class spam (tailwind-like)
    const shortClasses = classNames.filter(c => c.length <= 4).length;
    const hasUtilitySpam = shortClasses / classNames.length > 0.6 && classNames.length > 5;

    if (hasBemLike && goodClassLength) {
      score += 25; // BEM is excellent
    } else if (hasKebabCase && !hasCamelCase && goodClassLength) {
      score += 20; // Consistent kebab-case
    } else if (goodClassLength && !hasUtilitySpam) {
      score += 12;
    } else if (hasUtilitySpam) {
      score -= 5;
      issues.push({
        category: 'codeQuality',
        severity: 'info',
        message: 'Heavy utility class usage (consider semantic classes)',
      });
    } else {
      score += 5;
    }

    // Check for overly long class lists
    const maxClasses = Math.max(...classes.map(c =>
      c.replace('class="', '').replace('"', '').split(/\s+/).length
    ));
    if (maxClasses > 15) {
      score -= 10;
      issues.push({
        category: 'codeQuality',
        severity: 'warning',
        message: `Excessive class count (${maxClasses} classes on one element)`,
      });
    } else if (maxClasses > 10) {
      score -= 5;
      issues.push({
        category: 'codeQuality',
        severity: 'info',
        message: 'High class count on element',
      });
    }
  } else {
    score += 8; // No classes is neutral
  }

  // === NO INLINE EVENT HANDLERS (+20 / -15) ===
  const inlineHandlers = ctx.html.match(/on\w+="/gi) || [];
  if (inlineHandlers.length === 0) {
    score += 20;
  } else {
    score -= 15;
    issues.push({
      category: 'codeQuality',
      severity: 'warning',
      message: `Inline event handlers detected (${inlineHandlers.length})`,
    });
  }

  // === NO DEPRECATED ELEMENTS (+15 / -15) ===
  const deprecatedPattern = /<(font|center|marquee|blink|strike|big|tt)\b/gi;
  if (!deprecatedPattern.test(ctx.html)) {
    score += 15;
  } else {
    score -= 15;
    issues.push({
      category: 'codeQuality',
      severity: 'error',
      message: 'Deprecated HTML elements used',
    });
  }

  // === CODE FORMATTING (+10 / -5) ===
  const lines = ctx.html.split('\n');
  const avgLineLength = ctx.html.length / Math.max(1, lines.length);
  if (lines.length > 3 && avgLineLength < 150) {
    score += 10; // Well-formatted with proper line breaks
  } else if (lines.length > 1 && avgLineLength < 250) {
    score += 5;
  } else if (avgLineLength > 500) {
    score -= 5;
    issues.push({
      category: 'codeQuality',
      severity: 'info',
      message: 'HTML not properly formatted (long lines)',
    });
  }

  // === NO EMPTY ATTRIBUTES (+5 / -5) ===
  const emptyAttrs = ctx.html.match(/\w+=""/g) || [];
  const meaninglessEmpty = emptyAttrs.filter(a =>
    !a.includes('alt=""') // empty alt is valid for decorative images
  );
  if (meaninglessEmpty.length === 0) {
    score += 5;
  } else if (meaninglessEmpty.length > 3) {
    score -= 5;
    issues.push({
      category: 'codeQuality',
      severity: 'info',
      message: 'Multiple empty attributes found',
    });
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

function scoreResponsive(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // Start at 55 - EDS blocks are responsive by default
  let score = 55;
  const issues: QualityIssue[] = [];

  // === RESPONSIVE IMAGES (+35) - The most important factor for EDS ===
  if (ctx.html.includes('<img') || ctx.html.includes('<picture')) {
    const hasPicture = ctx.html.includes('<picture');
    const hasSrcset = ctx.html.includes('srcset=');
    const hasSource = ctx.html.includes('<source');

    if (hasPicture && hasSrcset && hasSource) {
      score += 35; // Full EDS responsive image pattern
    } else if (hasPicture && hasSrcset) {
      score += 30;
    } else if (hasPicture || hasSrcset) {
      score += 20;
    } else {
      score += 5;
      issues.push({
        category: 'responsive',
        severity: 'info',
        message: 'Consider using picture/srcset for responsive images',
      });
    }
  } else {
    score += 20; // No images is fine for many blocks
  }

  // === NO PROBLEMATIC FIXED WIDTHS (+10) ===
  const hugeFixedWidths = (ctx.html.match(/width:\s*[89]\d{2,}px|width:\s*\d{4,}px/gi) || []).length;
  if (hugeFixedWidths === 0) {
    score += 10;
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

function scoreEDSCompliance(ctx: ScoringContext): { score: number; issues: QualityIssue[] } {
  // Start at 50 for EDS blocks - they follow EDS patterns by definition
  let score = 50;
  const issues: QualityIssue[] = [];

  // === BLOCK CLASS STRUCTURE (+20) ===
  // EDS blocks have class names like "cards", "hero", "columns" directly on wrapper
  const hasBlockName = ctx.html.match(/class="[a-z][a-z0-9-]*"/i); // e.g., class="cards" or class="hero-banner"
  const hasNestedClasses = ctx.html.match(/class="[a-z][a-z0-9-]*-[a-z]+"/i); // e.g., class="cards-card-image"

  if (hasBlockName && hasNestedClasses) {
    score += 20; // Perfect EDS block structure with nested naming
  } else if (hasBlockName) {
    score += 15;
  } else {
    score += 5;
  }

  // === NESTED DIV STRUCTURE (+15) ===
  // EDS blocks use div > div > div structure (block > row > column)
  const divCount = (ctx.html.match(/<div/g) || []).length;
  const hasNestedDivs = ctx.html.match(/<div[^>]*>[\s\S]*?<div[^>]*>[\s\S]*?<div/i);

  if (divCount >= 3 && hasNestedDivs) {
    score += 15; // Standard EDS nested structure
  } else if (divCount >= 2) {
    score += 12;
  } else {
    score += 8;
  }

  // === PICTURE ELEMENT (+15) - EDS standard for responsive images ===
  if (ctx.html.includes('<picture') && ctx.html.includes('<source') && ctx.html.includes('<img')) {
    score += 15; // Full responsive image setup
  } else if (ctx.html.includes('<picture')) {
    score += 12;
  } else if (ctx.html.includes('<img')) {
    score += 8;
  } else {
    score += 5; // No images is neutral
  }

  // === CLEAN VANILLA HTML (+10) ===
  const hasReactArtifacts = ctx.html.includes('data-reactroot') || ctx.html.includes('_jsx');
  const hasVueArtifacts = ctx.html.includes('data-v-') || ctx.html.includes('v-bind');
  const hasAngularArtifacts = ctx.html.includes('ng-') || ctx.html.includes('_ngcontent');

  if (!hasReactArtifacts && !hasVueArtifacts && !hasAngularArtifacts) {
    score += 10; // Clean vanilla HTML as EDS intends
  } else {
    issues.push({
      category: 'edsCompliance',
      severity: 'warning',
      message: 'Framework artifacts detected (EDS should be vanilla)',
    });
  }

  // === PROPER LINK STRUCTURE (+10) ===
  const links = ctx.html.match(/<a[^>]*>/gi) || [];
  if (links.length > 0) {
    const badLinks = links.filter(l =>
      l.includes('javascript:') || l.includes('href=""') || l.includes("href='#'")
    );
    if (badLinks.length === 0) {
      score += 10;
    } else {
      score += 5;
    }
  } else {
    score += 8; // No links is neutral
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

// ============================================
// Main Scoring Function
// ============================================

export function scoreBlock(html: string, options?: {
  cleanedHtml?: string;
  hasJavaScript?: boolean;
  hasInteractivity?: boolean;
}): QualityScore {
  const ctx: ScoringContext = {
    html,
    cleanedHtml: options?.cleanedHtml,
    hasJavaScript: options?.hasJavaScript ?? false,
    hasInteractivity: options?.hasInteractivity ?? false,
  };

  // Run all scoring functions
  const performance = scorePerformance(ctx);
  const accessibility = scoreAccessibility(ctx);
  const semanticHtml = scoreSemanticHtml(ctx);
  const codeQuality = scoreCodeQuality(ctx);
  const responsive = scoreResponsive(ctx);
  const edsCompliance = scoreEDSCompliance(ctx);

  // Calculate breakdown
  const breakdown: QualityBreakdown = {
    performance: performance.score,
    accessibility: accessibility.score,
    semanticHtml: semanticHtml.score,
    codeQuality: codeQuality.score,
    responsive: responsive.score,
    edsCompliance: edsCompliance.score,
  };

  // Calculate weighted overall score (no normalization - scores now naturally span 50-100)
  const overall = Math.round(
    breakdown.performance * WEIGHTS.performance +
    breakdown.accessibility * WEIGHTS.accessibility +
    breakdown.semanticHtml * WEIGHTS.semanticHtml +
    breakdown.codeQuality * WEIGHTS.codeQuality +
    breakdown.responsive * WEIGHTS.responsive +
    breakdown.edsCompliance * WEIGHTS.edsCompliance
  );

  // Collect all issues
  const issues: QualityIssue[] = [
    ...performance.issues,
    ...accessibility.issues,
    ...semanticHtml.issues,
    ...codeQuality.issues,
    ...responsive.issues,
    ...edsCompliance.issues,
  ];

  return {
    overall,
    breakdown,
    issues,
    tier: getTier(overall),
  };
}

// ============================================
// Batch Scoring Pipeline
// ============================================

export interface ScoreBlocksResult {
  scored: number;
  deleted: number;
  byTier: Record<QualityTier, number>;
  averageScore: number;
  errors: string[];
}

export async function scoreBlocksForSite(
  db: D1Database,
  siteId: string,
  options?: { deleteUnrated?: boolean }
): Promise<ScoreBlocksResult> {
  const result: ScoreBlocksResult = {
    scored: 0,
    deleted: 0,
    byTier: { gold: 0, silver: 0, bronze: 0, unrated: 0 },
    averageScore: 0,
    errors: [],
  };

  const blocks = await getBlocks(db, { siteId, limit: 5000 });
  let totalScore = 0;

  for (const block of blocks) {
    if (!block.html) continue;

    try {
      const score = scoreBlock(block.html, {
        cleanedHtml: block.cleaned_html || undefined,
        hasJavaScript: block.has_javascript,
        hasInteractivity: block.has_interactivity,
      });

      // Update block with score
      await db
        .prepare(
          `UPDATE blocks
           SET quality_score = ?, quality_tier = ?, quality_breakdown = ?
           WHERE id = ?`
        )
        .bind(
          score.overall,
          score.tier,
          JSON.stringify(score.breakdown),
          block.id
        )
        .run();

      result.scored++;
      result.byTier[score.tier]++;
      totalScore += score.overall;
    } catch (e) {
      result.errors.push(`Failed to score block ${block.id}: ${e}`);
    }
  }

  // Calculate average
  if (result.scored > 0) {
    result.averageScore = Math.round(totalScore / result.scored);
  }

  // Optionally delete unrated blocks
  if (options?.deleteUnrated) {
    result.deleted = await deleteBlocksBelowQuality(db, 50);
  }

  return result;
}

// ============================================
// Quality Report Generation
// ============================================

export interface QualityReport {
  siteId: string;
  totalBlocks: number;
  scoredBlocks: number;
  tierDistribution: Record<QualityTier, number>;
  averageScore: number;
  topIssues: { issue: string; count: number }[];
  blockNameQuality: { name: string; avgScore: number; count: number }[];
}

export async function generateQualityReport(
  db: D1Database,
  siteId: string
): Promise<QualityReport> {
  const blocks = await getBlocks(db, { siteId, limit: 5000 });

  const report: QualityReport = {
    siteId,
    totalBlocks: blocks.length,
    scoredBlocks: 0,
    tierDistribution: { gold: 0, silver: 0, bronze: 0, unrated: 0 },
    averageScore: 0,
    topIssues: [],
    blockNameQuality: [],
  };

  let totalScore = 0;
  const issueCounts: Record<string, number> = {};
  const blockNameScores: Record<string, { total: number; count: number }> = {};

  for (const block of blocks) {
    if (block.quality_score !== null) {
      report.scoredBlocks++;
      totalScore += block.quality_score;

      if (block.quality_tier) {
        report.tierDistribution[block.quality_tier]++;
      }

      // Track by block name
      if (!blockNameScores[block.block_name]) {
        blockNameScores[block.block_name] = { total: 0, count: 0 };
      }
      blockNameScores[block.block_name].total += block.quality_score;
      blockNameScores[block.block_name].count++;

      // Count issues
      if (block.quality_breakdown) {
        const breakdown = block.quality_breakdown as QualityBreakdown;
        for (const [category, score] of Object.entries(breakdown)) {
          if (score < 70) {
            const issue = `Low ${category} score`;
            issueCounts[issue] = (issueCounts[issue] || 0) + 1;
          }
        }
      }
    } else {
      report.tierDistribution.unrated++;
    }
  }

  // Calculate averages
  if (report.scoredBlocks > 0) {
    report.averageScore = Math.round(totalScore / report.scoredBlocks);
  }

  // Top issues
  report.topIssues = Object.entries(issueCounts)
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Block name quality
  report.blockNameQuality = Object.entries(blockNameScores)
    .map(([name, data]) => ({
      name,
      avgScore: Math.round(data.total / data.count),
      count: data.count,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return report;
}
