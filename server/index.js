// ── LLM Capture Pro — Serveur Local ───────────────────────────────────────────
// Pipeline: Capture brute → Claude API (structuration/résumé) → DOCX → Google Drive
// Port: 3747
'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const docx     = require('docx');
require('dotenv').config();

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, HeadingLevel, AlignmentType, BorderStyle, WidthType,
  ShadingType, LevelFormat, PageNumber, PageBreak,
} = docx;

const app  = express();
const PORT = 3747;
const OUT  = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use('/output', express.static(OUT));

// ── Clients ───────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Google Drive OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'   // redirect OOB pour app desktop/locale
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    claudeConfigured: !!process.env.ANTHROPIC_API_KEY,
    driveConfigured: !!process.env.GOOGLE_REFRESH_TOKEN,
  });
});

// ── Téléchargement image depuis URL ──────────────────────────────────────────
function fetchImage(url) {
  return new Promise((resolve, reject) => {
    if (url.startsWith('data:')) {
      const [header, b64] = url.split(',');
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      resolve({ data: Buffer.from(b64, 'base64'), mime });
      return;
    }
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        data: Buffer.concat(chunks),
        mime: res.headers['content-type'] || 'image/png',
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function mimeToDocxType(mime) {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return 'png';
}

// ── Pipeline Claude API : structuration de la conversation ────────────────────
async function processWithClaude(blocks, siteInfo) {
  const conversationText = blocks.map((b, i) => {
    const role = b.role === 'user' ? '👤 UTILISATEUR' : '🤖 ASSISTANT';
    return `--- Message ${i + 1} [${role}] ---\n${b.text || '(contenu non textuel)'}`;
  }).join('\n\n');

  const systemPrompt = `Tu es un expert en structuration de conversations avec des LLMs.
Tu reçois le texte brut d'une conversation capturée depuis ${siteInfo.name}.
Ta tâche est de produire une analyse structurée en JSON STRICT (sans markdown, sans backticks).

Retourne UNIQUEMENT ce JSON:
{
  "title": "Titre concis décrivant la conversation (max 80 chars)",
  "summary": "Résumé exécutif de la conversation (3-5 phrases)",
  "mainTopics": ["topic1", "topic2"],
  "codeBlocks": [{"language": "python", "description": "ce que fait ce code"}],
  "keyInsights": ["insight1", "insight2"],
  "messageCount": 0,
  "estimatedTokens": 0
}`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: conversationText.slice(0, 20000) }],
    });

    const raw = response.content[0]?.text || '{}';
    // Strip possible markdown fences
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.warn('[Claude API] Fallback metadata:', err.message);
    return {
      title: `Conversation ${siteInfo.name} — ${new Date().toLocaleDateString('fr-FR')}`,
      summary: `Conversation capturée depuis ${siteInfo.name} avec ${blocks.length} échanges.`,
      mainTopics: [],
      keyInsights: [],
      messageCount: blocks.length,
    };
  }
}

