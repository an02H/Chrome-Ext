# ⬡ LLM Capture Pro

**Capture de conversations LLM → Claude API → Word DOCX → Google Drive**

```
Chrome Extension
     │
     │ (HTML brut + images)
     ▼
Server local :3747
     │
     ├─▶ Claude API (structuration, résumé, titre)
     │
     ├─▶ Génération DOCX (docx-js)
     │       • Titres, styles, rôles user/assistant
     │       • Blocs code (YAML, scripts) → police monospace + fond
     │       • Images capturées intégrées
     │       • Markdown → structure Word
     │
     └─▶ Upload Google Drive (OAuth2)
             └─▶ Lien partageable retourné à la page
```

---

## Installation rapide

### 1. Serveur local

```bash
cd server
cp .env.example .env
# Editez .env avec vos clés (voir ci-dessous)
npm install
npm start
```

### 2. Extension Chrome

1. Ouvrir `chrome://extensions`
2. Activer **Mode développeur** (coin supérieur droit)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner le dossier `extension/`

---

## Configuration des clés

### Anthropic (Claude API)

1. Aller sur https://console.anthropic.com
2. Créer une clé API
3. Ajouter dans `.env` : `ANTHROPIC_API_KEY=sk-ant-...`

### Google Drive (OAuth2)

1. Aller sur https://console.cloud.google.com
2. Créer un projet → Activer **Google Drive API**
3. Créer des identifiants → **OAuth 2.0** → Type: **Application de bureau**
4. Copier `Client ID` et `Client Secret` dans `.env`
5. **Obtenir le refresh token** (une seule fois) :

```bash
# Avec le serveur démarré:
curl http://localhost:3747/auth/google
# Ouvre l'URL retournée dans Chrome
# Autorise l'accès → copie le code affiché
# Puis:
curl -X POST http://localhost:3747/auth/google/callback \
  -H "Content-Type: application/json" \
  -d '{"code":"COLLE_LE_CODE_ICI"}'
# Copie le refresh_token retourné dans .env
```

---

## Utilisation

1. **Démarrer le serveur** : `npm start` dans `server/`
2. **Ouvrir une conversation** LLM dans Chrome
3. **Cliquer l'icône** de l'extension → la barre de capture apparaît en haut
4. Cliquer **▶ DÉMARRER** → faire défiler la page (les blocs masqués s'ouvrent automatiquement)
5. Cliquer **■ ARRÊTER** quand tout est visible
6. Cliquer **⚡ TRAITER & EXPORTER** :
   - Claude API analyse et structure la conversation
   - Un fichier `.docx` est généré dans `server/output/`
   - Le fichier est uploadé sur Google Drive
   - Un onglet s'ouvre avec le document Drive

---

## Structure du DOCX généré

| Élément | Style |
|---------|-------|
| Titre de la conversation | Titre Word, généré par Claude |
| Résumé exécutif | Italique, fond clair |
| Messages utilisateur | Fond bleu pâle |
| Messages assistant | Fond vert pâle |
| Blocs de code | Police `Courier New`, fond gris |
| YAML | Même style code |
| Titres markdown `##` | Heading 2/3 Word |
| Images | Intégrées, redimensionnées max 500px |

---

## Sites supportés nativement

- **Claude** (claude.ai)
- **ChatGPT** (chatgpt.com, chat.openai.com)
- **Gemini** (gemini.google.com)
- **Perplexity** (perplexity.ai)
- Tout autre site (détection générique)

---

## Architecture sécurité

```
Extension Chrome  ──────►  localhost:3747  ──────►  Anthropic API
                                                     (clé dans .env)
                                │
                                └──────────────────►  Google Drive API
                                                     (OAuth2 refresh token)
```

Les clés API ne transitent **jamais** dans l'extension Chrome.
Elles restent sur le serveur local dans le fichier `.env`.

---

## Endpoints serveur

| Méthode | URL | Description |
|---------|-----|-------------|
| `GET`  | `/health` | Statut + config |
| `POST` | `/process` | Pipeline complet |
| `GET`  | `/files` | Liste des DOCX générés |
| `GET`  | `/output/:file` | Téléchargement DOCX |
| `GET`  | `/auth/google` | URL OAuth2 |
| `POST` | `/auth/google/callback` | Échange code → token |
