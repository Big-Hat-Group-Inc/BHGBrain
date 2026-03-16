# BHGBrain

Mémoire persistante avec indexation vectorielle pour les clients MCP (Claude, Codex, OpenClaw, etc.).

BHGBrain stocke les souvenirs dans SQLite (métadonnées + recherche plein texte) et Qdrant (vecteurs sémantiques), et les expose via le Model Context Protocol (MCP) en mode stdio ou HTTP. Il est conçu pour offrir aux agents IA un second cerveau durable et consultable, persistant d'une session à l'autre — avec gestion complète du cycle de vie, déduplication automatique, rétention par niveaux et recherche hybride.

---

## Table des matières

1. [Vue d'ensemble et architecture](#vue-densemble-et-architecture)
2. [Prérequis](#prérequis)
3. [Configuration de Qdrant](#configuration-de-qdrant)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [Variables d'environnement](#variables-denvironnement)
7. [Démarrage du serveur](#démarrage-du-serveur)
8. [Configuration du client MCP](#configuration-du-client-mcp)
9. [Gestion de la mémoire](#gestion-de-la-mémoire)
   - [Modèle de données](#modèle-de-données)
   - [Types de mémoire](#types-de-mémoire)
   - [Espaces de noms et collections](#espaces-de-noms-et-collections)
   - [Niveaux de rétention](#niveaux-de-rétention)
   - [Cycle de vie des niveaux — Attribution, Promotion, Fenêtre glissante](#cycle-de-vie-des-niveaux--attribution-promotion-fenêtre-glissante)
   - [Déduplication](#déduplication)
   - [Normalisation du contenu](#normalisation-du-contenu)
   - [Score d'importance](#score-dimportance)
   - [Catégories — Emplacements de politique persistants](#catégories--emplacements-de-politique-persistants)
   - [Déclin, nettoyage et archivage](#déclin-nettoyage-et-archivage)
   - [Avertissements de pré-expiration](#avertissements-de-pré-expiration)
   - [Limites de ressources et budgets de capacité](#limites-de-ressources-et-budgets-de-capacité)
10. [Recherche](#recherche)
    - [Recherche sémantique](#recherche-sémantique)
    - [Recherche plein texte](#recherche-plein-texte)
    - [Recherche hybride](#recherche-hybride)
    - [Recall vs Search — Différences](#recall-vs-search--différences)
    - [Filtrage](#filtrage)
    - [Seuils de score et boosts par niveau](#seuils-de-score-et-boosts-par-niveau)
11. [Sauvegarde et restauration](#sauvegarde-et-restauration)
12. [Santé et métriques](#santé-et-métriques)
13. [Sécurité](#sécurité)
14. [Ressources MCP](#ressources-mcp)
15. [Prompt d'amorçage](#prompt-damorçage)
16. [Référence CLI](#référence-cli)
17. [Référence des outils MCP](#référence-des-outils-mcp)
18. [Mise à jour](#mise-à-jour)
19. [Notes de comportement](#notes-de-comportement)

---

## Vue d'ensemble et architecture

BHGBrain est un serveur de mémoire persistante construit sur le Model Context Protocol. Il stocke tout ce que les agents IA apprennent, décident et observent au fil des sessions — puis rend ces connaissances disponibles via un rappel sémantique, une recherche plein texte et un contexte injecté.

### Architecture à double stockage

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                              │
│                (Claude Desktop / OpenClaw / Codex)              │
└────────────────────────┬────────────────────────────────────────┘
                         │  MCP (stdio ou HTTP)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       BHGBrain Server                           │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Write       │  │ Search       │  │ Resource Handler     │   │
│  │ Pipeline    │  │ Service      │  │ (memory:// URIs)     │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────────┘   │
│         │                │                                       │
│  ┌──────▼────────────────▼──────────────────────────────────┐   │
│  │                  Storage Manager                          │   │
│  │  ┌─────────────────────┐  ┌───────────────────────────┐  │   │
│  │  │  SQLite (sql.js)    │  │  Qdrant (vector store)    │  │   │
│  │  │  ─ metadata         │  │  ─ embeddings (1536d)     │  │   │
│  │  │  ─ fulltext (FTS)   │  │  ─ cosine similarity      │  │   │
│  │  │  ─ categories       │  │  ─ payload indexes        │  │   │
│  │  │  ─ audit log        │  │  ─ per-collection NS      │  │   │
│  │  │  ─ revisions        │  └───────────────────────────┘  │   │
│  │  │  ─ archive          │                                  │   │
│  │  └─────────────────────┘                                  │   │
│  └────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

- **SQLite** (via `sql.js`, en mémoire avec vidange atomique périodique sur disque) est la **source de référence** pour toutes les métadonnées de mémoire, l'index de recherche plein texte, les catégories, la piste d'audit, l'historique des révisions et les enregistrements d'archive.
- **Qdrant** stocke les embeddings vectoriels sémantiques pour la recherche par similarité. Qdrant est toujours écrit après la réussite de SQLite ; les échecs sont suivis via l'indicateur `vector_synced` et exposés dans le point de terminaison de santé.
- **OpenAI text-embedding-3-small** (par défaut, configurable) génère des embeddings en 1536 dimensions pour chaque souvenir.
- **Les écritures atomiques** garantissent que les fichiers de base de données ne sont jamais partiellement écrits — toutes les E/S disque utilisent le mécanisme d'écriture-vers-temp-puis-renommage.
- **La vidange différée** regroupe les mises à jour des métadonnées d'accès (jusqu'à 5 secondes) pour éviter des vidanges de base de données par requête sur les chemins à lecture intensive.

---

## Prérequis

| Prérequis | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.0.0 | LTS recommandé |
| Qdrant | ≥ 1.9 | Doit être en cours d'exécution avant de démarrer BHGBrain |
| Clé API OpenAI | — | Pour les embeddings (`text-embedding-3-small` par défaut). Le serveur démarre en mode dégradé en cas d'absence. |

---

## Configuration de Qdrant

BHGBrain **nécessite une instance Qdrant externe**. Même en mode `embedded` par défaut, le serveur se connecte à `http://localhost:6333` — il n'y a pas de binaire Qdrant intégré. Vous devez le faire fonctionner vous-même.

### Option A : Docker (recommandé)

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

Vérifiez qu'il fonctionne :

```bash
curl http://localhost:6333/health
# → {"title":"qdrant - vector search engine","version":"..."}
```

### Option B : Docker Compose

```yaml
services:
  qdrant:
    image: qdrant/qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"
    volumes:
      - qdrant_storage:/qdrant/storage

volumes:
  qdrant_storage:
```

### Option C : Binaire natif

Téléchargez depuis [https://github.com/qdrant/qdrant/releases](https://github.com/qdrant/qdrant/releases) et exécutez :

```bash
./qdrant
```

### Option D : Qdrant Cloud (mode externe)

Définissez `qdrant.mode` sur `external` dans votre configuration et pointez `external_url` vers l'URL de votre cluster cloud. Définissez `qdrant.api_key_env` sur le nom de la variable d'environnement contenant votre clé API Qdrant.

```jsonc
{
  "qdrant": {
    "mode": "external",
    "external_url": "https://your-cluster.cloud.qdrant.io",
    "api_key_env": "QDRANT_API_KEY"
  }
}
```

---

## Installation

```bash
git clone https://github.com/Big-Hat-Group-Inc/BHGBrain.git
cd BHGBrain
npm install
npm run build
```

Pour l'installer globalement en tant que CLI :

```bash
npm install -g .
bhgbrain --help
```

---

## Configuration

BHGBrain charge sa configuration depuis :

- **Windows :** `%LOCALAPPDATA%\BHGBrain\config.json`
- **Linux/macOS :** `~/.bhgbrain/config.json`

Le fichier est créé automatiquement au premier démarrage avec toutes les valeurs par défaut appliquées. Modifiez-le pour personnaliser le comportement. Vous pouvez également passer un chemin de configuration personnalisé avec `--config=<chemin>` au démarrage du serveur.

### Référence complète de la configuration

```jsonc
{
  // Répertoire de données (chemin absolu). Par défaut, l'emplacement adapté à la plateforme.
  "data_dir": null,

  // Configuration du fournisseur d'embeddings
  "embedding": {
    // Seul "openai" est pris en charge actuellement
    "provider": "openai",
    // Modèle OpenAI à utiliser pour les embeddings
    "model": "text-embedding-3-small",
    // Nom de la variable d'environnement contenant la clé API OpenAI
    "api_key_env": "OPENAI_API_KEY",
    // Dimensions vectorielles produites par le modèle. Doit correspondre à la sortie du modèle.
    // IMPORTANT : Modifier cette valeur après la création de collections nécessite de les recréer.
    "dimensions": 1536
  },

  // Configuration de connexion Qdrant
  "qdrant": {
    // "embedded" = connexion à localhost:6333
    // "external" = connexion à external_url (Qdrant Cloud, instance distante, etc.)
    "mode": "embedded",
    // Utilisé uniquement en mode embedded (actuellement inutilisé — Qdrant doit être démarré en externe)
    "embedded_path": "./qdrant",
    // URL Qdrant externe (utilisée quand mode = "external")
    "external_url": null,
    // Nom de la variable d'env contenant la clé API Qdrant (utilisée quand mode = "external")
    "api_key_env": null
  },

  // Configuration du transport
  "transport": {
    "http": {
      // Activer le transport HTTP
      "enabled": true,
      // Hôte d'écoute. Utilisez 127.0.0.1 pour loopback uniquement (par défaut, sécurisé).
      // Non-loopback nécessite que BHGBRAIN_TOKEN soit défini (ou allow_unauthenticated_http).
      "host": "127.0.0.1",
      // Port d'écoute
      "port": 3721,
      // Nom de la variable d'env contenant le token Bearer pour l'auth HTTP
      "bearer_token_env": "BHGBRAIN_TOKEN"
    },
    "stdio": {
      // Activer le transport MCP stdio
      "enabled": true
    }
  },

  // Valeurs par défaut appliquées lorsqu'elles ne sont pas spécifiées par les appelants
  "defaults": {
    // Espace de noms par défaut pour toutes les opérations
    "namespace": "global",
    // Collection par défaut pour toutes les opérations
    "collection": "general",
    // Limite de résultats par défaut pour les opérations de rappel
    "recall_limit": 5,
    // Score de similarité sémantique minimal par défaut (0-1) pour le rappel
    "min_score": 0.6,
    // Nombre maximum de souvenirs inclus dans la charge utile d'injection automatique
    "auto_inject_limit": 10,
    // Nombre maximum de caractères dans les charges utiles de réponse des outils
    "max_response_chars": 50000
  },

  // Paramètres de rétention et du cycle de vie de la mémoire
  "retention": {
    // Jours sans accès après lesquels un souvenir devient candidat à la péremption
    "decay_after_days": 180,
    // Taille maximale de la base de données SQLite en gigaoctets avant que la santé signale un état dégradé
    "max_db_size_gb": 2,
    // Nombre maximum total de souvenirs avant que la santé signale une surcapacité
    "max_memories": 500000,
    // Pourcentage de max_memories à partir duquel la santé signale un état dégradé
    "warn_at_percent": 80,

    // TTL par niveau en jours (null = n'expire jamais)
    "tier_ttl": {
      "T0": null,    // Fondamental : n'expire jamais
      "T1": 365,     // Institutionnel : 1 an sans accès
      "T2": 90,      // Opérationnel : 90 jours sans accès
      "T3": 30       // Transitoire : 30 jours sans accès
    },

    // Budgets de capacité par niveau (null = illimité)
    "tier_budgets": {
      "T0": null,      // Pas de limite pour les connaissances fondamentales
      "T1": 100000,    // 100 000 souvenirs institutionnels
      "T2": 200000,    // 200 000 souvenirs opérationnels
      "T3": 200000     // 200 000 souvenirs transitoires
    },

    // Seuil de comptage d'accès pour la promotion automatique d'un souvenir d'un niveau
    "auto_promote_access_threshold": 5,

    // Quand true, chaque accès réinitialise l'horloge TTL (fenêtre glissante)
    "sliding_window_enabled": true,

    // Quand true, les souvenirs expirés sont écrits dans la table d'archive avant suppression
    "archive_before_delete": true,

    // Planification cron pour la tâche de nettoyage en arrière-plan (par défaut : 2h du matin quotidiennement)
    "cleanup_schedule": "0 2 * * *",

    // Jours avant expiration à partir desquels les souvenirs sont signalés comme expiring_soon
    "pre_expiry_warning_days": 7,

    // Seuil de compaction de segment Qdrant (compacter quand cette fraction d'un segment est supprimée)
    "compaction_deleted_threshold": 0.10
  },

  // Paramètres de déduplication
  "deduplication": {
    // Activer la déduplication sémantique à l'écriture
    "enabled": true,
    // Seuil de similarité cosinus au-delà duquel le nouveau contenu est considéré comme une MISE À JOUR du contenu existant.
    // Des ajustements spécifiques au niveau sont appliqués en supplément (voir section Déduplication ci-dessous).
    "similarity_threshold": 0.92
  },

  // Configuration de la recherche
  "search": {
    // Poids utilisés pour la Reciprocal Rank Fusion (RRF) en mode hybride
    // Doit totaliser 1.0
    "hybrid_weights": {
      "semantic": 0.7,
      "fulltext": 0.3
    }
  },

  // Paramètres de sécurité
  "security": {
    // Rejeter les liaisons HTTP non-loopback par défaut (sécurisé en cas d'échec)
    "require_loopback_http": true,
    // Autoriser explicitement l'accès HTTP externe non authentifié (journalise un avertissement très visible)
    "allow_unauthenticated_http": false,
    // Masquer les valeurs de token dans les journaux structurés
    "log_redaction": true,
    // Nombre maximum de requêtes par minute par IP client pour le transport HTTP
    "rate_limit_rpm": 100,
    // Taille maximale du corps de requête HTTP en octets
    "max_request_size_bytes": 1048576
  },

  // Budget de charge utile d'injection automatique (pour la ressource memory://inject)
  "auto_inject": {
    // Nombre maximum de caractères inclus dans la charge utile d'injection
    "max_chars": 30000,
    // Budget de tokens (null = illimité, le budget en caractères s'applique)
    "max_tokens": null
  },

  // Paramètres d'observabilité
  "observability": {
    // Activer la collecte de métriques en cours de processus
    "metrics_enabled": false,
    // Utiliser la journalisation JSON structurée (via pino)
    "structured_logging": true,
    // Niveau de journalisation : "debug" | "info" | "warn" | "error"
    "log_level": "info"
  },

  // Paramètres du pipeline d'ingestion
  "pipeline": {
    // Activer le passage d'extraction (exécute actuellement une extraction déterministe à candidat unique)
    "extraction_enabled": true,
    // Modèle utilisé pour l'extraction basée sur LLM (prévu pour un usage futur)
    "extraction_model": "gpt-4o-mini",
    // Nom de la variable d'env pour la clé API du modèle d'extraction
    "extraction_model_env": "BHGBRAIN_EXTRACTION_API_KEY",
    // Quand true, se rabat sur la déduplication par somme de contrôle uniquement si l'embedding est indisponible
    "fallback_to_threshold_dedup": true
  },

  // Résumer automatiquement le contenu des souvenirs lors de l'ingestion
  "auto_summarize": true
}
```

---

## Variables d'environnement

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Oui (pour les embeddings) | — | Clé API OpenAI. Le serveur démarre en **mode dégradé** si elle est absente — la recherche sémantique et l'ingestion échoueront, mais la recherche plein texte et les lectures de catégories fonctionneront encore. |
| `BHGBRAIN_TOKEN` | Obligatoire pour HTTP non-loopback | — | Token Bearer pour l'authentification HTTP. Le serveur **refuse de démarrer** si l'hôte est non-loopback et que ce token n'est pas défini (sauf si `allow_unauthenticated_http: true`). |
| `QDRANT_API_KEY` | Obligatoire pour Qdrant Cloud | — | Définissez `qdrant.api_key_env` dans la configuration sur le nom de cette variable. Le nom de champ de configuration par défaut est `QDRANT_API_KEY`. |
| `BHGBRAIN_EXTRACTION_API_KEY` | Non | Se rabat sur `OPENAI_API_KEY` | Clé API pour le modèle d'extraction LLM (usage futur). |

Générez un token Bearer sécurisé :

```bash
bhgbrain server token
# ou sans le CLI :
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Démarrage du serveur

### Mode stdio (MCP via stdin/stdout)

C'est le mode par défaut utilisé par les clients MCP tels que Claude Desktop. L'indicateur `--stdio` demande explicitement le transport stdio.

```bash
# Développement (aucune compilation requise)
npm run dev

# Production via CLI
node dist/index.js --stdio

# Avec un fichier de configuration personnalisé
node dist/index.js --stdio --config=/chemin/vers/config.json
```

### Mode HTTP

HTTP est activé par défaut sur `127.0.0.1:3721`. Définissez `BHGBRAIN_TOKEN` avant de démarrer si vous souhaitez un accès authentifié :

```bash
export OPENAI_API_KEY=sk-...
export BHGBRAIN_TOKEN=<votre-token>
node dist/index.js
```

Le serveur écoute par défaut sur `http://127.0.0.1:3721`. Points de terminaison HTTP disponibles :

| Point de terminaison | Auth requise | Description |
|---|---|---|
| `GET /health` | Non | Vérification de santé (non authentifiée pour la compatibilité des sondes) |
| `POST /tool/:name` | Oui | Invoquer un outil MCP nommé |
| `GET /resource?uri=...` | Oui | Lire une ressource MCP par URI |
| `GET /metrics` | Oui | Métriques au format Prometheus (si `metrics_enabled: true`) |

Exemple de vérification de santé :

```bash
curl http://127.0.0.1:3721/health
```

Exemple d'appel d'outil via HTTP :

```bash
curl -X POST http://127.0.0.1:3721/tool/remember \
  -H "Authorization: Bearer <votre-token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Our auth service uses JWT with 1h expiry", "type": "semantic", "tags": ["auth", "architecture"]}'
```

---

## Configuration du client MCP

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "bhgbrain": {
      "command": "node",
      "args": ["C:/path/to/BHGBrain/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Claude Desktop (CLI installé globalement)

```json
{
  "mcpServers": {
    "bhgbrain": {
      "command": "bhgbrain",
      "args": ["server", "start"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### OpenClaw / mcporter (transport HTTP)

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "http",
      "url": "http://127.0.0.1:3721",
      "headers": {
        "Authorization": "Bearer <votre-token>"
      }
    }
  }
}
```

Ou en utilisant la recherche de variable d'environnement si votre mcporter le prend en charge :

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "stdio",
      "command": "node",
      "args": ["C:/Temp/GitHub/BHGBrain/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "QDRANT_API_KEY": "..."
      }
    }
  }
}
```

---

## Gestion de la mémoire

Cette section décrit le cycle de vie complet de la mémoire — de l'ingestion à la classification, en passant par la déduplication, le suivi des accès, la promotion, le déclin et l'expiration finale ou la rétention permanente.

### Modèle de données

Chaque souvenir stocké dans BHGBrain est un `MemoryRecord` avec les champs suivants :

| Champ | Type | Description |
|---|---|---|
| `id` | `string (UUID)` | Identifiant unique mondial |
| `namespace` | `string` | Espace de noms de portée (ex. `"global"`, `"project/alpha"`, `"user/kevin"`) |
| `collection` | `string` | Sous-groupe au sein d'un espace de noms (ex. `"general"`, `"architecture"`, `"decisions"`) |
| `type` | `"episodic" \| "semantic" \| "procedural"` | Type de mémoire (voir Types de mémoire) |
| `category` | `string \| null` | Nom de catégorie si ce souvenir est rattaché à une catégorie de politique persistante |
| `content` | `string` | Contenu complet du souvenir (jusqu'à 100 000 caractères) |
| `summary` | `string` | Résumé auto-généré de la première ligne (jusqu'à 120 caractères) |
| `tags` | `string[]` | Tags libres (alphanumériques + tirets, max 20 tags, max 100 caractères chacun) |
| `source` | `"cli" \| "api" \| "agent" \| "import"` | Comment le souvenir a été créé |
| `checksum` | `string` | Hachage SHA-256 du contenu normalisé (utilisé pour la déduplication exacte) |
| `embedding` | `number[]` | Embedding vectoriel (non stocké dans SQLite ; réside dans Qdrant) |
| `importance` | `number (0–1)` | Score d'importance (par défaut 0,5) |
| `retention_tier` | `"T0" \| "T1" \| "T2" \| "T3"` | Niveau de cycle de vie régissant le TTL et le comportement de nettoyage |
| `expires_at` | `string (ISO 8601) \| null` | Horodatage d'expiration (null pour T0 — n'expire jamais) |
| `decay_eligible` | `boolean` | Si le souvenir participe au nettoyage TTL (false pour T0) |
| `review_due` | `string (ISO 8601) \| null` | Date de révision T1 (définie à created_at + 365 jours ; réinitialisée à l'accès) |
| `access_count` | `number` | Nombre de fois que ce souvenir a été récupéré |
| `last_accessed` | `string (ISO 8601)` | Horodatage de la dernière récupération |
| `last_operation` | `"ADD" \| "UPDATE" \| "DELETE" \| "NOOP"` | Opération d'écriture la plus récente appliquée |
| `merged_from` | `string \| null` | ID du souvenir dont celui-ci a été fusionné (chemin UPDATE de déduplication) |
| `archived` | `boolean` | Si ce souvenir est archivé de façon logicielle (exclu de la recherche/du rappel) |
| `vector_synced` | `boolean` | Si le vecteur Qdrant est synchronisé avec l'état SQLite |
| `created_at` | `string (ISO 8601)` | Horodatage de création |
| `updated_at` | `string (ISO 8601)` | Horodatage de la dernière mise à jour |
| `last_accessed` | `string (ISO 8601)` | Horodatage du dernier accès |

#### Schéma SQLite

La table `memories` dispose d'index complets pour un filtrage efficace :

```sql
CREATE INDEX idx_memories_namespace   ON memories(namespace);
CREATE INDEX idx_memories_collection  ON memories(namespace, collection);
CREATE INDEX idx_memories_checksum    ON memories(namespace, checksum);
CREATE INDEX idx_memories_type        ON memories(namespace, type);
CREATE INDEX idx_memories_category    ON memories(category);
CREATE INDEX idx_memories_tier        ON memories(namespace, collection, retention_tier);
CREATE INDEX idx_memories_expiry      ON memories(decay_eligible, expires_at);
CREATE INDEX idx_memories_review_due  ON memories(retention_tier, review_due);
CREATE INDEX idx_memories_archived    ON memories(archived);
CREATE INDEX idx_memories_vector_sync ON memories(vector_synced);
```

#### Index de charge utile Qdrant

Chaque collection Qdrant maintient les index de charge utile suivants pour un filtrage efficace côté vecteur :

- `namespace` (keyword)
- `type` (keyword)
- `retention_tier` (keyword)
- `decay_eligible` (boolean)
- `expires_at` (integer — stocké en secondes epoch Unix)

---

### Types de mémoire

Chaque souvenir est classifié dans l'un des trois types sémantiques. Le type est utilisé pour le filtrage dans les opérations de rappel et de recherche, et il influence le niveau de rétention par défaut attribué lors de l'ingestion.

| Type | Signification | Contenu typique | Niveau par défaut |
|---|---|---|---|
| `episodic` | Un événement, une observation ou une occurrence spécifique à un moment précis | Résultats de réunions, sessions de débogage, contexte de tâche, ce qui s'est passé durant un sprint | `T2` (opérationnel) |
| `semantic` | Un fait, un concept ou une information non liés à un moment précis | Comment un système fonctionne, la signification d'un terme, une valeur de configuration, un modèle de données | `T2` (opérationnel) |
| `procedural` | Un processus, un flux de travail ou des instructions de réalisation | Runbooks, étapes de déploiement, normes de codage, comment effectuer une tâche | `T1` (institutionnel) |

**Influence du type sur l'attribution du niveau :**
- `source: agent` + `type: procedural` → attribué automatiquement `T1` (institutionnel)
- `source: agent` + `type: episodic` → attribué automatiquement `T2` (opérationnel)
- `source: cli` (n'importe quel type) → attribué automatiquement `T2` (opérationnel)
- `source: import` avec signaux de contenu T0 → `T0` indépendamment du type

Si vous ne fournissez pas de type, le pipeline prend `"semantic"` par défaut.

---

### Espaces de noms et collections

**Les espaces de noms** sont des identificateurs de portée de premier niveau qui isolent les souvenirs de différents contextes, utilisateurs ou projets. Toutes les opérations d'outils nécessitent un espace de noms (par défaut : `"global"`).

- Modèle d'espace de noms : `^[a-zA-Z0-9/-]{1,200}$` — caractères alphanumériques, tirets et barres obliques
- Exemples : `"global"`, `"project/alpha"`, `"user/kevin"`, `"tenant/acme-corp"`
- Les souvenirs dans différents espaces de noms ne sont jamais renvoyés dans les recherches des uns et des autres
- Chaque paire espace de noms+collection correspond à une collection Qdrant distincte (nommée `bhgbrain_{namespace}_{collection}`)

**Les collections** sont des sous-groupes au sein d'un espace de noms. Elles permettent de partitionner les souvenirs par sujet ou par objectif sans créer des espaces de noms entièrement séparés.

- Modèle de collection : `^[a-zA-Z0-9-]{1,100}$`
- Exemples : `"general"`, `"architecture"`, `"decisions"`, `"onboarding"`
- Les collections sont suivies dans la table SQLite `collections` avec leur modèle d'embedding et leurs dimensions verrouillés au moment de la création — vous ne pouvez pas mélanger des modèles d'embedding au sein d'une collection
- Utilisez l'outil MCP `collections` pour lister, créer ou supprimer des collections

**Garanties d'isolation :**
- Les requêtes SQLite filtrent toujours d'abord par `namespace`
- Les recherches Qdrant incluent un filtre de charge utile `namespace` même lors de la recherche dans une collection spécifique
- La suppression d'une collection supprime tous les souvenirs associés de SQLite et de Qdrant

---

### Niveaux de rétention

Chaque souvenir se voit attribuer un **niveau de rétention** lors de l'ingestion qui régit l'intégralité de son cycle de vie — sa durée de vie, son mode de nettoyage, la rigueur de sa déduplication et s'il expire un jour.

| Niveau | Libellé | TTL par défaut | Éligible au déclin | Exemples |
|---|---|---|---|---|
| `T0` | **Fondamental** | Jamais (permanent) | Non | Références d'architecture, exigences légales, politiques d'entreprise, mandats de conformité, normes comptables, ADRs, runbooks de sécurité |
| `T1` | **Institutionnel** | 365 jours depuis le dernier accès | Oui (avec suivi review_due) | Décisions de conception logicielle, contrats API, runbooks de déploiement, normes de codage, accords fournisseurs, connaissances procédurales |
| `T2` | **Opérationnel** | 90 jours depuis le dernier accès | Oui | État du projet, décisions de sprint, résultats de réunions, investigations techniques, contexte de tâche actuel |
| `T3` | **Transitoire** | 30 jours depuis le dernier accès | Oui | Tickets d'incidents, résumés d'e-mails, rapports quotidiens, sessions de débogage ad hoc, notes de tâches éphémères |

**Propriétés clés par niveau :**

- **T0** : `expires_at` est toujours `null`. `decay_eligible` est toujours `false`. Les souvenirs T0 ne peuvent pas être nettoyés automatiquement. Les mises à jour des souvenirs T0 déclenchent un instantané de révision dans la table `memory_revisions` (historique en ajout seul). Les souvenirs T0 reçoivent un boost de score de +0,1 dans les résultats de recherche hybride.

- **T1** : `review_due` est défini à `created_at + 365 jours` et réinitialisé à chaque accès. Les souvenirs approchant leur `expires_at` sont signalés avec `expiring_soon: true` dans les résultats de recherche.

- **T2** : Le niveau par défaut pour la plupart des souvenirs. Fenêtre glissante de 90 jours — chaque accès réinitialise l'horloge TTL.

- **T3** : Le niveau le plus agressif. Le contenu transitoire correspondant à des modèles (tickets, e-mails, notes de standup) est automatiquement classifié ici. Fenêtre glissante de 30 jours.

**Budgets de capacité :**

| Niveau | Budget par défaut | Notes |
|---|---|---|
| T0 | Illimité | Les connaissances fondamentales doivent toujours tenir |
| T1 | 100 000 | Connaissances institutionnelles |
| T2 | 200 000 | Souvenirs opérationnels |
| T3 | 200 000 | Souvenirs transitoires |

Lorsqu'un budget de niveau est dépassé, le point de terminaison de santé signale `degraded` et la tâche de nettoyage priorise ce niveau lors du prochain cycle.

---

### Cycle de vie des niveaux — Attribution, Promotion, Fenêtre glissante

#### Attribution du niveau

L'attribution du niveau se produit durant le pipeline d'écriture, dans cet ordre de priorité :

1. **Remplacement explicite par l'appelant :** Si `retention_tier` est passé à l'outil `remember`, il est utilisé sans condition.

2. **Basé sur la catégorie :** Si le souvenir est rattaché à une catégorie (via le champ `category`), il est toujours `T0`. Les catégories représentent des emplacements de politique persistants et n'expirent jamais.

3. **Heuristiques source + type :**
   - `source: agent` + `type: procedural` → `T1`
   - `source: agent` + `type: episodic` → `T2`
   - `source: cli` → `T2`

4. **Correspondance de modèles de contenu pour les signaux transitoires (→ T3) :**
   - Références Jira/ticket : `JIRA-1234`, `incident-456`, `case-789`
   - Métadonnées d'e-mail : `From:`, `Subject:`, `fw:`, `re:`
   - Marqueurs temporels : `today`, `this week`, `by friday`, `standup`, `meeting minutes`, `action items`
   - Références de trimestre : `Q1 2026`, `Q3 2025`

5. **Signaux de mots-clés T0 (→ T0 pour les imports) :**
   Si `source: import` et que le contenu ou les tags contiennent l'un des éléments suivants :
   `architecture`, `design decision`, `adr`, `rfc`, `contract`, `schema`, `legal`, `compliance`, `policy`, `standard`, `accounting`, `security`, `runbook`
   → attribué `T0`.

6. **Signaux de mots-clés T0 (→ T0 pour toute source) :**
   Les mêmes mots-clés T0 sont vérifiés pour toutes les sources (les modèles transitoires T3 sont vérifiés en premier). Si un mot-clé T0 correspond sans modèle transitoire, le souvenir est `T0`.

7. **Par défaut :** `T2` — le défaut sûr et tolérant.

#### Métadonnées de niveau calculées lors de l'attribution

```typescript
{
  retention_tier: "T2",               // niveau attribué
  expires_at: "2026-06-14T12:00:00Z", // created_at + jours TTL
  decay_eligible: true,               // false uniquement pour T0
  review_due: null                    // défini pour T1 uniquement
}
```

Pour les souvenirs T1, `review_due` est défini à `created_at + tier_ttl.T1` (par défaut 365 jours) et est réinitialisé à chaque récupération.

#### Promotion automatique à l'accès

Lorsqu'un souvenir de niveau `T2` ou `T3` atteint le seuil d'accès (`auto_promote_access_threshold`, par défaut 5), il est automatiquement promu d'un niveau :

- `T3` → `T2`
- `T2` → `T1`

La promotion ne peut pas se produire automatiquement vers `T0`. La mise à niveau manuelle vers `T0` est possible en passant `retention_tier: "T0"` lors d'un appel `remember` ultérieur (ce qui déclenche le chemin UPDATE) ou via la CLI `bhgbrain tier set <id> T0`.

La promotion est **monotone** — la rétrogradation automatique ne se produit jamais. La rétrogradation de niveau nécessite une action explicite de l'utilisateur.

Lorsqu'un souvenir est promu, son `expires_at` est recalculé à partir du TTL du nouveau niveau en utilisant l'horodatage actuel comme ancre de la fenêtre glissante.

#### Expiration par fenêtre glissante

Lorsque `sliding_window_enabled: true` (par défaut), chaque récupération réussie via `recall`, `search` ou `memory://inject` réinitialise l'horloge TTL :

```
nouveau expires_at = max(expires_at actuel, maintenant + tier_ttl)
```

Cela signifie qu'un souvenir activement utilisé n'expire jamais, tandis qu'un souvenir jamais récupéré atteint son TTL et est nettoyé. Les souvenirs auxquels on accède une seule fois à la dernière minute obtiennent une nouvelle fenêtre TTL complète à partir de cet accès.

Le suivi des accès est effectué par lot après chaque recherche (vidange différée jusqu'à 5 secondes) pour éviter des écritures synchrones en base de données sur le chemin de lecture.

---

### Déduplication

BHGBrain empêche le stockage de contenu en double ou quasi-double grâce à un pipeline de déduplication en deux phases.

#### Phase 1 : Déduplication exacte (somme de contrôle)

Avant la génération d'un embedding, le contenu normalisé est haché avec SHA-256. Si un souvenir avec le même espace de noms et la même somme de contrôle existe déjà (et n'est pas archivé), l'opération renvoie `NOOP` immédiatement sans aucun appel API.

```
checksum = SHA-256(normalizeContent(content))
```

#### Phase 2 : Déduplication sémantique (similarité vectorielle)

Si aucune correspondance exacte n'est trouvée, le contenu est intégré et les 10 souvenirs existants les plus similaires dans la collection sont récupérés depuis Qdrant. En fonction des scores de similarité cosinus et du niveau attribué au souvenir, l'une des trois décisions est prise :

| Décision | Condition | Effet |
|---|---|---|
| `NOOP` | Score ≥ seuil noop | Le contenu est considéré comme un doublon ; renvoyer l'ID du souvenir existant sans écriture |
| `UPDATE` | Score ≥ seuil update | Le contenu est une mise à jour de l'existant ; fusionner les tags, mettre à jour le contenu et la somme de contrôle, conserver l'ID |
| `ADD` | Score < seuil update | Souvenir véritablement nouveau ; créer avec un nouvel UUID |

**Seuils de déduplication spécifiques au niveau :**

Le `similarity_threshold` de base (par défaut 0,92) est ajusté par niveau car les souvenirs T0/T1 nécessitent une correspondance plus stricte (les quasi-doublons peuvent représenter une gestion de version intentionnelle), et T3 est plus agressif :

| Niveau | Seuil NOOP | Seuil UPDATE |
|---|---|---|
| `T0` | 0,98 | max(base, 0,95) |
| `T1` | 0,98 | max(base, 0,95) |
| `T2` | 0,98 | base (0,92) |
| `T3` | 0,95 | max(base, 0,90) |

**Comportement de fusion UPDATE :**
- Les tags sont réunis (tags existants ∪ nouveaux tags)
- Le contenu est remplacé par la nouvelle version
- L'importance est définie à `max(importance existante, nouvelle importance)`
- Le niveau de rétention et l'expiration sont recalculés à partir de la classification du nouveau contenu

**Comportement de repli :**
Si le fournisseur d'embedding est indisponible et que `pipeline.fallback_to_threshold_dedup: true`, le pipeline se rabat sur la déduplication par somme de contrôle uniquement et écrit le souvenir dans SQLite uniquement (avec `vector_synced: false`). Le souvenir sera disponible pour la recherche plein texte mais pas pour la recherche sémantique jusqu'à ce que la synchronisation Qdrant soit rétablie.

---

### Normalisation du contenu

Avant la vérification de somme de contrôle, l'embedding ou le stockage, tout le contenu passe par le pipeline de normalisation :

1. **Suppression des caractères de contrôle :** Les caractères de contrôle ASCII (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F) sont supprimés. Le saut de ligne (0x0A) et le retour chariot (0x0D) sont conservés.

2. **Normalisation CRLF :** `\r\n` → `\n`

3. **Suppression des espaces de fin de ligne :** Les espaces et tabulations en fin de lignes sont supprimés.

4. **Réduction des lignes vides excessives :** Trois ou plusieurs sauts de ligne consécutifs sont réduits à deux.

5. **Suppression des espaces de début et de fin :** La chaîne entière est rognée.

6. **Détection de secrets :** Avant le stockage, le contenu est vérifié par rapport à des modèles de formats d'identifiants courants :
   - `api_key=...`, `secret=...`, `token=...`, `password=...`
   - Identifiants d'accès AWS (`AKIA...`)
   - Tokens d'accès personnels GitHub (`ghp_...`)
   - Clés API OpenAI (`sk-...`)
   - Clés privées PEM (`-----BEGIN ... PRIVATE KEY-----`)

   Si un secret est détecté, l'écriture est **rejetée** avec `INVALID_INPUT` :
   > `Content appears to contain credentials or secrets. Memory rejected for safety.`

7. **Génération de résumé :** La première ligne du contenu normalisé est extraite comme résumé (tronquée à 120 caractères avec `...` si plus longue). Le résumé est stocké dans SQLite et utilisé pour l'affichage léger sans récupération du contenu complet.

---

### Score d'importance

Chaque souvenir possède un champ `importance` — un flottant de 0,0 à 1,0.

**Par défaut :** `0,5` si non fourni par l'appelant.

**Comment il est utilisé :**
- Lors des fusions UPDATE de déduplication, l'importance est définie à `max(existante, nouvelle)` — l'importance ne fait qu'augmenter par les fusions.
- Les candidats à la péremption (signalés par le passage de consolidation) doivent avoir `importance < 0,5` et aucune catégorie pour être éligibles au marquage de péremption. Cela protège les souvenirs à haute importance d'être marqués comme périmés.
- L'extraction future basée sur LLM pourrait attribuer une importance en fonction de l'analyse du contenu.

**Définir l'importance :**
Passez `importance` explicitement dans l'outil `remember`. Les valeurs vont de `0,0` (valeur très faible, devrait décroître de manière agressive) à `1,0` (critique, devrait être préservé).

```json
{
  "content": "Our HIPAA BAA requires all PHI to be encrypted at rest using AES-256",
  "type": "semantic",
  "tags": ["compliance", "hipaa", "security"],
  "importance": 0.9,
  "retention_tier": "T0"
}
```

---

### Catégories — Emplacements de politique persistants

Les catégories sont un mécanisme de stockage spécial pour le contexte de politique persistant, toujours injecté. Contrairement aux souvenirs ordinaires (récupérés par recherche sémantique), le contenu des catégories est toujours inclus dans la charge utile de la ressource `memory://inject`.

Les catégories sont conçues pour les informations qui doivent toujours être présentes dans la fenêtre de contexte de l'IA : valeurs de l'entreprise, principes d'architecture, normes de codage et politiques permanentes similaires.

#### Emplacements de catégorie

Chaque catégorie est assignée à l'un des quatre emplacements nommés :

| Emplacement | Objectif | Exemples |
|---|---|---|
| `company-values` | Principes fondamentaux, culture, voix de la marque | « Nous priorisons la sécurité sur la vitesse », « Ne jamais stocker de données personnelles dans les logs » |
| `architecture` | Architecture système, topologie des composants, décisions de conception clés | Carte des services, contrats API, choix technologiques |
| `coding-requirements` | Normes de codage, conventions, modèles requis | « Toujours utiliser async/await », « Utiliser Zod pour toute validation », conventions de nommage |
| `custom` | Tout autre élément justifiant un contexte toujours actif | Règles spécifiques au projet, guides de désambiguïsation, cartes d'entités |

#### Comportement des catégories

- Les catégories sont **toujours T0** — elles n'expirent jamais, ne déclinent jamais et ne peuvent pas être nettoyées par le système de rétention.
- Le contenu des catégories est stocké en texte intégral dans SQLite (non intégré dans Qdrant).
- Dans la charge utile `memory://inject`, le contenu des catégories est ajouté en préfixe avant tous les souvenirs ordinaires.
- Les catégories prennent en charge les révisions — lorsque vous mettez à jour une catégorie avec `category set`, le compteur `revision` s'incrémente.
- Les noms de catégories doivent être uniques. Vous pouvez avoir plusieurs catégories par emplacement (ex. `"api-contracts"` et `"database-schema"` toutes deux dans l'emplacement `"architecture"`).
- Le contenu des catégories peut comporter jusqu'à 100 000 caractères.

#### Gestion des catégories

```json
// Lister toutes les catégories
{ "action": "list" }

// Obtenir une catégorie spécifique
{ "action": "get", "name": "api-contracts" }

// Créer ou mettre à jour une catégorie
{
  "action": "set",
  "name": "coding-standards",
  "slot": "coding-requirements",
  "content": "## Coding Standards\n\n- Use TypeScript strict mode\n- All functions must have JSDoc comments\n- Tests required for all public APIs"
}

// Supprimer une catégorie
{ "action": "delete", "name": "coding-standards" }
```

---

### Déclin, nettoyage et archivage

#### Nettoyage en arrière-plan

Le système de rétention exécute une tâche de nettoyage planifiée (par défaut : quotidiennement à 2h00, configurable via `retention.cleanup_schedule` en expression cron). Vous pouvez également déclencher manuellement le nettoyage via `bhgbrain gc`.

**Phases de nettoyage :**

1. **Identifier les souvenirs expirés :** Interroger SQLite pour tous les souvenirs où `decay_eligible = true` ET `expires_at < now()`. Les souvenirs T0 sont toujours exclus (T0 n'est jamais éligible au déclin).

2. **Archiver avant suppression (si activé) :** Pour chaque souvenir expiré, écrire un enregistrement de résumé dans la table `memory_archive` :

   ```sql
   memory_archive {
     id            INTEGER (autoincrement)
     memory_id     TEXT    -- UUID du souvenir d'origine
     summary       TEXT    -- le texte de résumé du souvenir
     tier          TEXT    -- niveau dans lequel il se trouvait lors de la suppression
     namespace     TEXT    -- espace de noms auquel il appartenait
     created_at    TEXT    -- horodatage de création d'origine
     expired_at    TEXT    -- quand le nettoyage a été exécuté
     access_count  INTEGER -- total des accès durant la durée de vie
     tags          TEXT    -- tableau JSON de tags
   }
   ```

3. **Supprimer de Qdrant :** Supprimer en lot tous les IDs de points expirés de leurs collections Qdrant respectives.

4. **Supprimer de SQLite :** Supprimer les lignes expirées des tables `memories` et `memories_fts`.

5. **Journal d'audit :** Chaque suppression est enregistrée dans la table `audit_log` avec `operation: FORGET` et `client_id: "system"`.

6. **Vidange :** SQLite est vidé atomiquement sur disque après toutes les suppressions.

#### Historique des révisions T0

Lorsqu'un souvenir T0 (fondamental) est mis à jour via l'outil `remember` (déclenchant le chemin de déduplication UPDATE), le contenu précédent est instantané dans la table `memory_revisions` avant l'application de la mise à jour :

```sql
memory_revisions {
  id         INTEGER (autoincrement)
  memory_id  TEXT    -- UUID du souvenir T0
  revision   INTEGER -- numéro de révision incrémental
  content    TEXT    -- contenu précédent complet
  updated_at TEXT    -- quand la mise à jour a eu lieu
  updated_by TEXT    -- client_id qui a effectué la mise à jour
}
```

Seuls les souvenirs T0 ont un historique de révisions. L'embedding vectoriel dans Qdrant reflète toujours uniquement le contenu actuel.

#### Marquage de péremption (passage de consolidation)

La commande `bhgbrain gc --consolidate` (ou `RetentionService.runConsolidation()`) effectue un passage secondaire qui marque les souvenirs comme **périmés** candidats :

- Tout souvenir non consulté au cours des derniers `retention.decay_after_days` jours (par défaut 180) est signalé comme candidat à la péremption.
- Seuls les souvenirs avec `importance < 0,5` et aucune catégorie sont éligibles.
- Les souvenirs périmés ne sont pas supprimés immédiatement ; ils deviennent candidats pour le prochain cycle de nettoyage GC.

#### Recherche et restauration dans les archives

Les souvenirs supprimés (lorsque `archive_before_delete: true`) peuvent être inspectés et restaurés :

```bash
bhgbrain archive list                 # Lister les résumés de souvenirs récemment archivés
bhgbrain archive search <query>       # Rechercher dans les archives par texte
bhgbrain archive restore <memory_id>  # Restaurer un souvenir archivé
```

**Sémantique de restauration :** Un souvenir restauré est recréé en tant que **nouveau** souvenir `T2` à partir du texte de résumé archivé. Le contenu original (s'il est plus long que le résumé) ne peut pas être récupéré — l'archive ne stocke que le résumé de 120 caractères. Le souvenir restauré reçoit de nouveaux horodatages et un nouvel UUID, et est ré-intégré dans Qdrant.

---

### Avertissements de pré-expiration

Les souvenirs approchant l'expiration (dans `retention.pre_expiry_warning_days` jours, par défaut 7) sont signalés dans les résultats de recherche :

```json
{
  "id": "...",
  "content": "...",
  "retention_tier": "T2",
  "expires_at": "2026-03-22T12:00:00Z",
  "expiring_soon": true
}
```

L'indicateur `expiring_soon` apparaît dans :
- Les résultats de `recall`
- Les résultats de `search`
- La charge utile de la ressource `memory://inject`

Cela permet aux agents IA de remarquer quand des souvenirs sont sur le point d'expirer et de décider s'il faut les promouvoir (en les re-sauvegardant avec un `retention_tier: "T1"` ou `"T0"` explicite).

---

### Limites de ressources et budgets de capacité

BHGBrain surveille la capacité et expose les avertissements via le système de santé :

| Limite | Clé de configuration | Par défaut | Comportement en cas de dépassement |
|---|---|---|---|
| Nombre total maximum de souvenirs | `retention.max_memories` | 500 000 | La santé signale `degraded` ; la tâche de nettoyage priorise le nettoyage |
| Taille maximale de la base de données | `retention.max_db_size_gb` | 2 Go | La santé signale `degraded` (surveillé, non appliqué) |
| Seuil d'avertissement | `retention.warn_at_percent` | 80 % | La santé signale `degraded` quand `count > max_memories * 0,8` |
| Budget T1 | `retention.tier_budgets.T1` | 100 000 | La santé signale `over_capacity: true` ; le composant de rétention se dégrade |
| Budget T2 | `retention.tier_budgets.T2` | 200 000 | Idem |
| Budget T3 | `retention.tier_budgets.T3` | 200 000 | Idem |

T0 n'a pas de budget de capacité. Les connaissances fondamentales doivent toujours être préservées.

Le champ `retention.over_capacity` du point de terminaison de santé est `true` si un budget configuré est dépassé. L'objet `retention.counts_by_tier` affiche le nombre actuel dans chaque niveau, que vous pouvez comparer à vos budgets configurés.

---

## Recherche

BHGBrain prend en charge trois modes de recherche pouvant être utilisés indépendamment ou combinés.

### Recherche sémantique

La recherche sémantique utilise les embeddings OpenAI et la similarité vectorielle Qdrant (distance cosinus) pour trouver des souvenirs conceptuellement similaires à la requête — même s'ils utilisent des mots différents.

**Comment ça fonctionne :**
1. La chaîne de requête est intégrée en utilisant le même modèle que les souvenirs stockés (`text-embedding-3-small`, 1536 dimensions).
2. Qdrant est interrogé pour les voisins les plus proches dans la collection cible.
3. Qdrant applique des filtres de charge utile pour exclure les souvenirs expirés : seuls les souvenirs où `decay_eligible = false` (T0/T1) OU `expires_at > maintenant()` sont renvoyés.
4. Les résultats sont classés par score de similarité cosinus (0,0–1,0, plus élevé signifie plus similaire).
5. Les métadonnées d'accès sont mises à jour pour chaque souvenir renvoyé (access_count++, last_accessed, réinitialisation de l'expiration de la fenêtre glissante).

**Quand l'utiliser :** Requêtes conceptuelles, questions sur le fonctionnement d'un système, récupération de décisions d'architecture sans connaître les mots-clés exacts.

**Prérequis :** Nécessite que le fournisseur d'embedding soit sain. Renvoie une erreur `EMBEDDING_UNAVAILABLE` si OpenAI est injoignable.

```json
// Recherche sémantique via l'outil search
{
  "query": "how does authentication work",
  "mode": "semantic",
  "namespace": "global",
  "limit": 10
}
```

---

### Recherche plein texte

La recherche plein texte utilise la correspondance de texte interne de SQLite pour trouver des souvenirs contenant des mots ou des expressions spécifiques.

**Comment ça fonctionne :**
1. La requête est divisée en termes en minuscules.
2. Chaque terme est mis en correspondance avec la table fantôme `memories_fts` en utilisant `LIKE %terme%` sur les colonnes `content`, `summary` et `tags`.
3. Les résultats sont classés par le nombre de termes correspondants (plus de correspondances = rang plus élevé).
4. Le rang est normalisé en score de 0,0 à 1,0 : `min(1,0, nombre_termes / 10)`.
5. Les souvenirs archivés sont exclus (la table FTS est maintenue synchronisée avec la table principale des souvenirs — les lignes archivées sont supprimées de FTS).
6. Les métadonnées d'accès sont mises à jour pour les résultats renvoyés.

**Quand l'utiliser :** Recherches exactes par mots-clés, recherche d'identifiants spécifiques (IDs de souvenirs, noms de projets, noms de systèmes), lorsque vous connaissez la terminologie exacte utilisée.

**Prérequis :** Fonctionne même lorsque le fournisseur d'embedding est indisponible (aucun Qdrant requis pour le plein texte).

```json
// Recherche plein texte via l'outil search
{
  "query": "JIRA-1234 authentication",
  "mode": "fulltext",
  "namespace": "global",
  "limit": 10
}
```

---

### Recherche hybride

La recherche hybride combine les résultats sémantiques et plein texte en utilisant la **Reciprocal Rank Fusion (RRF)**, un algorithme de fusion basé sur le rang robuste aux différences d'échelle de score entre les deux systèmes de récupération.

**Comment ça fonctionne :**
1. La recherche sémantique et la recherche plein texte s'exécutent indépendamment (en parallèle si possible).
2. Chaque méthode récupère jusqu'à `limit * 2` candidats.
3. La fusion RRF combine les listes classées :

   ```
   RRF_score(item) = (poids_sémantique / (K + rang_sémantique))
                   + (poids_plein_texte  / (K + rang_plein_texte))
   ```
   
   Où `K = 60` (constante RRF standard), `poids_sémantique = 0,7`, `poids_plein_texte = 0,3` (configurable via `search.hybrid_weights`).

4. Les éléments n'apparaissant que dans une liste reçoivent une contribution `0` de l'autre.
5. La liste fusionnée est triée par score RRF (décroissant).
6. Les souvenirs T0 reçoivent un **boost de score de +0,1** appliqué après la fusion RRF, garantissant que les connaissances fondamentales émergent de manière proéminente.
7. Les `limit` premiers résultats sont renvoyés.

**Dégradation gracieuse :** Si le fournisseur d'embedding est indisponible, la recherche hybride se rabat silencieusement sur des résultats plein texte uniquement plutôt que de générer une erreur.

**Quand l'utiliser :** Par défaut pour la plupart des requêtes — la recherche hybride offre le meilleur rappel car un souvenir peut être renvoyé par correspondance sémantique même si les mots-clés ne correspondent pas, ou par plein texte même si l'embedding est légèrement décalé.

```json
// Recherche hybride (mode par défaut)
{
  "query": "authentication JWT expiry",
  "mode": "hybrid",
  "namespace": "global",
  "limit": 10
}
```

---

### Recall vs Search — Différences

BHGBrain expose deux outils de récupération de mémoire avec des sémantiques différentes :

| Aspect | `recall` | `search` |
|---|---|---|
| **Objectif principal** | Récupérer les souvenirs les plus pertinents pour le contexte actuel | Explorer et investiguer le magasin de souvenirs |
| **Mode de recherche** | Toujours sémantique (similarité vectorielle) | Configurable : `semantic`, `fulltext` ou `hybrid` (par défaut) |
| **Limite de résultats** | 1–20 (par défaut 5) | 1–50 (par défaut 10) |
| **Filtrage par score** | Filtre `min_score` appliqué (par défaut 0,6) | Aucun filtre de score |
| **Filtrage par type** | Filtre `type` optionnel (`episodic`/`semantic`/`procedural`) | Aucun filtre de type |
| **Filtrage par tags** | Filtre `tags` optionnel (tout tag correspondant) | Aucun filtre de tags |
| **Espace de noms** | Obligatoire (par défaut `global`) | Obligatoire (par défaut `global`) |
| **Collection** | Optionnel — omettre pour rechercher dans toutes les collections | Optionnel |
| **Suivi des accès** | Oui — chaque rappel met à jour access_count et la fenêtre glissante | Oui — même comportement |
| **Appelant prévu** | Agents IA lors de l'exécution de tâches | Humains ou agents administrateurs faisant une investigation |

**Filtrage par score dans recall :**
Le paramètre `min_score` (par défaut 0,6) agit comme un filtre de qualité — seuls les souvenirs avec une similarité cosinus ≥ 0,6 sont renvoyés. Cela évite les résultats non pertinents. Vous pouvez abaisser `min_score` pour récupérer plus de résultats au détriment de la précision.

```json
// Exemple de recall — sémantique, filtré par type et tags
{
  "query": "authentication architecture decisions",
  "namespace": "global",
  "type": "semantic",
  "tags": ["auth", "architecture"],
  "limit": 5,
  "min_score": 0.6
}
```

---

### Filtrage

`recall` et `search` prennent tous deux en charge la portée par espace de noms et collection. `recall` prend en charge en outre le filtrage par type et par tags.

**Filtrage par espace de noms :** Toujours appliqué. Toutes les recherches sont limitées à un seul espace de noms. Il n'y a pas de recherche inter-espaces de noms.

**Filtrage par collection :** Optionnel. Si omis :
- En recherche sémantique, la collection Qdrant `bhgbrain_{namespace}_general` est recherchée (la collection par défaut pour l'espace de noms).
- En recherche plein texte, tous les souvenirs dans l'espace de noms sont recherchés indépendamment de la collection.

**Filtrage par type (`recall` uniquement) :** Passez `"type": "episodic"` | `"semantic"` | `"procedural"` pour restreindre les résultats à un seul type de mémoire. Le filtrage est appliqué après la recherche sémantique, donc l'ensemble complet de candidats est d'abord récupéré depuis Qdrant.

**Filtrage par tags (`recall` uniquement) :** Passez `"tags": ["auth", "security"]` pour restreindre les résultats aux souvenirs ayant au moins l'un des tags spécifiés. Le filtrage est appliqué après la récupération.

---

### Seuils de score et boosts par niveau

**`min_score` (recall uniquement) :** Un score de similarité cosinus minimal entre 0 et 1. Les souvenirs en dessous de ce seuil sont exclus des résultats de `recall`. Par défaut : 0,6.

**Exclusion des souvenirs expirés :** Le filtre de recherche vectorielle de Qdrant exclut les souvenirs où `decay_eligible = true ET expires_at < maintenant()`. Les souvenirs T0/T1 (decay_eligible = false) ne sont jamais exclus par le filtre côté vecteur. Côté SQLite, le service de cycle de vie revérifie l'expiration sur tout souvenir renvoyé par le magasin vectoriel.

**Boost de score T0 (recherche hybride) :** Après la fusion RRF, les souvenirs T0 (fondamentaux) reçoivent un +0,1 supplémentaire ajouté à leur score. Cela garantit que le contenu architecturalement significatif émerge dans les résultats hybrides même si sa terminologie exacte ne correspond pas bien à la requête.

---

## Sauvegarde et restauration

### Création d'une sauvegarde

```json
{ "action": "create" }
```

Ou via CLI :
```bash
bhgbrain backup create
```

Les sauvegardes capturent l'intégralité de la base de données SQLite (tous les souvenirs, catégories, collections, journal d'audit, révisions et enregistrements d'archive) en tant que fichier `.bhgb` unique dans le sous-répertoire `backups/` de votre répertoire de données.

**Format de fichier de sauvegarde :**
```
[4 octets : longueur de l'en-tête (UInt32LE)]
[octets d'en-tête : en-tête JSON]
[octets restants : export de la base de données SQLite]
```

L'en-tête JSON contient :
```json
{
  "version": 1,
  "memory_count": 1234,
  "checksum": "<sha256 des données db>",
  "created_at": "2026-03-15T12:00:00Z",
  "embedding_model": "text-embedding-3-small",
  "embedding_dimensions": 1536
}
```

**Ce qui n'est PAS dans la sauvegarde :**
- Les données vectorielles Qdrant **ne sont pas** incluses. Après la restauration depuis une sauvegarde, les collections Qdrant doivent être reconstruites en ré-intégrant le contenu. En attendant, la recherche plein texte fonctionne mais pas la recherche sémantique.

**Intégrité de la sauvegarde :** Une somme de contrôle SHA-256 des données de la base de données est stockée dans l'en-tête et vérifiée lors de la restauration. Si le fichier est corrompu, la restauration échoue avec `INVALID_INPUT: Backup integrity check failed`.

Les **métadonnées de sauvegarde** sont suivies dans la table SQLite `backup_metadata` pour que `backup list` puisse retourner des informations sur les sauvegardes historiques.

### Lister les sauvegardes

```json
{ "action": "list" }
```

Renvoie :
```json
{
  "backups": [
    {
      "path": "/home/user/.bhgbrain/backups/2026-03-15T12-00-00-000Z.bhgb",
      "size_bytes": 2048576,
      "memory_count": 1234,
      "created_at": "2026-03-15T12:00:00Z"
    }
  ]
}
```

### Restauration depuis une sauvegarde

```json
{
  "action": "restore",
  "path": "/home/user/.bhgbrain/backups/2026-03-15T12-00-00-000Z.bhgb"
}
```

**Processus de restauration :**
1. Valider l'existence du fichier et la correspondance de la somme de contrôle d'intégrité.

2. Écrire atomiquement la base de données SQLite intégrée dans le répertoire de données (écriture-vers-temp-puis-renommage).
3. Recharger à chaud la base de données SQLite en mémoire depuis le fichier restauré sans redémarrer le processus.
4. Exécuter les migrations de schéma sur la base de données rechargée pour assurer la compatibilité ascendante.
5. Renvoyer `{ memory_count: <count>, activated: true }`.

**La restauration est en direct :** La base de données restaurée est immédiatement active. Il n'est pas nécessaire de redémarrer le serveur. La réponse inclut `activated: true` pour le confirmer.

**Protection contre les restaurations simultanées :** Si une restauration est déjà en cours, les demandes de restauration ultérieures renvoient `INVALID_INPUT: Backup restore already in progress`.

---

## Santé et métriques

### Point de terminaison de santé

```bash
GET /health        # HTTP
# ou via CLI :
bhgbrain health
```

Renvoie un `HealthSnapshot` :

```json
{
  "status": "healthy",
  "components": {
    "sqlite": { "status": "healthy" },
    "qdrant": { "status": "healthy" },
    "embedding": { "status": "healthy" },
    "retention": { "status": "healthy" }
  },
  "memory_count": 1234,
  "db_size_bytes": 8388608,
  "uptime_seconds": 86400,
  "retention": {
    "counts_by_tier": {
      "T0": 42,
      "T1": 310,
      "T2": 882,
      "T3": 0
    },
    "expiring_soon": 5,
    "archived_count": 128,
    "unsynced_vectors": 0,
    "over_capacity": false
  }
}
```

**Logique de statut global :**
- `unhealthy` — si SQLite ou Qdrant est défaillant
- `degraded` — si l'embedding est dégradé/défaillant, OU si la rétention est dégradée (surcapacité ou vecteurs non synchronisés)
- `healthy` — tous les composants sont sains

**Statuts des composants :**

| Composant | Condition saine | Condition dégradée | Condition défaillante |
|---|---|---|---|
| `sqlite` | `SELECT 1` réussit | — | La requête génère une exception |
| `qdrant` | `getCollections()` réussit | — | Connexion refusée |
| `embedding` | L'appel API d'intégration réussit | Identifiants manquants ou injoignable | — |
| `retention` | Tous les budgets dans les limites, aucun vecteur non synchronisé | Budget dépassé OU vecteurs non synchronisés > 0 | — |

**Codes de statut HTTP :**
- `200` pour `healthy` et `degraded`
- `503` pour `unhealthy`

La santé de l'embedding est mise en cache pendant 30 secondes pour éviter les appels API par sonde vers OpenAI.

### Métriques

Si `observability.metrics_enabled: true`, un point de terminaison de métriques est disponible :

```bash
GET /metrics
```

Renvoie des métriques en paires clé-valeur en texte brut (format compatible Prometheus) :

| Métrique | Type | Description |
|---|---|---|
| `bhgbrain_tool_calls_total` | compteur | Total des invocations d'outils |
| `bhgbrain_tool_duration_seconds_avg` | histogramme | Durée moyenne des appels d'outils |
| `bhgbrain_tool_duration_seconds_count` | compteur | Nombre d'échantillons de durée d'appels d'outils |
| `bhgbrain_memory_count` | jauge | Nombre total actuel de souvenirs (mis à jour à l'écriture/suppression) |
| `bhgbrain_rate_limit_buckets` | jauge | Compartiments de suivi de la limitation de débit actifs |
| `bhgbrain_rate_limited_total` | compteur | Total des requêtes avec limitation de débit |

Les histogrammes utilisent un tampon circulaire limité des 1 000 derniers échantillons. Les métriques sont en cours de processus uniquement — il n'y a pas de poussée externe.

---

## Sécurité

### Authentification HTTP

En mode HTTP, les requêtes vers tous les points de terminaison sauf `/health` nécessitent un token `Bearer` :

```
Authorization: Bearer <votre-token>
```

La valeur du token est lue depuis la variable d'environnement nommée dans `transport.http.bearer_token_env` (par défaut : `BHGBRAIN_TOKEN`). Si la variable d'environnement n'est pas définie, toutes les requêtes HTTP sont autorisées (un avertissement est journalisé mais l'authentification n'est pas appliquée — pour les liaisons loopback uniquement, c'est acceptable).

**Sécurité fermée pour les liaisons externes :** Si l'hôte HTTP est non-loopback (ni `127.0.0.1`, ni `localhost`, ni `::1`) et qu'aucun token n'est configuré, le serveur **refuse de démarrer** :

```
SECURITY: HTTP binding to "0.0.0.0" is externally reachable but no bearer token is configured...
```

Pour autoriser explicitement l'accès externe non authentifié (non recommandé), définissez :
```json
{ "security": { "allow_unauthenticated_http": true } }
```

Un avertissement très visible est journalisé au démarrage lorsque ceci est actif.

### Application du loopback

Par défaut, les liaisons HTTP non-loopback sont rejetées avant même la vérification d'authentification :

```json
{ "security": { "require_loopback_http": true } }
```

Pour lier à une adresse non-loopback (ex. pour des clients distants sur un réseau local) :
```json
{
  "transport": { "http": { "host": "0.0.0.0" } },
  "security": { "require_loopback_http": false }
}
```

Assurez-vous que `BHGBRAIN_TOKEN` est défini dans cette configuration.

### Limitation de débit

Les requêtes HTTP sont limitées en débit par adresse IP client :

- Par défaut : 100 requêtes par minute (`security.rate_limit_rpm`)
- L'état de limitation de débit est indexé sur l'IP de confiance (pas l'en-tête `x-client-id`)
- Les clients dépassant la limite reçoivent HTTP 429 avec `{ error: { code: "RATE_LIMITED", retryable: true } }`
- Les en-têtes de réponse incluent `X-RateLimit-Limit` et `X-RateLimit-Remaining`
- Les compartiments de limitation de débit expirés sont balayés toutes les 30 secondes

### Limitation de la taille des requêtes

Les corps de requête HTTP sont limités à `security.max_request_size_bytes` (par défaut 1 Mo = 1 048 576 octets). Les requêtes surdimensionnées reçoivent HTTP 413.

### Masquage dans les journaux

Lorsque `security.log_redaction: true` (par défaut), les tokens Bearer apparaissant dans la sortie des journaux sont masqués. Les journaux d'échec d'authentification ne montrent qu'un aperçu tronqué des tokens invalides.

### Détection de secrets dans le contenu

Le pipeline d'écriture analyse tout contenu de souvenir entrant à la recherche d'identifiants et de secrets avant le stockage. Tout contenu correspondant à des modèles d'identifiants est rejeté avec `INVALID_INPUT`. Cela s'applique à tous les outils et transports.

---

## Ressources MCP

BHGBrain expose des ressources MCP (lisibles via `ReadResource`) en plus des outils.

### Ressources statiques

| URI | Nom | Description |
|---|---|---|
| `memory://list` | Liste de souvenirs | Liste paginée par curseur des souvenirs (les plus récents en premier) |
| `memory://inject` | Injection de session | Bloc de contexte budgété pour l'injection automatique (catégories + meilleurs souvenirs) |
| `category://list` | Catégories | Toutes les catégories avec aperçus |
| `collection://list` | Collections | Toutes les collections avec le nombre de souvenirs |
| `health://status` | État de santé | Instantané de santé complet |

### Modèles de ressources (paramétrés)

| Modèle URI | Nom | Description |
|---|---|---|
| `memory://{id}` | Détails du souvenir | Enregistrement de souvenir complet par UUID |
| `category://{name}` | Catégorie | Contenu complet de la catégorie par nom |
| `collection://{name}` | Collection | Souvenirs dans une collection spécifique |

### `memory://list` — Liste paginée des souvenirs

Paramètres de requête :
- `namespace` — espace de noms à lister (par défaut : `global`)
- `limit` — taille de page, 1–100 (par défaut : 20)
- `cursor` — curseur opaque de la réponse précédente pour la pagination

Réponse :
```json
{
  "items": [/* objets MemoryRecord */],
  "cursor": "2026-03-15T12:00:00.000Z|<uuid>",
  "total_results": 1234,
  "truncated": true
}
```

La pagination utilise des curseurs composites (`created_at|id`) pour un ordre stable. Les liens à la même horodatage sont brisés par ID, garantissant qu'aucune ligne n'est sautée ou dupliquée entre les pages.

### `memory://inject` — Injection de contexte de session

La ressource d'injection construit une charge utile textuelle budgétée pour l'injection dans une fenêtre de contexte LLM :

1. Tout le contenu des catégories est préfixé en premier (contenu complet, dans l'ordre).
2. Les meilleurs souvenirs récents sont ajoutés (contenu ou résumé selon l'espace disponible).
3. La charge utile est tronquée à `auto_inject.max_chars` (par défaut 30 000 caractères).

Paramètres de requête :
- `namespace` — espace de noms depuis lequel injecter (par défaut : `global`)

Réponse :
```json
{
  "content": "## company-standards (company-values)\n...\n## api-contracts (architecture)\n...\n- [semantic] Our auth service uses JWT...\n",
  "truncated": false,
  "total_results": 42,
  "categories_count": 2,
  "memories_count": 10
}
```

Accéder à un souvenir via `memory://{id}` incrémente son nombre d'accès et planifie une vidange différée.

---

## Prompt d'amorçage

`BootstrapPrompt.txt` contient un prompt d'entretien structuré pour construire un **profil de second cerveau professionnel** avec un agent IA.

Utilisez-le lors de l'intégration d'un nouvel assistant IA ou lorsque vous souhaitez alimenter BHGBrain avec un profil riche et structuré de votre contexte de travail, entités, locataires et règles de désambiguïsation.

### Comment l'utiliser

1. Démarrez une nouvelle conversation avec votre assistant IA (Claude, GPT-4, etc.).
2. Collez l'intégralité du contenu de `BootstrapPrompt.txt` comme premier message.
3. Laissez l'agent vous interviewer section par section.
4. À la fin, l'agent produira un profil structuré que vous pourrez sauvegarder dans BHGBrain via des appels `bhgbrain.remember` (ou `mcporter call bhgbrain.remember`).

### Ce qu'il couvre

L'entretien parcourt 10 sections :

| Section | Ce qu'elle capture |
|---|---|
| 1. Identité et rôle | Nom, titres, rôles principaux vs orientés client |
| 2. Responsabilités | Ce que vous gérez, ce que vous influencez |
| 3. Objectifs | Priorités à 30 jours, trimestrielles, annuelles |
| 4. Style de communication | Comment vous souhaitez que les informations soient présentées |
| 5. Modes de travail | Fenêtres de réflexion stratégique vs d'exécution |
| 6. Outils et systèmes | Sources de vérité, plateformes clés |
| 7. Carte d'entreprise et d'entités | Chaque organisation, client, produit et relation |
| 8. Structure GitHub / dépôts | Orgs, dépôts, qui possède quoi |
| 9. Carte des locataires et environnements | Locataires Azure, dev/staging/prod |
| 10. Règles de fonctionnement | Conventions de nommage, désambiguïsation, hypothèses par défaut |

La sortie produit un profil structuré propre avec les 10 sections plus un guide de désambiguïsation — exactement ce dont BHGBrain a besoin pour répondre de façon fiable aux questions sur votre travail.

**Les souvenirs d'amorçage sont T0 par défaut.** Le contenu ingéré via le flux d'amorçage doit être étiqueté avec `source: import` et `tags: ["bootstrap", "profile"]`. Le classificateur heuristique reconnaît ces signaux et attribue le niveau T0 (fondamental).

---

## Référence CLI

```bash
# Opérations sur les souvenirs
bhgbrain list                         # Lister les souvenirs récents (les plus récents en premier)
bhgbrain search <query>               # Recherche hybride
bhgbrain show <id>                    # Afficher les détails complets d'un souvenir
bhgbrain forget <id>                  # Supprimer définitivement un souvenir

# Gestion des niveaux
bhgbrain tier show <id>               # Afficher le niveau, l'expiration, le nombre d'accès d'un souvenir
bhgbrain tier set <id> <T0|T1|T2|T3> # Changer le niveau de rétention d'un souvenir
bhgbrain tier list --tier T0          # Lister tous les souvenirs dans un niveau spécifique

# Gestion des archives
bhgbrain archive list                 # Lister les résumés des souvenirs archivés (supprimés)
bhgbrain archive search <query>       # Rechercher dans les archives par texte
bhgbrain archive restore <id>         # Restaurer un souvenir archivé en tant que nouveau souvenir T2

# Statistiques et diagnostics
bhgbrain stats                        # Statistiques de la base de données, résumé des collections
bhgbrain stats --by-tier              # Décomposition du nombre de souvenirs par niveau de rétention
bhgbrain stats --expiring             # Afficher les souvenirs expirant dans les 7 prochains jours
bhgbrain health                       # Vérification complète de la santé du système

# Ramasse-miettes
bhgbrain gc                           # Exécuter le nettoyage (supprimer les souvenirs non-T0 expirés)
bhgbrain gc --dry-run                 # Afficher ce qui serait nettoyé sans supprimer
bhgbrain gc --tier T3                 # Nettoyer uniquement les souvenirs T3
bhgbrain gc --consolidate             # GC + passage de consolidation avec marquage de péremption
bhgbrain gc --force-compact           # Forcer la compaction de segments Qdrant après le GC

# Journal d'audit
bhgbrain audit                        # Afficher les entrées d'audit récentes

# Gestion des catégories
bhgbrain category list                # Lister toutes les catégories
bhgbrain category get <name>          # Afficher le contenu d'une catégorie
bhgbrain category set <name>          # Définir/mettre à jour le contenu d'une catégorie (interactif)
bhgbrain category delete <name>       # Supprimer une catégorie

# Gestion des sauvegardes
bhgbrain backup create                # Créer une sauvegarde dans le répertoire de données
bhgbrain backup list                  # Lister toutes les sauvegardes connues
bhgbrain backup restore <path>        # Restaurer depuis un fichier de sauvegarde .bhgb

# Gestion du serveur
bhgbrain server start                 # Démarrer le serveur MCP
bhgbrain server status                # Vérifier si le serveur est en cours d'exécution et sain
bhgbrain server token                 # Générer un nouveau token Bearer aléatoire
```

---

## Référence des outils MCP

BHGBrain expose 8 outils MCP. Tous les outils valident les entrées avec des schémas Zod et renvoient du JSON structuré. Les erreurs utilisent une enveloppe cohérente :

```json
{
  "error": {
    "code": "INVALID_INPUT | NOT_FOUND | CONFLICT | AUTH_REQUIRED | RATE_LIMITED | EMBEDDING_UNAVAILABLE | INTERNAL",
    "message": "Description lisible par l'humain",
    "retryable": true
  }
}
```

---

### `remember` — Stocker un souvenir

Stocke du contenu dans BHGBrain avec déduplication automatique, normalisation, intégration et classification par niveau.

**Entrée :**

| Paramètre | Type | Obligatoire | Par défaut | Description |
|---|---|---|---|---|
| `content` | `string` | **Oui** | — | Le contenu à stocker. Max 100 000 caractères. Les caractères de contrôle sont supprimés. Le contenu correspondant à des modèles de secrets est rejeté. |
| `namespace` | `string` | Non | `"global"` | Portée de l'espace de noms. Modèle : `^[a-zA-Z0-9/-]{1,200}$` |
| `collection` | `string` | Non | `"general"` | Collection au sein de l'espace de noms. Max 100 caractères. |
| `type` | `"episodic" \| "semantic" \| "procedural"` | Non | `"semantic"` | Type de mémoire. Influence l'attribution du niveau par défaut. |
| `tags` | `string[]` | Non | `[]` | Tags pour le filtrage et la classification. Max 20 tags, chacun max 100 caractères. Modèle : `^[a-zA-Z0-9-]+$` |
| `category` | `string` | Non | — | Rattacher à un emplacement de catégorie (implique le niveau T0). Max 100 caractères. |
| `importance` | `number (0–1)` | Non | `0,5` | Score d'importance. Les valeurs plus élevées sont prioritaires lors du nettoyage des périmés. |
| `source` | `"cli" \| "api" \| "agent" \| "import"` | Non | `"cli"` | Source du souvenir. Affecte le niveau par défaut (ex. agent+procedural → T1). |
| `retention_tier` | `"T0" \| "T1" \| "T2" \| "T3"` | Non | auto-attribué | Remplacement de niveau explicite. Prend le dessus sur toutes les heuristiques. |

**Sortie :**

```json
{
  "id": "3f4a1b2c-...",
  "summary": "Our auth service uses JWT with 1h expiry",
  "type": "semantic",
  "operation": "ADD",
  "created_at": "2026-03-15T12:00:00Z"
}
```

`operation` est l'un des suivants :
- `ADD` — nouveau souvenir créé
- `UPDATE` — souvenir similaire existant mis à jour (contenu fusionné)
- `NOOP` — doublon exact ou quasi-exact ; souvenir existant renvoyé

Pour les opérations `UPDATE`, `merged_with_id` contient l'ID du souvenir qui a été mis à jour.

**Exemples :**

```json
// Stocker une décision d'architecture (T0)
{
  "content": "Authentication uses JWT tokens signed with RS256. Public keys are rotated every 90 days and published at /.well-known/jwks.json",
  "type": "semantic",
  "tags": ["auth", "jwt", "architecture"],
  "importance": 0.9,
  "retention_tier": "T0"
}

// Stocker un résultat de réunion (T2, attribué automatiquement)
{
  "content": "Sprint 14 retrospective: team agreed to add integration tests before merging new endpoints",
  "type": "episodic",
  "tags": ["sprint", "retrospective"],
  "source": "agent"
}

// Stocker un runbook (T1 via le type procedural)
{
  "content": "## Deployment Runbook\n1. Run `npm run build`\n2. Push to staging\n3. Run smoke tests\n4. Tag release\n5. Deploy to prod",
  "type": "procedural",
  "tags": ["deployment", "runbook"],
  "source": "import",
  "importance": 0.8
}
```

---

### `recall` — Rappel sémantique

Récupère les souvenirs les plus pertinents pour une requête en utilisant la recherche par similarité sémantique (vectorielle) avec filtrage optionnel.

**Entrée :**

| Paramètre | Type | Obligatoire | Par défaut | Description |
|---|---|---|---|---|
| `query` | `string` | **Oui** | — | Requête de rappel. Max 500 caractères. |
| `namespace` | `string` | Non | `"global"` | Espace de noms à rechercher. |
| `collection` | `string` | Non | — | Filtrer sur une collection spécifique. Omettre pour rechercher dans la collection par défaut. |
| `type` | `"episodic" \| "semantic" \| "procedural"` | Non | — | Filtrer les résultats sur un type de mémoire spécifique. Appliqué après la récupération. |
| `tags` | `string[]` | Non | — | Filtrer sur les souvenirs ayant au moins un tag correspondant. Appliqué après la récupération. |
| `limit` | `integer (1–20)` | Non | `5` | Nombre maximum de résultats. |
| `min_score` | `number (0–1)` | Non | `0,6` | Score de similarité cosinus minimal. Les résultats en dessous de ce seuil sont exclus. |

**Sortie :**

```json
{
  "results": [
    {
      "id": "3f4a1b2c-...",
      "content": "Authentication uses JWT tokens signed with RS256...",
      "summary": "Authentication uses JWT tokens signed with RS256",
      "type": "semantic",
      "tags": ["auth", "jwt", "architecture"],
      "score": 0.87,
      "semantic_score": 0.87,
      "retention_tier": "T0",
      "expires_at": null,
      "expiring_soon": false,
      "created_at": "2026-01-01T00:00:00Z",
      "last_accessed": "2026-03-15T12:00:00Z"
    }
  ]
}
```

---

### `forget` — Supprimer un souvenir

Supprime définitivement un souvenir spécifique par son UUID. Supprime de SQLite et de Qdrant. Crée une entrée dans le journal d'audit.

**Entrée :**

| Paramètre | Type | Obligatoire | Description |
|---|---|---|---|
| `id` | `string (UUID)` | **Oui** | L'ID du souvenir à supprimer. |

**Sortie :**

```json
{
  "deleted": true,
  "id": "3f4a1b2c-..."
}
```

Renvoie une erreur `NOT_FOUND` si l'ID n'existe pas ou est déjà archivé.

---

### `search` — Recherche multi-mode

Recherche des souvenirs en utilisant les modes sémantique, plein texte ou hybride. Offre plus de contrôle que `recall` et prend en charge des limites de résultats plus élevées.

**Entrée :**

| Paramètre | Type | Obligatoire | Par défaut | Description |
|---|---|---|---|---|
| `query` | `string` | **Oui** | — | Requête de recherche. Max 500 caractères. |
| `namespace` | `string` | Non | `"global"` | Espace de noms à rechercher. |
| `collection` | `string` | Non | — | Filtrer sur une collection spécifique. |
| `mode` | `"semantic" \| "fulltext" \| "hybrid"` | Non | `"hybrid"` | Algorithme de recherche. |
| `limit` | `integer (1–50)` | Non | `10` | Nombre maximum de résultats. |

**Sortie :** Même structure que `recall` — `{ "results": [...] }` — mais sans le filtre `min_score` et supportant jusqu'à 50 résultats.

---

### `tag` — Gérer les tags

Ajouter ou supprimer des tags d'un souvenir. Les tags sont fusionnés/filtrés de façon atomique ; le contenu et l'embedding du souvenir ne sont pas affectés.

**Entrée :**

| Paramètre | Type | Obligatoire | Par défaut | Description |
|---|---|---|---|---|
| `id` | `string (UUID)` | **Oui** | — | Souvenir à tagger. |
| `add` | `string[]` | Non | `[]` | Tags à ajouter. Max 20 tags au total après fusion. |
| `remove` | `string[]` | Non | `[]` | Tags à supprimer. |

**Sortie :**

```json
{
  "id": "3f4a1b2c-...",
  "tags": ["auth", "architecture", "jwt"]
}
```

Renvoie `INVALID_INPUT` si l'ajout de tags dépasserait la limite de 20 tags.

---

### `collections` — Gérer les collections

Lister, créer ou supprimer des collections au sein d'un espace de noms.

**Entrée :**

| Paramètre | Type | Obligatoire | Par défaut | Description |
|---|---|---|---|---|
| `action` | `"list" \| "create" \| "delete"` | **Oui** | — | Action à effectuer. |
| `namespace` | `string` | Non | `"global"` | Contexte de l'espace de noms. |
| `name` | `string` | Obligatoire pour `create`/`delete` | — | Nom de la collection. Max 100 caractères. |
| `force` | `boolean` | Non | `false` | Obligatoire pour supprimer une collection non vide (supprime tous les souvenirs). |

**Sortie `list` :**
```json
{
  "collections": [
    { "name": "general", "count": 42 },
    { "name": "architecture", "count": 10 }
  ]
}
```

**Sortie `create` :**
```json
{ "ok": true, "namespace": "global", "name": "architecture" }
```

**Sortie `delete` :**
```json
{ "ok": true, "namespace": "global", "name": "architecture", "deleted_memory_count": 10 }
```

**Important :** La suppression d'une collection non vide sans `force: true` renvoie une erreur `CONFLICT` :
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Collection \"architecture\" is not empty (10 memories). Retry with force=true to delete all collection data.",
    "retryable": false
  }
}
```

---

### `category` — Gérer les catégories de politique

Gérer les catégories de politique persistantes — blocs de contexte toujours disponibles qui sont préfixés dans chaque charge utile `memory://inject`.

**Entrée :**

| Paramètre | Type | Obligatoire | Description |
|---|---|---|---|
| `action` | `"list" \| "get" \| "set" \| "delete"` | **Oui** | Action à effectuer. |
| `name` | `string` | Obligatoire pour `get`/`set`/`delete` | Nom de la catégorie. Max 100 caractères. |
| `slot` | `"company-values" \| "architecture" \| "coding-requirements" \| "custom"` | Obligatoire pour `set` (par défaut `"custom"`) | Type d'emplacement de catégorie. |
| `content` | `string` | Obligatoire pour `set` | Contenu de la catégorie. Max 100 000 caractères. |

**Sortie `list` :**
```json
{
  "categories": [
    {
      "name": "coding-standards",
      "slot": "coding-requirements",
      "preview": "## Coding Standards\n\n- Use TypeScript strict mode...",
      "revision": 3,
      "updated_at": "2026-03-01T10:00:00Z"
    }
  ]
}
```

**Sortie `get` :**
```json
{
  "name": "coding-standards",
  "slot": "coding-requirements",
  "content": "## Coding Standards\n\n- Use TypeScript strict mode\n...",
  "revision": 3,
  "updated_at": "2026-03-01T10:00:00Z"
}
```

**Sortie `set` :** Renvoie l'enregistrement de catégorie complet (identique à `get`).

**Sortie `delete` :**
```json
{ "ok": true, "name": "coding-standards" }
```

---

### `backup` — Sauvegarde et restauration

Créer, lister ou restaurer des sauvegardes de mémoire.

**Entrée :**

| Paramètre | Type | Obligatoire | Description |
|---|---|---|---|
| `action` | `"create" \| "list" \| "restore"` | **Oui** | Action à effectuer. |
| `path` | `string` | Obligatoire pour `restore` | Chemin absolu vers le fichier de sauvegarde `.bhgb`. |

**Sortie `create` :**
```json
{
  "path": "/home/user/.bhgbrain/backups/2026-03-15T12-00-00-000Z.bhgb",
  "size_bytes": 2048576,
  "memory_count": 1234,
  "created_at": "2026-03-15T12:00:00Z"
}
```

**Sortie `list` :**
```json
{
  "backups": [
    {
      "path": "...",
      "size_bytes": 2048576,
      "memory_count": 1234,
      "created_at": "2026-03-15T12:00:00Z"
    }
  ]
}
```

**Sortie `restore` :**
```json
{ "memory_count": 1234, "activated": true }
```

---

## Mise à jour

### 1.0 → 1.2 (Cycle de vie de la mémoire par niveaux)

**Aucune migration manuelle requise.** BHGBrain met automatiquement à niveau les bases de données existantes au démarrage.

Ce qui se passe au premier démarrage après la mise à jour :

- Le schéma SQLite est migré sur place — les nouvelles colonnes (`retention_tier`, `expires_at`, `decay_eligible`, `review_due`, `archived`, `vector_synced`) sont ajoutées à la table `memories` avec des valeurs par défaut sûres.
- Tous les souvenirs existants se voient attribuer `retention_tier = T2` (rétention standard, TTL de 90 jours par défaut).
- Les collections Qdrant sont inchangées — aucune réindexation requise.
- Les fichiers `config.json` existants sont entièrement compatibles en avant. Les nouveaux champs de configuration (`retention.tier_ttl`, `retention.tier_budgets`, etc.) sont appliqués depuis les valeurs par défaut.

**Sauvegarde recommandée avant la mise à jour** (par précaution) :

```bash
bhgbrain backup create
```

La sauvegarde est stockée dans le répertoire de données (`%LOCALAPPDATA%\BHGBrain\` sur Windows, `~/.bhgbrain/` sur Linux/macOS).

---

## Notes de comportement

### Sémantique de suppression des collections

`collections.delete` rejette par défaut les collections non vides. Utilisez `force: true` pour passer outre :

```json
{
  "action": "delete",
  "namespace": "global",
  "name": "general",
  "force": true
}
```

### Activation de la restauration de sauvegarde

`backup.restore` recharge l'état SQLite en cours d'exécution avant de renvoyer le succès. Les réponses de restauration incluent `activated: true` lorsque les données restaurées sont immédiatement actives. Il n'est pas nécessaire de redémarrer le serveur.

### Renforcement HTTP

- `/health` est intentionnellement non authentifié pour la compatibilité des sondes.
- La limitation de débit est indexée sur l'identité de requête de confiance (IP) et ignore `x-client-id` pour l'application.
- `memory://list` applique des bornes `limit` de `1..100` ; les valeurs invalides renvoient `INVALID_INPUT`.

### Authentification sécurisée en cas d'échec

- Les liaisons HTTP non-loopback nécessitent par défaut un token Bearer.
- Si `BHGBRAIN_TOKEN` n'est pas défini et que l'hôte est non-loopback, le serveur refuse de démarrer.
- Pour autoriser explicitement l'accès externe non authentifié, définissez `security.allow_unauthenticated_http: true` dans la configuration. Un avertissement très visible est journalisé au démarrage.

### Mode dégradé d'embedding

- Si les identifiants du fournisseur d'embedding sont absents au démarrage, le serveur démarre en **mode dégradé** au lieu de planter.
- Les opérations dépendant de l'embedding (recherche sémantique, ingestion de souvenirs) renvoient `EMBEDDING_UNAVAILABLE` au moment de la requête.
- La recherche plein texte et les lectures de catégories fonctionnent toujours en mode dégradé.
- Les sondes de santé signalent l'état de l'embedding comme `degraded` sans effectuer de vrais appels API.

### Contrats de réponse MCP

- Les réponses aux appels d'outils incluent des charges utiles JSON structurées.
- Les réponses d'erreur définissent `isError: true` dans le protocole MCP pour le routage côté client.
- Les ressources paramétrées (`memory://{id}`, `category://{name}`, `collection://{name}`) sont exposées comme modèles de ressources MCP via `resources/templates/list`.

### Recherche et pagination

- **Portée de la collection :** La recherche plein texte et hybride respecte le filtre `collection` fourni par l'appelant dans les ensembles de candidats sémantiques et lexicaux.
- **Pagination stable :** `memory://list` utilise des curseurs composites (`created_at|id`) pour un ordre déterministe. Les lignes partageant le même horodatage ne sont pas sautées ou dupliquées entre les pages.
- **Exposition des dépendances :** La recherche sémantique propage les échecs Qdrant comme des erreurs explicites au lieu de renvoyer silencieusement des résultats vides.

### Observabilité opérationnelle

- **Métriques bornées :** Les valeurs d'histogramme utilisent un tampon circulaire borné (1 000 derniers échantillons).
- **Sémantique des métriques :** Les métriques d'histogramme émettent des suffixes `_avg` et `_count`.
- **Écritures atomiques :** Les écritures de fichiers de base de données et de sauvegarde utilisent le mécanisme écriture-vers-temp-puis-renommage pour éviter les fichiers partiellement tronqués en cas de plantage.
- **Vidange différée :** Les métadonnées d'accès sur le chemin de lecture (comptages de touches) utilisent un traitement par lot asynchrone borné (fenêtre de 5 s) au lieu de vidanges synchrones complètes de la base de données par requête.
- **Cohérence inter-magasins :** Les mises à jour SQLite sont annulées si l'opération Qdrant correspondante échoue.

### Historique des révisions T0

Lorsqu'un souvenir T0 (fondamental) est mis à jour, la version précédente est automatiquement instantanée dans la table `memory_revisions`. Cela fournit une piste d'audit en ajout seul pour les modifications de connaissances critiques. La révision actuelle est toujours ce que Qdrant stocke ; les révisions précédentes ne sont consultables que via la recherche plein texte.

### Compatibilité du modèle d'embedding

Les collections verrouillent leur modèle d'embedding et leurs dimensions au moment de la création. Si vous modifiez `embedding.model` ou `embedding.dimensions` dans la configuration, les nouveaux souvenirs dans les collections existantes seront rejetés avec une erreur `CONFLICT` jusqu'à ce que vous créiez une nouvelle collection. Cela empêche le mélange d'espaces d'embedding incompatibles dans le même index Qdrant.

### Détection de secrets

Le pipeline d'écriture rejette tout contenu correspondant à des modèles de clés API, d'identifiants de base de données, de clés privées et de formats de secrets courants. Il s'agit d'un filet de sécurité — n'utilisez jamais BHGBrain comme coffre-fort de secrets.

### La promotion de niveau n'atteint pas T0

La promotion automatique via le comptage d'accès peut promouvoir `T3 → T2` et `T2 → T1`, mais **jamais vers T0**. L'attribution T0 nécessite une intention explicite : soit passer `retention_tier: "T0"` dans l'appel `remember`, soit rattacher le souvenir à une catégorie. Cela garantit que les souvenirs fondamentaux sont toujours désignés délibérément.
