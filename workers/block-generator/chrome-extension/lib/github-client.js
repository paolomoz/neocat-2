/**
 * GitHub API Client for AEM Block Importer Extension
 *
 * Handles direct GitHub API calls for block library management.
 * Uses public API for reads (no token needed for public repos).
 */

const GitHubClient = {
  API_BASE: 'https://api.github.com',

  /**
   * Parse owner/repo string
   */
  parseRepo(repoString) {
    const [owner, repo] = repoString.split('/');
    return { owner, repo };
  },

  /**
   * Make GitHub API request (token optional for public repos)
   */
  async request(endpoint, options = {}) {
    const headers = {
      Accept: 'application/vnd.github.v3+json',
      ...options.headers,
    };

    const response = await fetch(`${this.API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `GitHub API error: ${response.status}`);
    }

    return response.json();
  },

  /**
   * Validate repository exists and is accessible
   */
  async validateRepo(repoString) {
    const { owner, repo } = this.parseRepo(repoString);

    try {
      await this.request(`/repos/${owner}/${repo}`);
      return true;
    } catch (error) {
      console.error('Repository validation failed:', error);
      return false;
    }
  },

  /**
   * Get list of blocks from repository's /blocks folder
   */
  async getBlocks(repoString) {
    const { owner, repo } = this.parseRepo(repoString);

    try {
      const contents = await this.request(
        `/repos/${owner}/${repo}/contents/blocks`
      );

      // Filter for directories only (each block is a directory)
      return contents
        .filter((item) => item.type === 'dir')
        .map((item) => ({
          name: item.name,
          path: item.path,
          url: item.html_url,
        }));
    } catch (error) {
      // 404 means no blocks folder yet
      if (error.message.includes('404')) {
        return [];
      }
      throw error;
    }
  },

  /**
   * Get content of a specific file (public repos only)
   */
  async getFileContent(repoString, path) {
    const { owner, repo } = this.parseRepo(repoString);

    const response = await this.request(
      `/repos/${owner}/${repo}/contents/${path}`
    );

    // GitHub returns base64 encoded content
    if (response.content) {
      return atob(response.content);
    }

    return null;
  },

  /**
   * Get repository branches (public repos only)
   */
  async getBranches(repoString) {
    const { owner, repo } = this.parseRepo(repoString);

    return this.request(`/repos/${owner}/${repo}/branches`);
  },

  /**
   * Get default branch name (public repos only)
   */
  async getDefaultBranch(repoString) {
    const { owner, repo } = this.parseRepo(repoString);

    const repoInfo = await this.request(`/repos/${owner}/${repo}`);
    return repoInfo.default_branch;
  },
};

// Make available globally
if (typeof window !== 'undefined') {
  window.GitHubClient = GitHubClient;
}