// ── Génération DOCX ──────────────────────────────────────────────────────────
async function generateDocx(blocks, metadata, siteInfo) {
  const children = [];

  // ─ Styles helpers ─
  const ACCENT_USER = '1a3a5c';
  const ACCENT_BOT  = '1a3a28';
  const GRAY_LIGHT  = 'f4f4f8';
  const CODE_BG     = '1e1e2e';

  function makeDivider() {
    return new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'ddddee', space: 1 } },
      spacing: { before: 80, after: 80 },
      children: [],
    });
  }

  function makeCodeBlock(text, language = '') {
    const lines = text.split('\n');
    return lines.map((line, i) => new Paragraph({
      shading: { fill: 'f0f0f8', type: ShadingType.CLEAR },
      spacing: { line: 240, before: i === 0 ? 80 : 0, after: i === lines.length - 1 ? 80 : 0 },
      border: i === 0 ? { top: { style: BorderStyle.SINGLE, size: 2, color: '9090cc' } } :
              i === lines.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 2, color: '9090cc' } } : {},
      indent: { left: 360 },
      children: [new TextRun({
        text: line || ' ',
        font: 'Courier New',
        size: 18,
        color: '2c2c3e',
      })],
    }));
  }

  // ─ Page de titre ─
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { before: 1440, after: 240 },
      children: [new TextRun({ text: metadata.title || 'Conversation LLM', bold: true, size: 48, color: '1a1a3e' })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: `Source: ${siteInfo.name}  •  ${new Date(siteInfo.capturedAt).toLocaleString('fr-FR')}`, size: 20, color: '888899', italics: true })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: `URL: `, size: 18, color: '888899' }), new TextRun({ text: siteInfo.url, size: 18, color: '4060cc' })],
    }),
  );

  // ─ Résumé ─
  if (metadata.summary) {
    children.push(
      new Paragraph({ spacing: { before: 360, after: 120 }, heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Résumé', size: 28, bold: true })] }),
      new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: metadata.summary, italics: true, size: 22, color: '333355' })] }),
    );
  }

  // ─ Topics & Insights ─
  if (metadata.mainTopics?.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Sujets abordés')] }));
    metadata.mainTopics.forEach(t => children.push(
      new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: t, size: 20 })] })
    ));
  }

  // ─ Saut de page avant conversation ─
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Conversation complète', bold: true })] }));

  // ─ Corps de la conversation ─
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isUser = block.role === 'user';
    const roleLabel = isUser ? '👤 Utilisateur' : '🤖 Assistant';
    const roleBg    = isUser ? 'eef2ff' : 'f0fff4';
    const roleFg    = isUser ? ACCENT_USER : '1a3a28';

    // En-tête message
    children.push(makeDivider());
    children.push(new Paragraph({
      shading: { fill: roleBg, type: ShadingType.CLEAR },
      spacing: { before: 120, after: 80 },
      indent: { left: 0 },
      children: [
        new TextRun({ text: `  ${roleLabel}`, bold: true, size: 22, color: roleFg }),
        new TextRun({ text: `   #${i + 1}`, size: 18, color: 'aaaacc' }),
      ],
    }));

    // Contenu textuel — détection YAML/code/markdown
    const text = block.text || '';
    const lines = text.split('\n');
    let inCode = false;
    let codeBuf = [];
    let codeLang = '';

    for (const line of lines) {
      // Détection bloc de code markdown
      if (line.trimStart().startsWith('```')) {
        if (!inCode) {
          inCode = true;
          codeLang = line.trim().replace('```', '').trim();
          codeBuf = [];
        } else {
          // Fermeture bloc code
          makeCodeBlock(codeBuf.join('\n'), codeLang).forEach(p => children.push(p));
          inCode = false; codeBuf = []; codeLang = '';
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      // Détection YAML standalone
      const isYaml = /^[\w-]+:\s/.test(line) && !line.startsWith('#');
      const isMarkdownH = line.startsWith('#');
      const isBullet   = /^[\-\*\+]\s/.test(line);

      if (isMarkdownH) {
        const level = (line.match(/^#+/)?.[0] || '').length;
        const headingText = line.replace(/^#+\s*/, '');
        children.push(new Paragraph({
          heading: level <= 3 ? [HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][level - 1] : HeadingLevel.HEADING_4,
          children: [new TextRun({ text: headingText, bold: true })],
        }));
      } else if (isBullet) {
        children.push(new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: line.replace(/^[\-\*\+]\s/, ''), size: 20 })],
        }));
      } else if (isYaml) {
        makeCodeBlock(line, 'yaml').forEach(p => children.push(p));
      } else if (line.trim()) {
        children.push(new Paragraph({
          spacing: { after: 80 },
          indent: { left: isUser ? 0 : 180 },
          children: [new TextRun({ text: line, size: 22 })],
        }));
      } else {
        children.push(new Paragraph({ spacing: { after: 40 }, children: [] }));
      }
    }

    // Images capturées
    if (block.images?.length) {
      for (const img of block.images) {
        try {
          const { data, mime } = await fetchImage(img.src);
          const imgType = mimeToDocxType(mime);
          // Redimensionner max 500px de large
          const maxW = 500 * 9525; // EMU
          const ratio = img.width && img.width > 0 ? Math.min(1, (500 / img.width)) : 1;
          const w = Math.round((img.width || 400) * ratio) * 9525;
          const h = Math.round((img.height || 300) * ratio) * 9525;
          children.push(new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [new ImageRun({ data, transformation: { width: w / 9525, height: h / 9525 }, type: imgType })],
          }));
          if (img.alt) children.push(new Paragraph({
            spacing: { after: 80 },
            children: [new TextRun({ text: img.alt, italics: true, size: 18, color: '888899' })],
          }));
        } catch (e) {
          console.warn('[Image skip]', img.src.slice(0, 60), e.message);
        }
      }
    }
  }

  // ─ Document final ─
  const doc = new Document({
    creator: 'LLM Capture Pro',
    title: metadata.title,
    description: metadata.summary,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, color: '1a1a3e', font: 'Calibri' },
          paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: '333355', font: 'Calibri' },
          paragraph: { spacing: { before: 240, after: 80 }, outlineLevel: 1 } },
      ],
    },
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const slug = metadata.title.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '_').slice(0, 50);
  const filename = `LLM_Capture_${slug}_${Date.now()}.docx`;
  const filepath = path.join(OUT, filename);
  fs.writeFileSync(filepath, buffer);
  return { filepath, filename, buffer };
}

