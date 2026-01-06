import {
  GitHubRepo,
  GitHubOrg,
  RepoEDSCheck,
  EDSDetectionResult,
  EDSDetectionSignals,
} from './types';
import {
  getDevelopers,
  updateDeveloperScanned,
  upsertOrganization,
  updateOrgScanned,
  upsertRepository,
  updateRepositoryEDS,
  getUnscannedRepositories,
  createSite,
} from './database';

// ============================================
// GitHub API Client
// ============================================

const GITHUB_API = 'https://api.github.com';

interface GitHubAPIOptions {
  token: string;
  perPage?: number;
}

async function githubFetch<T>(
  endpoint: string,
  options: GitHubAPIOptions
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'EDS-Block-Collector',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}

async function githubFetchAll<T>(
  endpoint: string,
  options: GitHubAPIOptions,
  maxPages: number = 10
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = options.perPage || 100;

  while (page <= maxPages) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${endpoint}${separator}per_page=${perPage}&page=${page}`;

    const pageResults = await githubFetch<T[]>(url, options);
    if (pageResults.length === 0) break;

    results.push(...pageResults);

    if (pageResults.length < perPage) break;
    page++;
  }

  return results;
}

// ============================================
// Key EDS Repositories (for contributor discovery)
// ============================================

const KEY_EDS_REPOS = [
  'adobe/aem-boilerplate',
  'adobe/helix-website',
  'adobe/helix-project-boilerplate',
  'adobe/aem-lib',
  'adobe/helix-shared',
  'adobe/helix-sidekick',
  'adobe/helix-sidekick-extension',
];

// ============================================
// Contributor Discovery
// ============================================

interface GitHubContributor {
  login: string;
  id: number;
  contributions: number;
  type: string;
}

export async function discoverContributors(
  token: string,
  options?: { maxPerRepo?: number }
): Promise<{ username: string; contributions: number; source: string }[]> {
  const maxPerRepo = options?.maxPerRepo || 50;
  const contributorMap = new Map<string, { contributions: number; sources: string[] }>();

  for (const repo of KEY_EDS_REPOS) {
    try {
      console.log(`Fetching contributors from ${repo}...`);
      const contributors = await githubFetch<GitHubContributor[]>(
        `/repos/${repo}/contributors?per_page=${maxPerRepo}`,
        { token }
      );

      for (const contributor of contributors) {
        // Skip bots
        if (contributor.type === 'Bot' || contributor.login.includes('[bot]')) {
          continue;
        }

        const existing = contributorMap.get(contributor.login);
        if (existing) {
          existing.contributions += contributor.contributions;
          existing.sources.push(repo);
        } else {
          contributorMap.set(contributor.login, {
            contributions: contributor.contributions,
            sources: [repo],
          });
        }
      }
    } catch (e) {
      console.error(`Failed to fetch contributors from ${repo}:`, e);
    }
  }

  // Convert to array and sort by total contributions
  return Array.from(contributorMap.entries())
    .map(([username, data]) => ({
      username,
      contributions: data.contributions,
      source: data.sources.join(', '),
    }))
    .sort((a, b) => b.contributions - a.contributions);
}

// ============================================
// Developer Scanning
// ============================================

export interface DeveloperScanResult {
  username: string;
  repos: GitHubRepo[];
  orgs: GitHubOrg[];
  starred: GitHubRepo[];
}

export async function scanDeveloper(
  username: string,
  token: string
): Promise<DeveloperScanResult> {
  const options: GitHubAPIOptions = { token };

  const [repos, orgs, starred] = await Promise.all([
    githubFetchAll<GitHubRepo>(`/users/${username}/repos?type=all&sort=updated`, options),
    githubFetchAll<GitHubOrg>(`/users/${username}/orgs`, options),
    githubFetchAll<GitHubRepo>(`/users/${username}/starred?sort=updated`, options, 5), // Limit starred
  ]);

  return { username, repos, orgs, starred };
}

// ============================================
// Organization Scanning
// ============================================

export async function scanOrganization(
  orgName: string,
  token: string
): Promise<GitHubRepo[]> {
  return githubFetchAll<GitHubRepo>(
    `/orgs/${orgName}/repos?type=all&sort=updated`,
    { token }
  );
}

// ============================================
// Repository EDS Detection
// ============================================

export async function checkRepoForEDS(
  fullName: string,
  defaultBranch: string,
  token: string
): Promise<RepoEDSCheck> {
  const options: GitHubAPIOptions = { token };

  // Check for key EDS files/directories
  const checks = await Promise.allSettled([
    githubFetch(`/repos/${fullName}/contents/scripts/aem.js?ref=${defaultBranch}`, options),
    githubFetch(`/repos/${fullName}/contents/blocks?ref=${defaultBranch}`, options),
    githubFetch(`/repos/${fullName}/contents/scripts?ref=${defaultBranch}`, options),
    githubFetch(`/repos/${fullName}/contents/styles?ref=${defaultBranch}`, options),
    githubFetch(`/repos/${fullName}/contents/fstab.yaml?ref=${defaultBranch}`, options),
    githubFetch(`/repos/${fullName}/contents/.helix?ref=${defaultBranch}`, options),
  ]);

  return {
    hasAemJs: checks[0].status === 'fulfilled',
    hasBlocksDir: checks[1].status === 'fulfilled',
    hasScriptsDir: checks[2].status === 'fulfilled',
    hasStylesDir: checks[3].status === 'fulfilled',
    hasFstabYaml: checks[4].status === 'fulfilled',
    hasHelixDir: checks[5].status === 'fulfilled',
  };
}

export function calculateEDSConfidence(check: RepoEDSCheck): number {
  let score = 0;

  // Strong indicators (higher weight)
  if (check.hasAemJs) score += 35;
  if (check.hasBlocksDir) score += 25;
  if (check.hasFstabYaml) score += 15;
  if (check.hasHelixDir) score += 15;

  // Supporting indicators
  if (check.hasScriptsDir) score += 5;
  if (check.hasStylesDir) score += 5;

  return Math.min(100, score);
}

export function isLikelyEDS(check: RepoEDSCheck): boolean {
  // Must have either aem.js or blocks directory
  return check.hasAemJs || (check.hasBlocksDir && (check.hasFstabYaml || check.hasHelixDir));
}

// ============================================
// Live Site Detection
// ============================================

export function constructLiveUrl(fullName: string, defaultBranch: string): string {
  const [owner, repo] = fullName.split('/');
  return `https://${defaultBranch}--${repo}--${owner}.aem.live/`;
}

