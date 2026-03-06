// ── LLM Capture Pro — Background Service Worker ──────────────────────────────
'use strict';

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  }).catch(() => {});
  chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_BAR' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'RELAY_TO_SERVER') {
    // Relayer depuis le popup si besoin
    fetch('http://localhost:3747/' + msg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data),
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
