/**
 * State Manager for AEM Block Importer Extension
 *
 * Manages persistent state using chrome.storage.local
 */

const StateManager = {
  CONFIG_KEY: 'aem_importer_config',
  STATE_KEY: 'aem_importer_state',

  /**
   * Get saved configuration
   */
  async getConfig() {
    const result = await chrome.storage.local.get(this.CONFIG_KEY);
    return result[this.CONFIG_KEY] || {};
  },

  /**
   * Save configuration
   */
  async saveConfig(config) {
    await chrome.storage.local.set({
      [this.CONFIG_KEY]: {
        ...config,
        updatedAt: Date.now(),
      },
    });
  },

  /**
   * Get current operation state
   */
  async getState() {
    const result = await chrome.storage.local.get(this.STATE_KEY);
    return result[this.STATE_KEY] || {};
  },

  /**
   * Update operation state
   */
  async setState(state) {
    const current = await this.getState();
    await chrome.storage.local.set({
      [this.STATE_KEY]: {
        ...current,
        ...state,
        updatedAt: Date.now(),
      },
    });
  },

  /**
   * Clear operation state
   */
  async clearState() {
    await chrome.storage.local.remove(this.STATE_KEY);
  },

  /**
   * Generate a unique session ID (short, hyphen-separated for valid subdomain URLs)
   */
  generateSessionId() {
    // Use short random string only (8 chars) to keep branch names under DNS limits
    return Math.random().toString(36).substr(2, 8);
  },
};

// Make available globally
if (typeof window !== 'undefined') {
  window.StateManager = StateManager;
}