export async function detectEDSFromUrl(url: string): Promise<EDSDetectionResult> {
  const signals: EDSDetectionSignals = {
    hasRumScript: false,
    hasAemJs: false,
    hasLibFranklinJs: false,
    hasBlockStructure: false,
    hasSectionStructure: false,
    hasFastlyHeaders: false,
    isEDSDomain: false,
    hasBlocksDirectory: false,
    hasScriptsDirectory: false,
    lighthouseScore: null,
  };

  try {
    // Check domain pattern
    const urlObj = new URL(url);
    signals.isEDSDomain =
      urlObj.hostname.endsWith('.aem.live') ||
      urlObj.hostname.endsWith('.aem.page') ||
      urlObj.hostname.endsWith('.hlx.live') ||
      urlObj.hostname.endsWith('.hlx.page');

    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EDS-Block-Collector/1.0)',
      },
    });

    if (!response.ok) {
      return { isEDS: false, confidence: 0, signals, liveUrl: null };
    }

    // Check headers
    const headers = response.headers;
    signals.hasFastlyHeaders =
      headers.has('x-served-by') || headers.has('surrogate-key');

    // Parse HTML
    const html = await response.text();

    // Check for RUM script
    signals.hasRumScript =
      html.includes('ot.aem.live') ||
      html.includes('rum.hlx.page') ||
      html.includes('rum.hlx.live') ||
      html.includes('@adobe/helix-rum-js');

    // Check for aem.js
    signals.hasAemJs = html.includes('/scripts/aem.js') || html.includes('aem.js');

    // Check for lib-franklin.js (legacy)
    signals.hasLibFranklinJs = html.includes('lib-franklin.js');

    // Check for block structure
    signals.hasBlockStructure =
      html.includes('class="') &&
      (html.includes('-wrapper"') || html.includes(' block"'));

    // Check for section structure
    signals.hasSectionStructure = html.includes('class="section');

    // Calculate confidence
    let confidence = 0;
    if (signals.isEDSDomain) confidence += 30;
    if (signals.hasRumScript) confidence += 25;
    if (signals.hasAemJs) confidence += 20;
    if (signals.hasLibFranklinJs) confidence += 15;
    if (signals.hasBlockStructure) confidence += 10;
    if (signals.hasSectionStructure) confidence += 5;
    if (signals.hasFastlyHeaders) confidence += 5;

    confidence = Math.min(100, confidence);
    const isEDS = confidence >= 50;

    return {
      isEDS,
      confidence,
      signals,
      liveUrl: isEDS ? url : null,
    };
  } catch (error) {
    console.error(`Error detecting EDS for ${url}:`, error);
    return { isEDS: false, confidence: 0, signals, liveUrl: null };
  }
}

