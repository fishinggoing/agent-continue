'use strict';
(() => {
  const root = document.documentElement;
  const button = document.getElementById('toggle-theme');
  const storageKey = `agent-continue-theme:${new URL('./', location.href).pathname}`;
  function applyTheme(value) {
    const theme = value === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    const label = theme === 'dark' ? '切换到浅色' : '切换到深色';
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.dataset.lucide = theme === 'dark' ? 'sun' : 'moon';
    button.replaceChildren(icon);
    window.lucide?.createIcons();
  }
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
  applyTheme(saved);
  button.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem(storageKey, theme); } catch { /* Keep the in-page choice. */ }
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
