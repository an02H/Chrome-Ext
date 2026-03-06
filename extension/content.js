// ── LLM Capture Pro — Content Script ──────────────────────────────────────────
// Capture scrollée, expansion auto, extraction HTML+images → envoi au serveur local
'use strict';

(function () {
  if (window.__llmCaptureLoaded) return;
  window.__llmCaptureLoaded = true;

  // ── Profils par site ─────────────────────────────────────────────────────────
  const PROFILES = {
    'claude.ai': {
      name: 'Claude',
      turns: '[data-testid="human-turn"],[data-testid="ai-turn"],.human-turn,.ai-turn',
      roleAttr: 'data-testid',
      roleMap: { 'human-turn': 'user', 'ai-turn': 'assistant' },
      expandBtns: 'button[aria-label*="xpand"],button[aria-label*="plus"],.expand-btn',
      codeBlocks: 'pre',
    },
    'chatgpt.com': {
      name: 'ChatGPT',
      turns: '[data-message-author-role]',
      roleAttr: 'data-message-author-role',
      roleMap: { user: 'user', assistant: 'assistant' },
      expandBtns: 'button:has(svg)[class*="more"],button[aria-label*="more"]',
      codeBlocks: 'pre',
    },
    'chat.openai.com': {
      name: 'ChatGPT',
      turns: '[data-message-author-role]',
      roleAttr: 'data-message-author-role',
      roleMap: { user: 'user', assistant: 'assistant' },
      expandBtns: 'button[aria-label*="more"]',
      codeBlocks: 'pre',
    },
    'gemini.google.com': {
      name: 'Gemini',
      turns: '.conversation-turn,message-content,.user-query-text-block,.model-response-text',
      expandBtns: 'button[aria-label*="expand"],button[aria-label*="Show"]',
      codeBlocks: 'pre',
    },
    'www.perplexity.ai': {
      name: 'Perplexity',
      turns: '.prose,[class*="UserMessage"],[class*="Answer"]',
      codeBlocks: 'pre',
    },
  };

  function getProfile() {
    return PROFILES[location.hostname] || {
      name: location.hostname,
      turns: 'main [class*="message"],main [class*="turn"],article,[class*="chat-message"]',
      codeBlocks: 'pre',
    };
  }

  // ── État ─────────────────────────────────────────────────────────────────────
  let isCapturing = false;
  let blocks = [];        // { role, html, timestamp }
  let seenEls = new WeakSet();
  let scanInterval = null;
  let barEl = null, toastEl = null, progressEl = null, progressFill = null;

  // ── Utilitaires DOM ──────────────────────────────────────────────────────────
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  function toast(msg, type = 'ok', duration = 3000) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = `show ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = ''; }, duration);
  }

  function setProgress(pct) {
    if (!progressEl) return;
    progressEl.style.display = 'block';
    progressFill.style.width = pct + '%';
    if (pct >= 100) setTimeout(() => { progressEl.style.display = 'none'; }, 600);
  }

  function updateBar() {
    if (!barEl) return;
    const statusEl = barEl.querySelector('.cap-status');
    const countEl = barEl.querySelector('.cap-count');
    if (statusEl) statusEl.textContent = isCapturing ? '● REC' : blocks.length ? `${blocks.length} blocs` : 'PRÊT';
    if (countEl) countEl.textContent = blocks.length ? `${blocks.length} msg` : '';
  }

  // ── Expansion des blocs masqués ──────────────────────────────────────────────
  async function expandHiddenContent() {
    const profile = getProfile();
    if (!profile.expandBtns) return;
    let expanded = 0;
    const btns = $$(profile.expandBtns);
    for (const btn of btns) {
      if (btn.offsetParent !== null) { // visible
        btn.click();
        expanded++;
        await sleep(150);
      }
    }
    // Expand details/summary natifs
    $$('details:not([open])').forEach(d => { d.open = true; expanded++; });
    // Expand [aria-expanded="false"]
    $$('[aria-expanded="false"]').forEach(el => {
      try { el.click(); expanded++; } catch (_) {}
    });
    if (expanded) await sleep(400);
    return expanded;
  }

  // ── Capture d'un nœud ────────────────────────────────────────────────────────
  function extractImages(el) {
    const imgs = [];
    $$('img', el).forEach(img => {
      if (img.src && !img.src.startsWith('data:image/svg')) {
        imgs.push({ src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight });
      }
    });
    return imgs;
  }

  function extractBlock(el) {
    const profile = getProfile();
    let role = 'unknown';
    if (profile.roleAttr) {
      const val = el.getAttribute(profile.roleAttr) || '';
      role = (profile.roleMap && profile.roleMap[val]) || val || 'unknown';
    }
    // Fallback role detection
    if (role === 'unknown') {
      const cls = el.className || '';
      if (/user|human|you|query/i.test(cls)) role = 'user';
      else if (/assistant|ai|bot|model|answer|response/i.test(cls)) role = 'assistant';
    }
    // Clone propre du HTML (on retire les boutons de contrôle)
    const clone = el.cloneNode(true);
    $$('button,svg,[aria-label*="copy"],[aria-label*="Copy"],[class*="action"],[class*="toolbar"]', clone)
      .forEach(b => b.remove());

    return {
      role,
      html: clone.innerHTML,
      text: el.innerText || el.textContent || '',
      images: extractImages(el),
      timestamp: Date.now(),
    };
  }

  // ── Scan de la page ──────────────────────────────────────────────────────────
  function scanPage() {
    if (!isCapturing) return;
    const profile = getProfile();
    const turns = $$(profile.turns);
    let added = 0;
    turns.forEach(el => {
      if (!seenEls.has(el)) {
        seenEls.add(el);
        blocks.push(extractBlock(el));
        el.style.outline = '1px solid rgba(0,255,157,.25)';
        added++;
      }
    });
    if (added) updateBar();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── DÉMARRER la capture ──────────────────────────────────────────────────────
  async function startCapture() {
    if (isCapturing) return;
    isCapturing = true;
    blocks = [];
    seenEls = new WeakSet();

    toast('📡 Capture démarrée — faites défiler', 'ok', 4000);
    barEl.className = 'capturing';

    // Expansion immédiate des blocs masqués
    const expanded = await expandHiddenContent();
    if (expanded) toast(`↕ ${expanded} blocs masqués révélés`, 'info', 2000);

    // Scan initial
    scanPage();

    // Scan continu pendant le défilement
    scanInterval = setInterval(scanPage, 600);
    document.addEventListener('scroll', scanPage, { passive: true });

    updateBar();
    renderBar();
  }

  // ── ARRÊTER la capture ───────────────────────────────────────────────────────
  async function stopCapture() {
    if (!isCapturing) return;
    isCapturing = false;
    clearInterval(scanInterval);
    document.removeEventListener('scroll', scanPage);

    // Scan final
    await expandHiddenContent();
    scanPage();

    barEl.className = '';
    toast(`✅ Capture terminée — ${blocks.length} messages`, 'ok', 3000);
    updateBar();
    renderBar();
  }

  // ── ENVOYER AU SERVEUR LOCAL → LLM + DOCX + GDRIVE ──────────────────────────
  async function processAndExport() {
    if (!blocks.length) { toast('⚠ Rien à exporter', 'error'); return; }

    barEl.className = 'processing';
    setProgress(5);
    toast('🧠 Envoi au serveur local…', 'info', 10000);

    const payload = {
      site: getProfile().name,
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      blocks: blocks,
    };

    try {
      setProgress(20);
      const resp = await fetch('http://localhost:3747/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error(`Serveur: ${resp.status} ${resp.statusText}`);
      setProgress(60);

      const result = await resp.json();
      setProgress(90);

      if (result.docxPath) {
        toast(`📄 DOCX généré: ${result.filename}`, 'ok', 3000);
      }
      if (result.driveUrl) {
        setTimeout(() => {
          toast(`☁ Envoyé sur Google Drive ↗`, 'info', 5000);
        }, 1200);
        // Ouvrir dans un nouvel onglet après 2s
        setTimeout(() => window.open(result.driveUrl, '_blank'), 2500);
      }
      setProgress(100);
      barEl.className = '';
      updateBar();
      renderBar();

    } catch (err) {
      setProgress(0);
      barEl.className = '';
      toast(`❌ Erreur: ${err.message}`, 'error', 6000);
      console.error('[LLM Capture]', err);
    }
  }

  // ── CONSTRUIRE LA BARRE UI ───────────────────────────────────────────────────
  function buildBar() {
    if (document.getElementById('llm-cap-bar')) return;

    barEl = document.createElement('div');
    barEl.id = 'llm-cap-bar';
    renderBarHTML();
    document.body.prepend(barEl);

    // Progress bar
    progressEl = document.createElement('div');
    progressEl.id = 'llm-cap-progress';
    progressFill = document.createElement('div');
    progressFill.id = 'llm-cap-progress-fill';
    progressEl.appendChild(progressFill);
    document.body.insertBefore(progressEl, barEl.nextSibling);

    // Toast
    toastEl = document.createElement('div');
    toastEl.id = 'llm-cap-toast';
    document.body.appendChild(toastEl);

    // Décale le body pour pas masquer le contenu
    document.body.style.paddingTop = '44px';
  }

  function renderBarHTML() {
    const profile = getProfile();
    const hasBlocks = blocks.length > 0;
    barEl.innerHTML = `
      <div class="cap-left">
        <div class="cap-dot"></div>
        <span class="cap-label">LLM CAPTURE</span>
        <span style="color:#444;font-size:10px">│</span>
        <span style="color:#606080;font-size:10px">${profile.name}</span>
        <span class="cap-status">${isCapturing ? '● REC' : hasBlocks ? blocks.length + ' msg capturés' : 'PRÊT'}</span>
        ${hasBlocks ? `<span class="cap-count">${blocks.length}</span>` : ''}
      </div>
      <div class="cap-right">
        ${!isCapturing && !hasBlocks ? `<button class="btn-start" id="cap-btn-start">▶ DÉMARRER</button>` : ''}
        ${isCapturing ? `<button class="btn-stop" id="cap-btn-stop">■ ARRÊTER</button>` : ''}
        ${!isCapturing && hasBlocks ? `
          <button class="btn-start" id="cap-btn-resume">▶ CONTINUER</button>
          <button class="btn-process" id="cap-btn-export">⚡ TRAITER & EXPORTER</button>
          <button class="btn-secondary" id="cap-btn-clear">✕ RESET</button>
        ` : ''}
        <button class="btn-secondary" id="cap-btn-close" style="padding:4px 8px">✕</button>
      </div>
    `;
    bindBarEvents();
  }

  function renderBar() { if (barEl) renderBarHTML(); }

  function bindBarEvents() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('cap-btn-start', startCapture);
    on('cap-btn-stop', stopCapture);
    on('cap-btn-resume', startCapture);
    on('cap-btn-export', processAndExport);
    on('cap-btn-clear', () => {
      blocks = []; seenEls = new WeakSet();
      $$('[style*="outline"]').forEach(el => el.style.outline = '');
      updateBar(); renderBar();
      toast('🗑 Capture effacée', 'info');
    });
    on('cap-btn-close', () => {
      barEl.remove(); progressEl?.remove(); toastEl?.remove();
      document.body.style.paddingTop = '';
      window.__llmCaptureLoaded = false;
      clearInterval(scanInterval);
    });
  }

  // ── Écoute les messages du background/popup ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'TOGGLE_BAR') { buildBar(); sendResponse({ ok: true }); }
    if (msg.action === 'GET_STATUS') sendResponse({ capturing: isCapturing, count: blocks.length });
    if (msg.action === 'START') startCapture().then(() => sendResponse({ ok: true }));
    if (msg.action === 'STOP')  stopCapture().then(() => sendResponse({ ok: true }));
    if (msg.action === 'EXPORT') processAndExport().then(() => sendResponse({ ok: true }));
    return true;
  });

  // Auto-init
  buildBar();

})();