// ============================================
// Full Discovery Pipeline
// ============================================

export interface DiscoveryResult {
  developersScanned: number;
  orgsDiscovered: number;
  reposDiscovered: number;
  edsConfirmed: number;
  sitesCreated: number;
  errors: string[];
}

export async function runDiscoveryPipeline(
  db: D1Database,
  token: string,
  options?: {
    maxDevelopers?: number;
    maxOrgsPerDev?: number;
    maxContributorsPerRepo?: number;
  }
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    developersScanned: 0,
    orgsDiscovered: 0,
    reposDiscovered: 0,
    edsConfirmed: 0,
    sitesCreated: 0,
    errors: [],
  };

  const maxDevelopers = options?.maxDevelopers || 50; // Default to top 50 contributors
  const maxOrgsPerDev = options?.maxOrgsPerDev || 10;
  const maxContributorsPerRepo = options?.maxContributorsPerRepo || 100;

  // Step 1: Dynamically discover contributors from key EDS repos
  console.log('Discovering contributors from key EDS repositories...');
  const contributors = await discoverContributors(token, { maxPerRepo: maxContributorsPerRepo });
  console.log(`Found ${contributors.length} unique contributors across all repos`);

  // Save discovered contributors to database
  for (const contributor of contributors) {
    const priority = contributor.contributions > 100 ? 3 : contributor.contributions > 20 ? 2 : 1;
    await db
      .prepare(
        `INSERT INTO developers (id, username, priority)
         VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET priority = MAX(priority, excluded.priority)`
      )
      .bind(crypto.randomUUID(), contributor.username, priority)
      .run();
  }

  // Step 2: Scan top contributors
  const devsToScan = contributors.slice(0, maxDevelopers);
  console.log(`Scanning top ${devsToScan.length} contributors...`);

  for (const dev of devsToScan) {
    try {
      console.log(`Scanning developer: ${dev.username} (${dev.contributions} contributions)`);
      const scanResult = await scanDeveloper(dev.username, token);

      // Process repos
      for (const repo of scanResult.repos) {
        try {
          await upsertRepository(db, {
            fullName: repo.full_name,
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
            discoveredVia: `developer:${dev.username}`,
          });
          result.reposDiscovered++;
        } catch (e) {
          result.errors.push(`Failed to save repo ${repo.full_name}: ${e}`);
        }
      }

      // Process organizations
      const orgsToScan = scanResult.orgs.slice(0, maxOrgsPerDev);
      for (const org of orgsToScan) {
        try {
          await upsertOrganization(db, org.login, dev.username);
          result.orgsDiscovered++;

          // Scan org repos
          const orgRepos = await scanOrganization(org.login, token);
          await updateOrgScanned(db, org.login, orgRepos.length);

          for (const repo of orgRepos) {
            try {
              await upsertRepository(db, {
                fullName: repo.full_name,
                owner: repo.owner.login,
                name: repo.name,
                defaultBranch: repo.default_branch,
                discoveredVia: `org:${org.login}`,
              });
              result.reposDiscovered++;
            } catch (e) {
              result.errors.push(`Failed to save org repo ${repo.full_name}: ${e}`);
            }
          }
        } catch (e) {
          result.errors.push(`Failed to scan org ${org.login}: ${e}`);
        }
      }

      // Process starred repos (only if they look like EDS)
      for (const repo of scanResult.starred) {
        if (
          repo.full_name.toLowerCase().includes('hlx') ||
          repo.full_name.toLowerCase().includes('helix') ||
          repo.full_name.toLowerCase().includes('eds') ||
          repo.full_name.toLowerCase().includes('franklin')
        ) {
          try {
            await upsertRepository(db, {
              fullName: repo.full_name,
              owner: repo.owner.login,
              name: repo.name,
              defaultBranch: repo.default_branch,
              discoveredVia: `starred:${dev.username}`,
            });
            result.reposDiscovered++;
          } catch (e) {
            result.errors.push(`Failed to save starred repo ${repo.full_name}: ${e}`);
          }
        }
      }

      // Update developer stats
      await updateDeveloperScanned(
        db,
        dev.username,
        scanResult.repos.length,
        scanResult.orgs.length
      );
      result.developersScanned++;
    } catch (e) {
      result.errors.push(`Failed to scan developer ${dev.username}: ${e}`);
    }
  }

  console.log(`Finished scanning ${result.developersScanned} developers`);
  console.log(`Discovered ${result.orgsDiscovered} organizations and ${result.reposDiscovered} repositories`);

  // Step 3: Scan known EDS organizations
  const edsOrgs = ['aemsites', 'hlxsites']; // aemsites is the primary, hlxsites is legacy

  for (const orgName of edsOrgs) {
    try {
      console.log(`Scanning ${orgName} organization`);
      const orgRepos = await scanOrganization(orgName, token);
      console.log(`Found ${orgRepos.length} repos in ${orgName}`);

      for (const repo of orgRepos) {
        try {
          await upsertRepository(db, {
            fullName: repo.full_name,
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
            discoveredVia: `org:${orgName}`,
          });
          result.reposDiscovered++;
        } catch (e) {
          result.errors.push(`Failed to save ${orgName} repo ${repo.full_name}: ${e}`);
        }
      }
    } catch (e) {
      result.errors.push(`Failed to scan ${orgName} org: ${e}`);
    }
  }

  return result;
}

