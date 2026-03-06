// ── LLM Capture Pro — Popup Script ────────────────────────────────────────────
'use strict';

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const countBadge = document.getElementById('count-badge');
const logArea = document.getElementById('log');
const serverStatus = document.getElementById('server-status');

function log(msg) {
  const now = new Date().toLocaleTimeString('fr-FR', { hour12: false });
  logArea.textContent = `[${now}] ${msg}\n` + logArea.textContent.slice(0, 500);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(action) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { action }).catch(e => ({ error: e.message }));
}

async function refreshStatus() {
  const tab = await getActiveTab();
  // Injecter si pas encore fait
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['../content.js'] }).catch(() => {});

  const res = await chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }).catch(() => null);
  if (!res) { statusText.textContent = 'Extension non connectée'; dot.className = 'dot'; return; }

  if (res.capturing) {
    dot.className = 'dot on';
    statusText.textContent = 'Capture en cours…';
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('btn-stop').style.display = 'block';
  } else {
    dot.className = res.count > 0 ? 'dot proc' : 'dot';
    statusText.textContent = res.count > 0 ? `${res.count} messages capturés` : 'Prêt';
    document.getElementById('btn-start').style.display = 'block';
    document.getElementById('btn-stop').style.display = 'none';
  }

  if (res.count > 0) {
    countBadge.style.display = '';
    countBadge.textContent = res.count + ' msg';
  } else {
    countBadge.style.display = 'none';
  }
}

async function checkServer() {
  try {
    const r = await fetch('http://localhost:3747/health', { signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    serverStatus.textContent = '⬤ online';
    serverStatus.style.color = '#00ff9d';
    log(`Serveur OK — Claude: ${data.claudeConfigured ? '✓' : '✗'} GDrive: ${data.driveConfigured ? '✓' : '✗'}`);
  } catch {
    serverStatus.textContent = '⬤ offline';
    serverStatus.style.color = '#ff4566';
    log('Serveur hors ligne — lancez: node server/index.js');
  }
}

// Boutons
document.getElementById('btn-start').onclick = async () => {
  await sendToContent('START');
  log('Capture démarrée');
  setTimeout(refreshStatus, 300);
};

document.getElementById('btn-stop').onclick = async () => {
  await sendToContent('STOP');
  log('Capture arrêtée');
  setTimeout(refreshStatus, 300);
};

document.getElementById('btn-export').onclick = async () => {
  log('Envoi vers le serveur LLM…');
  dot.className = 'dot proc';
  statusText.textContent = 'Traitement en cours…';
  const res = await sendToContent('EXPORT');
  log(res?.ok ? 'Export lancé — voir la page' : `Erreur: ${res?.error || 'inconnue'}`);
  setTimeout(refreshStatus, 2000);
};

document.getElementById('btn-reset').onclick = async () => {
  await sendToContent('CLEAR');
  log('Capture réinitialisée');
  setTimeout(refreshStatus, 300);
};

document.getElementById('btn-gdrive').onclick = () => {
  chrome.tabs.create({ url: 'https://drive.google.com' });
};

// Init
refreshStatus();
checkServer();
setInterval(refreshStatus, 3000);
setInterval(checkServer, 10000);
