/**
 * AEM Block Importer - Popup Script
 * Simple launcher that opens the sidebar on the current page
 */

document.getElementById('open-sidebar').addEventListener('click', async () => {
  const btn = document.getElementById('open-sidebar');
  const error = document.getElementById('error');

  btn.disabled = true;
  btn.textContent = 'Opening...';
  error.style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_SIDEBAR' });

    if (response?.error) {
      throw new Error(response.error);
    }

    // Close popup - sidebar is now on the page
    window.close();
  } catch (e) {
    error.textContent = e.message || 'Failed to open sidebar';
    error.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Open Sidebar';
  }
});