// ============================================
// EDS Verification Pipeline
// ============================================

export interface VerificationResult {
  reposChecked: number;
  edsConfirmed: number;
  sitesCreated: number;
  errors: string[];
}

export async function runVerificationPipeline(
  db: D1Database,
  token: string,
  options?: { maxRepos?: number; checkLiveUrl?: boolean }
): Promise<VerificationResult> {
  const result: VerificationResult = {
    reposChecked: 0,
    edsConfirmed: 0,
    sitesCreated: 0,
    errors: [],
  };

  const maxRepos = options?.maxRepos || 100;

  // Get unverified repositories
  const repos = await getUnscannedRepositories(db, maxRepos);

  for (const repo of repos) {
    try {
      console.log(`Checking repo: ${repo.full_name}`);

      // Check repo structure
      const check = await checkRepoForEDS(repo.full_name, repo.default_branch, token);
      const confidence = calculateEDSConfidence(check);
      const isEDS = isLikelyEDS(check);

      let liveUrl: string | null = null;

      // Optionally check live URL
      if (isEDS && options?.checkLiveUrl) {
        const constructedUrl = constructLiveUrl(repo.full_name, repo.default_branch);
        const liveDetection = await detectEDSFromUrl(constructedUrl);
        if (liveDetection.isEDS) {
          liveUrl = constructedUrl;
        }
      }

      // Update repository
      await updateRepositoryEDS(db, repo.full_name, isEDS, confidence, liveUrl || undefined);

      if (isEDS) {
        result.edsConfirmed++;

        // Create site if we have a live URL
        if (liveUrl) {
          const urlObj = new URL(liveUrl);
          await createSite(db, urlObj.hostname, repo.id);
          result.sitesCreated++;
        }
      }

      result.reposChecked++;
    } catch (e) {
      result.errors.push(`Failed to verify repo ${repo.full_name}: ${e}`);
    }
  }

  return result;
}

// ============================================
// Site URL Discovery
// ============================================

export async function discoverSiteUrls(
  db: D1Database,
  token: string
): Promise<{ discovered: number; errors: string[] }> {
  const result = { discovered: 0, errors: [] as string[] };

  // Get confirmed EDS repos without live URLs
  const repos = await db
    .prepare(
      `SELECT * FROM repositories
       WHERE is_eds_confirmed = 1 AND live_url IS NULL
       LIMIT 50`
    )
    .all<{
      id: string;
      full_name: string;
      default_branch: string;
    }>();

  for (const repo of repos.results) {
    try {
      const constructedUrl = constructLiveUrl(repo.full_name, repo.default_branch);
      const detection = await detectEDSFromUrl(constructedUrl);

      if (detection.isEDS && detection.liveUrl) {
        await updateRepositoryEDS(
          db,
          repo.full_name,
          true,
          detection.confidence,
          detection.liveUrl
        );

        const urlObj = new URL(detection.liveUrl);
        await createSite(db, urlObj.hostname, repo.id);
        result.discovered++;
      }
    } catch (e) {
      result.errors.push(`Failed to discover URL for ${repo.full_name}: ${e}`);
    }
  }

  return result;
}