// ── Upload Google Drive ───────────────────────────────────────────────────────
async function uploadToDrive(buffer, filename, folderId) {
  const { Readable } = require('stream');
  const meta = {
    name: filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ...(folderId ? { parents: [folderId] } : {}),
  };
  const stream = Readable.from(buffer);
  const res = await drive.files.create({
    requestBody: meta,
    media: { mimeType: meta.mimeType, body: stream },
    fields: 'id,webViewLink,name',
  });
  // Rendre le fichier visible (lecture pour tout le monde avec le lien)
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  }).catch(() => {}); // non-bloquant
  return res.data;
}

// ── Route principale : traitement complet ─────────────────────────────────────
app.post('/process', async (req, res) => {
  const { blocks, site, url, title, capturedAt } = req.body;
  const siteInfo = { name: site || 'LLM', url: url || '', capturedAt: capturedAt || new Date().toISOString() };

  console.log(`\n[${new Date().toLocaleTimeString()}] Traitement: ${blocks.length} blocs depuis ${siteInfo.name}`);

  try {
    // 1. Claude API — analyse et structuration
    console.log('  → Claude API: structuration…');
    const metadata = await processWithClaude(blocks, siteInfo);
    console.log(`  ✓ Titre: ${metadata.title}`);

    // 2. Génération DOCX
    console.log('  → Génération DOCX…');
    const { filepath, filename, buffer } = await generateDocx(blocks, metadata, siteInfo);
    console.log(`  ✓ DOCX: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);

    // 3. Upload Google Drive (si configuré)
    let driveUrl = null;
    let driveFileId = null;
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      console.log('  → Upload Google Drive…');
      try {
        const driveFile = await uploadToDrive(buffer, filename, process.env.GOOGLE_DRIVE_FOLDER_ID || null);
        driveUrl = driveFile.webViewLink;
        driveFileId = driveFile.id;
        console.log(`  ✓ Drive: ${driveUrl}`);
      } catch (driveErr) {
        console.warn('  ✗ Drive upload failed:', driveErr.message);
      }
    }

    res.json({
      ok: true,
      filename,
      docxPath: `/output/${filename}`,
      downloadUrl: `http://localhost:3747/output/${filename}`,
      driveUrl,
      driveFileId,
      metadata: {
        title: metadata.title,
        summary: metadata.summary,
        messageCount: blocks.length,
      },
    });

  } catch (err) {
    console.error('  ✗ Erreur pipeline:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Auth Google Drive : génération URL OAuth ──────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });
  res.json({ authUrl: url, instructions: 'Ouvrez cette URL dans Chrome, autorisez, copiez le code, puis POST /auth/google/callback avec {code:"..."}' });
});

app.post('/auth/google/callback', async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.json({
      ok: true,
      refresh_token: tokens.refresh_token,
      message: 'Ajoutez GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + ' dans votre .env',
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Listage des exports ───────────────────────────────────────────────────────
app.get('/files', (req, res) => {
  const files = fs.readdirSync(OUT)
    .filter(f => f.endsWith('.docx'))
    .map(f => {
      const stat = fs.statSync(path.join(OUT, f));
      return { name: f, size: stat.size, created: stat.birthtime, url: `http://localhost:3747/output/${f}` };
    })
    .sort((a, b) => b.created - a.created);
  res.json({ files });
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  LLM Capture Pro — Serveur local     ║`);
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Claude API : ${process.env.ANTHROPIC_API_KEY ? '✓ configuré' : '✗ manquant (ANTHROPIC_API_KEY)'}`.padEnd(45) + '║');
  console.log(`║  Google     : ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ configuré' : '✗ manquant (voir /auth/google)'}`.padEnd(45) + '║');
  console.log(`╚══════════════════════════════════════╝\n`);
});
