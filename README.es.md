# BHGBrain

Memoria persistente respaldada por vectores para clientes MCP (Claude, Codex, OpenClaw, etc.).

BHGBrain almacena memorias en SQLite (metadatos + búsqueda de texto completo) y Qdrant (vectores semánticos), exponiéndolas a través del Model Context Protocol (MCP) vía stdio, más una API REST sobre HTTP. Está diseñado para dar a los agentes de IA un segundo cerebro duradero y consultable que persiste entre sesiones — con gestión completa del ciclo de vida, deduplicación automática, retención por niveles y búsqueda híbrida.

---

## Tabla de Contenidos

1. [Descripción General y Arquitectura](#descripción-general-y-arquitectura)
2. [Requisitos Previos](#requisitos-previos)
3. [Configuración de Qdrant](#configuración-de-qdrant)
4. [Instalación](#instalación)
5. [Configuración](#configuración)
6. [Variables de Entorno](#variables-de-entorno)
7. [Ejecución del Servidor](#ejecución-del-servidor)
8. [Configuración del Cliente MCP](#configuración-del-cliente-mcp)
9. [Memoria Multi-Dispositivo](#memoria-multi-dispositivo)
   - [Cómo Funciona](#cómo-funciona)
   - [Resolución de Identidad de Dispositivo](#resolución-de-identidad-de-dispositivo)
   - [Qdrant Compartido, SQLite Local](#qdrant-compartido-sqlite-local)
   - [Reparación y Recuperación](#reparación-y-recuperación)
   - [Migración de Modelo de Embedding](#migración-de-modelo-de-embedding)
10. [Gestión de Memorias](#gestión-de-memorias)
    - [Modelo de Datos de Memoria](#modelo-de-datos-de-memoria)
    - [Tipos de Memoria](#tipos-de-memoria)
    - [Namespaces y Colecciones](#namespaces-y-colecciones)
    - [Niveles de Retención](#niveles-de-retención)
    - [Ciclo de Vida por Nivel — Asignación, Promoción, Ventana Deslizante](#ciclo-de-vida-por-nivel--asignación-promoción-ventana-deslizante)
    - [Deduplicación](#deduplicación)
    - [Normalización de Contenido](#normalización-de-contenido)
    - [Puntuación de Importancia](#puntuación-de-importancia)
    - [Categorías — Slots de Política Persistente](#categorías--slots-de-política-persistente)
    - [Decaimiento, Limpieza y Archivado](#decaimiento-limpieza-y-archivado)
    - [Advertencias de Expiración Anticipada](#advertencias-de-expiración-anticipada)
    - [Límites de Recursos y Presupuestos de Capacidad](#límites-de-recursos-y-presupuestos-de-capacidad)
11. [Búsqueda](#búsqueda)
    - [Búsqueda Semántica](#búsqueda-semántica)
    - [Búsqueda de Texto Completo](#búsqueda-de-texto-completo)
    - [Búsqueda Híbrida](#búsqueda-híbrida)
    - [Recall vs Search — Diferencias](#recall-vs-search--diferencias)
    - [Filtrado](#filtrado)
    - [Umbrales de Puntuación y Bonificaciones por Nivel](#umbrales-de-puntuación-y-bonificaciones-por-nivel)
12. [Copia de Seguridad y Restauración](#copia-de-seguridad-y-restauración)
13. [Salud y Métricas](#salud-y-métricas)
14. [Seguridad](#seguridad)
15. [Recursos MCP](#recursos-mcp)
16. [Prompt de Bootstrap](#prompt-de-bootstrap)
17. [Referencia de la CLI](#referencia-de-la-cli)
18. [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp)
19. [Actualización](#actualización)
20. [Notas de Comportamiento](#notas-de-comportamiento)

---

## Descripción General y Arquitectura

BHGBrain es un servidor de memoria persistente construido sobre el Model Context Protocol. Almacena todo lo que los agentes de IA aprenden, deciden y observan a lo largo de las sesiones — y luego pone ese conocimiento a disposición mediante recall semántico, búsqueda de texto completo y contexto inyectado.

### Arquitectura de Doble Almacén

```mermaid
graph TD
    subgraph Client["MCP Client<br/><i>Claude Desktop / OpenClaw / Codex</i>"]
    end

    Client -->|"MCP (stdio) or REST (HTTP)"| Server

    subgraph Server["BHGBrain Server"]
        WP["Write Pipeline"]
        SS["Search Service"]
        RH["Resource Handler<br/><i>memory:// URIs</i>"]

        subgraph Storage["Storage Manager"]
            subgraph SQLite["SQLite (sql.js)"]
                S1["metadata"]
                S2["fulltext (FTS)"]
                S3["categories"]
                S4["audit log"]
                S5["revisions"]
                S6["archive"]
            end
            subgraph Qdrant["Qdrant (vector store)"]
                Q1["embeddings (1536d)"]
                Q2["cosine similarity"]
                Q3["payload indexes"]
            end
        end

        WP --> Storage
        SS --> Storage
        RH --> Storage
    end

    Server -.->|"embed content"| OpenAI["OpenAI Embedding API<br/><i>text-embedding-3-small</i>"]

    classDef client fill:#4a90d9,stroke:#2c5f8a,color:#fff
    classDef server fill:#f0f4f8,stroke:#4a90d9,color:#333
    classDef component fill:#5ba85b,stroke:#3d7a3d,color:#fff
    classDef sqlite fill:#e8a838,stroke:#b8841c,color:#fff
    classDef qdrant fill:#d94a6e,stroke:#a83050,color:#fff
    classDef external fill:#8b5cf6,stroke:#6d3fc4,color:#fff

    class Client client
    class WP,SS,RH component
    class S1,S2,S3,S4,S5,S6 sqlite
    class Q1,Q2,Q3 qdrant
    class OpenAI external
```

- **SQLite** (vía `sql.js`, en memoria con volcado atómico periódico a disco) es el **sistema de registro** para todos los metadatos de memoria, índice de búsqueda de texto completo, categorías, historial de auditoría, historial de revisiones y registros de archivo.
- **Qdrant** almacena embeddings de vectores semánticos para búsqueda por similitud. Qdrant siempre se escribe después de que SQLite tiene éxito; los fallos se rastrean mediante el indicador `vector_synced` y se exponen en el endpoint de salud.
- **OpenAI text-embedding-3-small** (por defecto, configurable) genera embeddings de 1536 dimensiones para cada memoria.
- Las **escrituras atómicas** garantizan que los archivos de base de datos nunca se escriban parcialmente — todas las E/S de disco utilizan escritura-en-temporal-luego-renombrar.
- El **volcado diferido** agrupa las actualizaciones de metadatos de acceso (hasta 5 segundos) para evitar volcados de base de datos por solicitud en rutas de lectura intensiva.

---

## Requisitos Previos

| Requisito | Versión | Notas |
|---|---|---|
| Node.js | ≥ 20.0.0 | Se recomienda LTS |
| Qdrant | ≥ 1.10 | Debe estar en ejecución antes de iniciar BHGBrain. El cliente incluido (`@qdrant/js-client-rest` `~1.19.0`) llama a la API `query` introducida en Qdrant 1.10; los servidores más antiguos fallarán en la búsqueda semántica. |
| Clave API de OpenAI | — | Para embeddings (`text-embedding-3-small` por defecto). El servidor inicia en modo degradado si no está presente. |

---

## Configuración de Qdrant

BHGBrain **requiere una instancia externa de Qdrant**. Incluso en el modo `embedded` predeterminado, el servidor se conecta a `http://localhost:6333` — no hay ningún binario de Qdrant incluido. Debes ejecutarlo tú mismo.

### Opción A: Docker (recomendado)

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

Verificar que está en ejecución:

```bash
curl http://localhost:6333/health
# → {"title":"qdrant - vector search engine","version":"..."}
```

### Opción B: Docker Compose

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

### Opción C: Binario nativo

Descarga desde [https://github.com/qdrant/qdrant/releases](https://github.com/qdrant/qdrant/releases) y ejecuta:

```bash
./qdrant
```

### Opción D: Qdrant Cloud (modo externo)

Establece `qdrant.mode` en `external` en tu configuración y apunta `external_url` a la URL de tu clúster en la nube. Establece `qdrant.api_key_env` con el nombre de la variable de entorno que contiene tu clave API de Qdrant.

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

## Instalación

```bash
git clone https://github.com/Big-Hat-Group-Inc/BHGBrain.git
cd BHGBrain
npm install
npm run build
```

Para instalar globalmente como CLI:

```bash
npm install -g .
bhgbrain --help
```

---

## Configuración

BHGBrain carga su configuración desde:

- **Windows:** `%LOCALAPPDATA%\BHGBrain\config.json`
- **Linux/macOS:** `~/.bhgbrain/config.json`

El archivo se crea automáticamente en el primer arranque con todos los valores predeterminados aplicados. Edítalo para personalizar el comportamiento. También puedes pasar una ruta de configuración personalizada con `--config=<ruta>` al iniciar el servidor.

### Referencia Completa de Configuración

```jsonc
{
  // Directorio de datos (ruta absoluta). Por defecto, ubicación apropiada para la plataforma.
  "data_dir": null,

  // Identidad de dispositivo para configuraciones multi-dispositivo (ver sección Memoria Multi-Dispositivo)
  "device": {
    // Identificador estable de dispositivo. Auto-generado desde el hostname si se omite.
    // Patrón: ^[a-zA-Z0-9._-]{1,64}$
    // También puede establecerse vía la variable de entorno BHGBRAIN_DEVICE_ID.
    "id": null
  },

  // Configuración del proveedor de embeddings
  "embedding": {
    // Solo se admite "openai" actualmente
    "provider": "openai",
    // Modelo de OpenAI a usar para embeddings. Debe ser uno de los modelos admitidos:
    // "text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large".
    // Un modelo no admitido provoca un error de validación de configuración al iniciar.
    "model": "text-embedding-3-small",
    // Nombre de la variable de entorno que contiene la clave API de OpenAI
    "api_key_env": "OPENAI_API_KEY",
    // Dimensiones vectoriales producidas por el modelo. Debe coincidir con la salida del modelo.
    // IMPORTANTE: Cambiar esto después de crear colecciones requiere recrearlas.
    "dimensions": 1536,
    // Cada vector se marca con una identidad cualificada por proveedor
    // (`<provider>/<model>@<dimensions>`) en el momento de la escritura. Si la
    // identidad esperada registrada por el almacén (adoptada en la primera
    // escritura tras el arranque) difiere de esta configuración — p. ej. tras
    // cambiar de proveedor o modelo — el componente de salud `embedding` se
    // degrada y, mientras este flag sea true, las escrituras que producen
    // vectores se rechazan con un error que nombra el modo re-embed de la
    // herramienta `repair`. Establézcalo en false solo si desea que las
    // escrituras mezclen espacios de embedding intencionadamente. Ver
    // "Migración de Modelo de Embedding" más abajo.
    "refuse_writes_on_model_mismatch": true
  },

  // Configuración de conexión a Qdrant
  "qdrant": {
    // "embedded" = conectarse a localhost:6333
    // "external" = conectarse a external_url (Qdrant Cloud, instancia remota, etc.)
    "mode": "embedded",
    // Solo se usa para el modo embedded (actualmente sin uso — Qdrant debe iniciarse externamente)
    "embedded_path": "./qdrant",
    // URL externa de Qdrant (se usa cuando mode = "external")
    "external_url": null,
    // Nombre de la variable de entorno que contiene la clave API de Qdrant (se usa cuando mode = "external")
    "api_key_env": null
  },

  // Configuración de transporte
  "transport": {
    "http": {
      // Habilitar transporte HTTP
      "enabled": true,
      // Host al que enlazarse. Usa 127.0.0.1 solo para loopback (por defecto, seguro).
      // Los enlaces no-loopback requieren que BHGBRAIN_TOKEN esté configurado (o allow_unauthenticated_http).
      "host": "127.0.0.1",
      // Puerto en el que escuchar
      "port": 3721,
      // Nombre de la variable de entorno que contiene el bearer token para autenticación HTTP
      "bearer_token_env": "BHGBRAIN_TOKEN"
    },
    "stdio": {
      // Habilitar transporte MCP stdio
      "enabled": true
    }
  },

  // Valores predeterminados aplicados cuando los llamadores no los especifican
  "defaults": {
    // Namespace predeterminado para todas las operaciones
    "namespace": "global",
    // Colección predeterminada para todas las operaciones
    "collection": "general",
    // Límite de resultados predeterminado para operaciones de recall
    "recall_limit": 5,
    // Puntuación mínima de similitud semántica predeterminada (0-1) para recall
    "min_score": 0.6,
    // Número máximo de memorias incluidas en el payload de auto-inject
    "auto_inject_limit": 10,
    // Número máximo de caracteres en los payloads de respuesta de herramientas
    "max_response_chars": 50000
  },

  // Configuración de retención y ciclo de vida de memorias
  "retention": {
    // Días sin acceso tras los cuales una memoria se convierte en candidata a obsolescencia
    "decay_after_days": 180,
    // Tamaño máximo de la base de datos SQLite en gigabytes antes de que el estado de salud informe degradado
    "max_db_size_gb": 2,
    // Número máximo total de memorias antes de que el estado de salud informe sobrecapacidad
    "max_memories": 500000,
    // Porcentaje de max_memories en el que el estado de salud informa degradado
    "warn_at_percent": 80,

    // TTL por nivel en días (null = nunca expira)
    "tier_ttl": {
      "T0": null,    // Fundacional: nunca expira
      "T1": 365,     // Institucional: 1 año sin acceso
      "T2": 90,      // Operacional: 90 días sin acceso
      "T3": 30       // Transitorio: 30 días sin acceso
    },

    // Presupuestos de capacidad por nivel (null = ilimitado)
    "tier_budgets": {
      "T0": null,      // Sin límite en el conocimiento fundacional
      "T1": 100000,    // 100k memorias institucionales
      "T2": 200000,    // 200k memorias operacionales
      "T3": 200000     // 200k memorias transitorias
    },

    // Umbral de recuento de accesos para auto-promover una memoria un nivel
    "auto_promote_access_threshold": 5,

    // Cuando es true, cada acceso restablece el reloj de TTL (ventana deslizante)
    "sliding_window_enabled": true,

    // Cuando es true, las memorias expiradas se escriben en la tabla de archivo antes de eliminarlas
    "archive_before_delete": true,

    // Horario cron para el trabajo de limpieza en segundo plano (por defecto: 2am UTC diariamente)
    "cleanup_schedule": "0 2 * * *",

    // Cuando es true, el proceso del servidor ejecuta `cleanup_schedule` automáticamente
    // mediante un planificador interno (mismo camino de ejecución que `bhgbrain gc`).
    // Ponlo en false para depender solo de ejecuciones manuales de `bhgbrain gc` o de
    // un disparador cron externo.
    "scheduled_cleanup_enabled": true,

    // Días antes de la expiración en los que las memorias se marcan como expiring_soon
    "pre_expiry_warning_days": 7,

    // Umbral de compactación de segmentos de Qdrant (compactar cuando esta fracción de un segmento está eliminada)
    "compaction_deleted_threshold": 0.10
  },

  // Configuración de deduplicación
  "deduplication": {
    // Habilitar deduplicación semántica al escribir
    "enabled": true,
    // Umbral de similitud coseno por encima del cual el nuevo contenido se considera una ACTUALIZACIÓN del existente.
    // Los ajustes específicos por nivel se aplican además de esto (ver sección de Deduplicación más adelante).
    "similarity_threshold": 0.92
  },

  // Configuración de búsqueda
  "search": {
    // Pesos usados para Reciprocal Rank Fusion (RRF) en modo híbrido
    // Deben sumar 1.0
    "hybrid_weights": {
      "semantic": 0.7,
      "fulltext": 0.3
    },
    // Ranking compuesto: ordena los resultados por relevancia x un prior
    // derivado de la importancia, la frecuencia de acceso y la decadencia por
    // antigüedad según el nivel (ver "Ranking Compuesto" más abajo).
    // enabled: false restaura el orden por relevancia pura.
    "ranking": {
      "enabled": true,
      "w_importance": 0.3,
      "w_access": 0.2,
      "access_norm": 50,
      // Tasa de decadencia exponencial diaria por nivel de retención. T0 es 0 (nunca decae).
      "decay_per_day": {
        "T0": 0,
        "T1": 0.002,
        "T2": 0.008,
        "T3": 0.02
      }
    }
  },

  // Configuración de seguridad
  "security": {
    // Rechazar enlaces HTTP no-loopback por defecto (fail-closed)
    "require_loopback_http": true,
    // Permitir explícitamente HTTP externo sin autenticación (registra una advertencia de alta visibilidad)
    "allow_unauthenticated_http": false,
    // Redactar valores de tokens en logs estructurados
    "log_redaction": true,
    // Número máximo de solicitudes por minuto por IP de cliente para transporte HTTP
    "rate_limit_rpm": 100,
    // Tamaño máximo del cuerpo de solicitudes HTTP en bytes
    "max_request_size_bytes": 1048576,
    // Configuración "trust proxy" de Express. false (predeterminado) = req.ip es el
    // peer de socket directo (preciso para loopback); true = respeta X-Forwarded-For
    // del proxy inverso frente al servidor. Actívalo solo detrás de un proxy confiable.
    "trust_proxy": false
  },

  // Presupuesto del payload de auto-inject (para memory://inject y memory://inject/{hint})
  "auto_inject": {
    // Cantidad del presupuesto, interpretada según budget_unit más abajo
    "max_chars": 30000,
    // Presupuesto de tokens (null = ilimitado, se aplica el presupuesto de caracteres)
    "max_tokens": null,
    // Fracción del presupuesto reservada para la sección de memorias, para
    // que el contenido de categorías ya no pueda consumir todo el payload
    // antes de inyectar una sola memoria. 0 restaura el comportamiento
    // previo donde las categorías pueden usar todo el presupuesto.
    "memory_budget_fraction": 0.4,
    // 'chars' (predeterminado): max_chars es un presupuesto de caracteres,
    // sin cambios respecto a antes de esta opción. 'tokens': max_chars se
    // trata como un presupuesto de tokens estimado (caracteres/4, sin
    // dependencia de un tokenizador), escalando por 4 el presupuesto de
    // caracteres efectivo de cada sección.
    "budget_unit": "chars",
    // Supresión voraz de casi-duplicados dentro de la sección de memorias
    // seleccionada por hint: se omite un candidato cuya similitud con una
    // memoria ya seleccionada supere deduplication.similarity_threshold.
    "dedup_suppression": true
  },

  // Configuración de observabilidad
  "observability": {
    // Habilitar la recolección de métricas en proceso
    "metrics_enabled": false,
    // Usar logging JSON estructurado (vía pino)
    "structured_logging": true,
    // Nivel de log: "debug" | "info" | "warn" | "error"
    "log_level": "info"
  },

  // Configuración del pipeline de ingesta
  "pipeline": {
    // Habilitar el paso de extracción (actualmente ejecuta extracción determinística de un solo candidato)
    "extraction_enabled": true,
    // Modelo usado para extracción basada en LLM (planificado para uso futuro)
    "extraction_model": "gpt-4o-mini",
    // Nombre de la variable de entorno para la clave API del modelo de extracción
    "extraction_model_env": "BHGBRAIN_EXTRACTION_API_KEY",
    // Cuando es true, recurre a dedup por checksum + similitud de texto completo si el embedding no está disponible
    "fallback_to_threshold_dedup": true
  },

  // Auto-resumir el contenido de la memoria en la ingesta
  "auto_summarize": true
}
```

---

## Variables de Entorno

| Variable | Requerida | Predeterminado | Descripción |
|---|---|---|---|
| `OPENAI_API_KEY` | Sí (para embeddings) | — | Clave API de OpenAI. El servidor inicia en **modo degradado** si no está presente — la búsqueda semántica y la ingesta fallarán, pero la búsqueda de texto completo y las lecturas de categorías siguen funcionando. |
| `BHGBRAIN_TOKEN` | Requerida para HTTP no-loopback | — | Bearer token para autenticación HTTP. El servidor **se niega a iniciar** si el host es no-loopback y esto no está configurado (a menos que `allow_unauthenticated_http: true`). |
| `QDRANT_API_KEY` | Requerida para Qdrant Cloud | — | Establece `qdrant.api_key_env` en la configuración con el nombre de esta variable. El nombre predeterminado del campo de configuración es `QDRANT_API_KEY`. |
| `BHGBRAIN_DEVICE_ID` | No | Auto-generado desde el hostname | Anular el identificador de dispositivo para configuraciones multi-dispositivo. Ver [Resolución de Identidad de Dispositivo](#resolución-de-identidad-de-dispositivo). |
| `BHGBRAIN_EXTRACTION_API_KEY` | No | Usa `OPENAI_API_KEY` como respaldo | Clave API para el modelo de extracción LLM (uso futuro). |

Generar un bearer token seguro:

```bash
bhgbrain server token
# o sin la CLI:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Ejecución del Servidor

### Modo stdio (MCP sobre stdin/stdout)

Este es el modo predeterminado utilizado por clientes MCP como Claude Desktop. El indicador `--stdio` solicita explícitamente el transporte stdio.

```bash
# Desarrollo (no se requiere compilación)
npm run dev

# Producción vía CLI
node dist/index.js --stdio

# Con un archivo de configuración personalizado
node dist/index.js --stdio --config=/path/to/config.json
```

### Modo HTTP

> Este transporte es una API REST simple para scripts, sondas de salud y la CLI. **No**
> implementa MCP Streamable HTTP: los clientes MCP deben usar stdio en su lugar (ver
> «Configuración de clientes MCP»).

HTTP está habilitado por defecto en `127.0.0.1:3721`. Establece `BHGBRAIN_TOKEN` antes de iniciar si deseas acceso autenticado:

```bash
export OPENAI_API_KEY=sk-...
export BHGBRAIN_TOKEN=<your-token>
node dist/index.js
```

El servidor escucha en `http://127.0.0.1:3721` por defecto. Endpoints HTTP disponibles:

| Endpoint | Auth Requerida | Descripción |
|---|---|---|
| `GET /health` | No | Verificación de salud (sin autenticación para compatibilidad con sondas) |
| `POST /tool/:name` | Sí | Invocar una herramienta MCP por nombre |
| `GET /resource?uri=...` | Sí | Leer un recurso MCP por URI |
| `GET /metrics` | Sí | Métricas en formato Prometheus (si `metrics_enabled: true`) |

Ejemplo de verificación de salud:

```bash
curl http://127.0.0.1:3721/health
```

Ejemplo de llamada a herramienta vía HTTP:

```bash
curl -X POST http://127.0.0.1:3721/tool/remember \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Our auth service uses JWT with 1h expiry", "type": "semantic", "tags": ["auth", "architecture"]}'
```

---

## Configuración del Cliente MCP

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

### Claude Desktop (CLI instalada globalmente)

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

### OpenClaw / mcporter (transporte stdio)

BHGBrain habla MCP **únicamente por stdio**. El servidor HTTP descrito en «Modo HTTP»
es una API REST simple (`POST /tool/:name`, `GET /resource`): *no* es un endpoint MCP
Streamable HTTP, por lo que los clientes MCP no pueden conectarse a él. Apúntalos al
binario `bhgbrain-server` en su lugar:

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "stdio",
      "command": "bhgbrain-server",
      "args": ["--stdio"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "QDRANT_API_KEY": "..."
      }
    }
  }
}
```

O contra una copia del código fuente en lugar del binario instalado globalmente:

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "stdio",
      "command": "node",
      "args": ["/ruta/a/BHGBrain/dist/index.js", "--stdio"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "QDRANT_API_KEY": "..."
      }
    }
  }
}
```

> **¿Ejecutas OpenClaw dentro de WSL o de un contenedor?** BHGBrain debe estar
> instalado en ese mismo entorno. stdio significa que el cliente lanza el servidor como
> proceso hijo, así que el servidor no puede vivir en otra distribución o contenedor.
> Para compartir memoria entre entornos, da a cada instalación su propia base SQLite y
> apunta todas al mismo clúster de Qdrant (ver «Memoria Multi-Dispositivo»).

---

## Memoria Multi-Dispositivo

BHGBrain soporta la ejecución de múltiples instancias en diferentes máquinas (p.ej., una estación de trabajo principal y un entorno de desarrollo en la nube) que comparten el mismo backend de Qdrant Cloud. Cada instancia mantiene su propia base de datos SQLite local mientras lee y escribe en un almacén de vectores compartido.

### Cómo Funciona

```mermaid
graph TD
    subgraph DevA["Device A (Workstation)"]
        SA["SQLite (local)<br/>device_id: ws-1"]
    end

    subgraph DevB["Device B (Cloud PC)"]
        SB["SQLite (local)<br/>device_id: w365"]
    end

    SA -->|"write + read"| QC
    SB -->|"write + read"| QC

    subgraph QC["Qdrant Cloud (shared backend)"]
        V["vectors"]
        CP["content payload"]
        DI["device_id index"]
    end

    SA -.->|"fallback search<br/>for Device B memories"| QC
    SB -.->|"fallback search<br/>for Device A memories"| QC

    classDef device fill:#4a90d9,stroke:#2c5f8a,color:#fff
    classDef sqlite fill:#e8a838,stroke:#b8841c,color:#fff
    classDef qdrant fill:#d94a6e,stroke:#a83050,color:#fff

    class SA,SB sqlite
    class V,CP,DI qdrant
```

Cada escritura de memoria almacena el contenido completo tanto en SQLite (local) como en el payload de Qdrant (compartido). Esto significa:

- **Sin punto único de fallo**: Si el SQLite de un dispositivo se pierde, el contenido puede recuperarse desde Qdrant.
- **Visibilidad entre dispositivos**: Todos los dispositivos ven todas las memorias vía Qdrant, incluso si su SQLite local solo tiene un subconjunto.
- **Seguimiento de procedencia**: Cada memoria se etiqueta con el `device_id` de la instancia que la creó.

### Resolución de Identidad de Dispositivo

Cada instancia de BHGBrain resuelve un `device_id` estable al iniciar, usando este orden de prioridad:

1. **Variable de entorno**: `BHGBRAIN_DEVICE_ID` — tiene prioridad sobre un valor persistido, siguiendo el contrato de "las variables de entorno ganan" usado para cualquier otro override `BHGBRAIN_*` (ver [Configuración vs. entorno](#configuración)). Cuando anula un `device.id` previamente persistido, el nuevo valor se vuelve a persistir.
2. **Configuración explícita/persistida**: Campo `device.id` en `config.json`
3. **Auto-generado**: Derivado de `os.hostname()`, en minúsculas y sanitizado a `[a-zA-Z0-9._-]`

En la primera ejecución, el ID resuelto se persiste en `config.json` para que permanezca estable entre reinicios, incluso si el hostname cambia posteriormente. `config.json` solo se reescribe cuando el device id fue recién generado o cambiado por un override de entorno — un arranque en estado estable con un id ya persistido y sin cambios no realiza ninguna escritura.

```jsonc
// config.json — sección de dispositivo
{
  "device": {
    "id": "cpc-kevin-98f91"   // auto-generado desde el hostname, o establecido explícitamente
  }
}
```

El `device_id` aparece en:
- Cada payload de Qdrant (como campo indexado por keyword)
- Cada registro de memoria en SQLite
- Resultados de búsqueda (para que los llamadores puedan identificar qué dispositivo creó una memoria)

### Qdrant Compartido, SQLite Local

Cada dispositivo mantiene su propia base de datos SQLite de forma independiente. No hay protocolo de sincronización entre dispositivos — Qdrant es la capa compartida.

**Lo que ve cada dispositivo:**

| Fuente | Dispositivo A ve | Dispositivo B ve |
|---|---|---|
| Memorias del Dispositivo A (vía SQLite local) | ✅ Registro completo | ❌ No está en SQLite local |
| Memorias del Dispositivo A (vía fallback de Qdrant) | ✅ Registro completo | ✅ Contenido desde payload de Qdrant |
| Memorias del Dispositivo B (vía SQLite local) | ❌ No está en SQLite local | ✅ Registro completo |
| Memorias del Dispositivo B (vía fallback de Qdrant) | ✅ Contenido desde payload de Qdrant | ✅ Registro completo |

Cuando una búsqueda devuelve una memoria que existe en Qdrant pero no en el SQLite local, BHGBrain construye el resultado desde el payload de Qdrant en lugar de descartarla silenciosamente. Esto significa que ambos dispositivos obtienen resultados de búsqueda completos independientemente de qué dispositivo creó la memoria.

### Reparación y Recuperación

```mermaid
flowchart TD
    START["repair tool invoked"] --> SCROLL["Scroll all bhgbrain_*<br/>Qdrant collections"]
    SCROLL --> LOOP{"Next point?"}
    LOOP -->|Yes| CHECK{"Point ID exists<br/>in local SQLite?"}
    CHECK -->|Yes| SKIP1["Skip<br/><i>already_in_sqlite++</i>"]
    SKIP1 --> LOOP
    CHECK -->|No| CONTENT{"Has content<br/>in Qdrant payload?"}
    CONTENT -->|No| SKIP2["Skip<br/><i>skipped_no_content++</i><br/><i>(pre-1.3 memory)</i>"]
    SKIP2 --> LOOP
    CONTENT -->|Yes| INSERT["Insert into SQLite<br/><i>Preserve original device_id</i><br/><i>recovered++</i>"]
    INSERT --> LOOP
    LOOP -->|"No more points"| REPORT["Report Stats<br/><i>collections scanned</i><br/><i>points scanned</i><br/><i>recovered / skipped / errors</i>"]

    classDef start fill:#4a90d9,stroke:#2c5f8a,color:#fff
    classDef skip fill:#6c757d,stroke:#495057,color:#fff
    classDef recover fill:#5ba85b,stroke:#3d7a3d,color:#fff
    classDef report fill:#8b5cf6,stroke:#6d3fc4,color:#fff

    class START start
    class SKIP1,SKIP2 skip
    class INSERT recover
    class REPORT report
```

La herramienta `repair` reconstruye el SQLite local de un dispositivo desde Qdrant. Úsala después de:

- Configurar un nuevo dispositivo que comparte un backend de Qdrant existente
- Recuperarse de una pérdida de datos de SQLite
- Migrar a una nueva máquina

```json
// Vista previa de lo que se recuperaría (sin cambios)
{ "dry_run": true }

// Recuperar todas las memorias desde Qdrant al SQLite local
{ "dry_run": false }

// Recuperar solo memorias creadas por un dispositivo específico
{ "device_id": "cpc-kevin-98f91", "dry_run": false }
```

La herramienta de reparación:
- Recorre todos los puntos en todas las colecciones `bhgbrain_*` de Qdrant
- Inserta cualquier memoria con `content` en su payload de Qdrant que falte en el SQLite local
- Preserva la procedencia original del `device_id` (o etiqueta con el ID del dispositivo local si no existe ninguno)
- Reporta: colecciones escaneadas, puntos escaneados, recuperados, omitidos (sin contenido), errores

**Nota**: Las memorias almacenadas antes de que se añadiera la función de contenido en Qdrant (pre-1.3) no tienen contenido en su payload de Qdrant y no pueden recuperarse vía reparación. Solo los metadatos (etiquetas, tipo, importancia) sobreviven para esas entradas.

### Migración de Modelo de Embedding

Cada vector se marca en el momento de la escritura con una identidad cualificada por
proveedor — `<provider>/<model>@<dimensions>` (p. ej. `openai/text-embedding-3-small@1536`)
— tanto en la fila de SQLite como en el payload de Qdrant. El almacén también recuerda
esta identidad como su expectativa, adoptada la primera vez que se escribe tras el
arranque.

Esto existe porque mezclar espacios de embedding es una corrupción silenciosa: si
cambia `embedding.provider` o `embedding.model` en `config.json` manteniendo las
mismas dimensiones (p. ej. cambiando a un despliegue de Azure de la misma familia de
modelos), nada a nivel de Qdrant lo detecta — los nuevos vectores se mezclan en la
misma colección que los antiguos, la similitud coseno entre los dos espacios carece
de sentido, y tanto la relevancia del recall como la deduplicación (los puntajes de
`similar[0]` que alimentan los umbrales 0.92/0.98) se degradan silenciosamente. Un
cambio de dimensiones falla ruidosamente con un error opaco de Qdrant; el marcado de
procedencia hace que ambos casos sean ruidosos y accionables.

**Qué ocurre tras un cambio de modelo:**

1. En el siguiente arranque (o chequeo de salud), la identidad esperada registrada por
   el almacén ya no coincide con la configuración activa. El componente de salud
   `embedding` se degrada con un mensaje que nombra ambas identidades, y se registra
   una advertencia estructurada `embedding_identity_mismatch`.
2. Mientras `embedding.refuse_writes_on_model_mismatch` sea `true` (por defecto),
   las escrituras que producen vectores (remember, re-embeddings disparados por
   tags, reconciliación de restauración) fallan con un error `CONFLICT` accionable
   que nombra la ruta de re-embedding. Las lecturas siguen funcionando — recall y
   search siguen sirviendo los vectores antiguos, solo con salud degradada.
3. Ejecute la migración:

   ```bash
   bhgbrain repair --re-embed              # migrar filas con marca obsoleta
   bhgbrain repair --re-embed --dry-run    # previsualizar cuántas filas se re-embeberían
   bhgbrain repair --re-embed --include-legacy   # incluir también filas sin marca alguna
   ```

   O mediante la herramienta MCP `repair` con `mode: "re-embed"` (ver
   [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp)). La migración
   re-embebe las memorias no coincidentes en lotes acotados y reanudables — la
   propia marca es el marcador de progreso, por lo que una ejecución interrumpida
   se reanuda sin repetir filas ya completadas, y el fallo de un solo
   embed/upsert se aísla en lugar de abortar todo el lote.
4. Una vez que no quedan filas con marca obsoleta, la identidad esperada del
   almacén se actualiza automáticamente y la degradación de salud `embedding`
   desaparece — sin reinicio.

**Notas:**
- Las filas heredadas escritas antes del marcado de procedencia no tienen marca
  (`null`) y se tratan como "desconocidas" — se excluyen del re-embedding a menos
  que se pase `--include-legacy` / `include_legacy: true`, para que una primera
  actualización no dispare por sorpresa un re-embedding completo del corpus (y su
  coste de API de embedding).
- El re-embedding siempre lo inicia el operador — nunca se dispara
  automáticamente, porque llama a la API de pago de embeddings una vez por cada
  memoria migrada.
- Configure `embedding.refuse_writes_on_model_mismatch` en `false` solo si desea
  intencionadamente que las escrituras continúen mezclando espacios de embedding
  (p. ej. una ventana de migración deliberada y monitorizada) — la marca sigue
  registrando lo que ocurrió.
- Las memorias archivadas nunca se re-embeben; sus vectores ya se eliminaron por
  diseño (ver [Decaimiento, Limpieza y Archivado](#decaimiento-limpieza-y-archivado)).

### Ejemplo de Configuración Multi-Dispositivo

**Dispositivo A** (`config.json`):
```jsonc
{
  "device": { "id": "workstation" },
  "qdrant": {
    "mode": "external",
    "external_url": "https://your-cluster.cloud.qdrant.io",
    "api_key_env": "QDRANT_API_KEY"
  }
}
```

**Dispositivo B** (`config.json`):
```jsonc
{
  "device": { "id": "cloud-pc" },
  "qdrant": {
    "mode": "external",
    "external_url": "https://your-cluster.cloud.qdrant.io",
    "api_key_env": "QDRANT_API_KEY"
  }
}
```

Ambos apuntan al mismo clúster de Qdrant. Cada uno obtiene su propio `device_id`. Todas las memorias fluyen a las mismas colecciones de vectores y son visibles para ambas instancias.

---

## Gestión de Memorias

Esta sección describe el ciclo de vida completo de las memorias — desde la ingesta hasta la clasificación, deduplicación, seguimiento de accesos, promoción, decaimiento y eventual expiración o retención permanente.

### Modelo de Datos de Memoria

Cada memoria almacenada en BHGBrain es un `MemoryRecord` con los siguientes campos:

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `string (UUID)` | Identificador único global |
| `namespace` | `string` | Namespace de alcance (p.ej., `"global"`, `"project/alpha"`, `"user/kevin"`) |
| `collection` | `string` | Sub-agrupación dentro de un namespace (p.ej., `"general"`, `"architecture"`, `"decisions"`) |
| `type` | `"episodic" \| "semantic" \| "procedural"` | Tipo de memoria (ver Tipos de Memoria) |
| `category` | `string \| null` | Nombre de categoría si esta memoria está adjunta a una categoría de política persistente |
| `content` | `string` | El contenido completo de la memoria (hasta 100.000 caracteres) |
| `summary` | `string` | Resumen de la primera línea generado automáticamente (hasta 120 caracteres) |
| `tags` | `string[]` | Etiquetas de forma libre (alfanumérico + guiones, máx. 20 etiquetas, máx. 100 chars cada una) |
| `source` | `"cli" \| "api" \| "agent" \| "import"` | Cómo se creó la memoria |
| `checksum` | `string` | Hash SHA-256 del contenido normalizado (usado para deduplicación exacta) |
| `embedding` | `number[]` | Embedding vectorial (no almacenado en SQLite; vive en Qdrant) |
| `importance` | `number (0–1)` | Puntuación de importancia (por defecto 0.5) |
| `retention_tier` | `"T0" \| "T1" \| "T2" \| "T3"` | Nivel del ciclo de vida que gobierna el TTL y el comportamiento de limpieza |
| `expires_at` | `string (ISO 8601) \| null` | Marca de tiempo de expiración (null para T0 — nunca expira) |
| `decay_eligible` | `boolean` | Si la memoria participa en la limpieza por TTL (false para T0) |
| `review_due` | `string (ISO 8601) \| null` | Fecha de revisión T1 (establecida en created_at + 365 días; se restablece en el acceso) |
| `access_count` | `number` | Número de veces que esta memoria ha sido recuperada |
| `last_accessed` | `string (ISO 8601)` | Marca de tiempo de la recuperación más reciente |
| `last_operation` | `"ADD" \| "UPDATE" \| "DELETE" \| "NOOP"` | Operación de escritura más reciente aplicada |
| `merged_from` | `string \| null` | ID de la memoria desde la que se fusionó esta (ruta UPDATE de dedup) |
| `archived` | `boolean` | Si esta memoria está archivada de forma flexible (excluida de búsqueda/recall) |
| `vector_synced` | `boolean` | Si el vector de Qdrant está sincronizado con el estado de SQLite |
| `device_id` | `string \| null` | Identificador de la instancia de BHGBrain que creó esta memoria (ver [Memoria Multi-Dispositivo](#memoria-multi-dispositivo)) |
| `created_at` | `string (ISO 8601)` | Marca de tiempo de creación |
| `updated_at` | `string (ISO 8601)` | Marca de tiempo de la última actualización |
| `last_accessed` | `string (ISO 8601)` | Marca de tiempo de la última recuperación |

#### Esquema SQLite

La tabla `memories` tiene índices exhaustivos para un filtrado eficiente:

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

#### Índices de Payload de Qdrant

Cada colección de Qdrant mantiene los siguientes índices de payload para un filtrado eficiente en el lado vectorial:

- `namespace` (keyword)
- `type` (keyword)
- `retention_tier` (keyword)
- `decay_eligible` (boolean)
- `expires_at` (integer — almacenado como segundos de época Unix)
- `device_id` (keyword)

---

### Tipos de Memoria

Cada memoria se clasifica en uno de tres tipos semánticos. El tipo se usa para filtrar en recall y búsqueda, e influye en el nivel de retención predeterminado asignado durante la ingesta.

| Tipo | Significado | Contenido Típico | Nivel Predeterminado |
|---|---|---|---|
| `episodic` | Un evento, observación u ocurrencia específica en un momento del tiempo | Resultados de reuniones, sesiones de depuración, contexto de tareas, lo que ocurrió durante un sprint | `T2` (operacional) |
| `semantic` | Un hecho, concepto o pieza de conocimiento no vinculada a un momento específico | Cómo funciona un sistema, qué significa un término, un valor de configuración, un modelo de datos | `T2` (operacional) |
| `procedural` | Un proceso, flujo de trabajo o instrucción de cómo hacer algo | Runbooks, pasos de despliegue, estándares de codificación, cómo realizar una tarea | `T1` (institucional) |

**Cómo el tipo afecta la asignación de nivel:**
- `source: agent` + `type: procedural` → auto-asignado `T1` (institucional)
- `source: agent` + `type: episodic` → auto-asignado `T2` (operacional)
- `source: cli` (cualquier tipo) → auto-asignado `T2` (operacional)
- `source: import` con señales de contenido T0 → `T0` independientemente del tipo

Si no proporcionas un tipo, el pipeline usa `"semantic"` por defecto.

---

### Namespaces y Colecciones

Los **namespaces** son identificadores de alcance de nivel superior que aíslan memorias de diferentes contextos, usuarios o proyectos. Todas las operaciones de herramientas requieren un namespace (por defecto: `"global"`).

- Patrón de namespace: `^[a-zA-Z0-9/-]{1,200}$` — caracteres alfanuméricos, guiones y barras diagonales
- Ejemplos: `"global"`, `"project/alpha"`, `"user/kevin"`, `"tenant/acme-corp"`
- Las memorias en diferentes namespaces nunca se devuelven en las búsquedas de los demás
- Cada par namespace+colección se mapea a una colección separada de Qdrant (llamada `bhgbrain_{namespace}_{collection}`)

Las **colecciones** son sub-grupos dentro de un namespace. Te permiten particionar memorias por tema o propósito sin crear namespaces completamente separados.

- Patrón de colección: `^[a-zA-Z0-9-]{1,100}$`
- Ejemplos: `"general"`, `"architecture"`, `"decisions"`, `"onboarding"`
- Las colecciones se rastrean en la tabla SQLite `collections` con su modelo de embedding y dimensiones bloqueados al momento de la creación — no puedes mezclar modelos de embedding dentro de una colección
- Usa la herramienta MCP `collections` para listar, crear o eliminar colecciones

**Garantías de aislamiento:**
- Las consultas SQLite siempre filtran primero por `namespace`
- Las búsquedas de Qdrant incluyen un filtro de payload `namespace` incluso al buscar en una colección específica
- Eliminar una colección elimina todas las memorias asociadas tanto de SQLite como de Qdrant

---

### Niveles de Retención

A cada memoria se le asigna un **nivel de retención** en el momento de la ingesta que gobierna todo su ciclo de vida — cuánto tiempo vive, cómo se limpia, qué tan estrictamente se deduplica y si alguna vez expira.

| Nivel | Etiqueta | TTL Predeterminado | Elegible para Decaimiento | Ejemplos |
|---|---|---|---|---|
| `T0` | **Fundacional** | Nunca (permanente) | No | Referencias de arquitectura, requisitos legales, políticas de empresa, mandatos de cumplimiento, estándares contables, ADRs, runbooks de seguridad |
| `T1` | **Institucional** | 365 días desde el último acceso | Sí (con seguimiento de review_due) | Decisiones de diseño de software, contratos de API, runbooks de despliegue, estándares de codificación, acuerdos con proveedores, conocimiento procedimental |
| `T2` | **Operacional** | 90 días desde el último acceso | Sí | Estado del proyecto, decisiones de sprint, resultados de reuniones, investigaciones técnicas, contexto de tareas actuales |
| `T3` | **Transitorio** | 30 días desde el último acceso | Sí | Tickets de soporte, resúmenes de correos, informes diarios, sesiones de depuración ad-hoc, notas de tareas de corta duración |

**Propiedades clave por nivel:**

- **T0**: `expires_at` es siempre `null`. `decay_eligible` es siempre `false`. Las memorias T0 no pueden ser limpiadas automáticamente. Las actualizaciones a memorias T0 desencadenan una instantánea de revisión en la tabla `memory_revisions` (historial de solo adición). Las memorias T0 nunca decaen en el ranking compuesto (`decay_per_day.T0` es `0` por defecto), lo que les da una ventaja de ranking duradera en todos los modos de búsqueda.

- **T1**: `review_due` se establece en `created_at + 365 días` y se restablece en cada acceso. Las memorias que se acercan a su `expires_at` se marcan con `expiring_soon: true` en los resultados de búsqueda.

- **T2**: El nivel predeterminado para la mayoría de las memorias. Ventana deslizante de 90 días — cada acceso restablece el reloj de TTL.

- **T3**: El nivel más agresivo. El contenido transitorio identificado por patrones (tickets, correos, notas de standup) se clasifica automáticamente aquí. Ventana deslizante de 30 días.

**Presupuestos de capacidad:**

| Nivel | Presupuesto Predeterminado | Notas |
|---|---|---|
| T0 | Ilimitado | El conocimiento fundacional debe caber siempre |
| T1 | 100.000 | Conocimiento institucional |
| T2 | 200.000 | Memorias operacionales |
| T3 | 200.000 | Memorias transitorias |

Cuando se supera el presupuesto de un nivel, el endpoint de salud informa `degraded` y el trabajo de limpieza prioriza ese nivel en el siguiente ciclo.

---

### Ciclo de Vida por Nivel — Asignación, Promoción, Ventana Deslizante

#### Asignación de Nivel

La asignación de nivel ocurre durante el pipeline de escritura, en este orden de prioridad:

1. **Anulación explícita del llamador:** Si se pasa `retention_tier` a la herramienta `remember`, se usa incondicionalmente.

2. **Basado en categoría:** Si la memoria está adjunta a una categoría (vía el campo `category`), siempre es `T0`. Las categorías representan slots de política persistente y nunca expiran.

3. **Heurísticas de fuente + tipo:**
   - `source: agent` + `type: procedural` → `T1`
   - `source: agent` + `type: episodic` → `T2`
   - `source: cli` → `T2`

4. **Coincidencia de patrones de contenido para señales transitorias (→ T3):**
   - Referencias de Jira/tickets: `JIRA-1234`, `incident-456`, `case-789`
   - Metadatos de correo: `From:`, `Subject:`, `fw:`, `re:`
   - Marcadores temporales: `today`, `this week`, `by friday`, `standup`, `meeting minutes`, `action items`
   - Referencias de trimestre: `Q1 2026`, `Q3 2025`

5. **Señales de palabras clave T0 (→ T0 para importaciones):**
   Si `source: import` y el contenido o las etiquetas contienen cualquiera de:
   `architecture`, `design decision`, `adr`, `rfc`, `contract`, `schema`, `legal`, `compliance`, `policy`, `standard`, `accounting`, `security`, `runbook`
   → asignado `T0`.

6. **Señales de palabras clave T0 (→ T0 para cualquier fuente):**
   Se verifican las mismas palabras clave T0 para todas las fuentes (primero se verifican los patrones transitorios T3). Si una palabra clave T0 coincide sin un patrón transitorio, la memoria es `T0`.

7. **Predeterminado:** `T2` — el predeterminado seguro y tolerante.

```mermaid
flowchart TD
    START["Memory Ingested"] --> Q1{"Explicit<br/>retention_tier<br/>provided?"}
    Q1 -->|Yes| USE["Use provided tier"]
    Q1 -->|No| Q2{"Has category?"}
    Q2 -->|Yes| T0A["T0 — Foundational"]
    Q2 -->|No| Q3{"source:agent +<br/>type:procedural?"}
    Q3 -->|Yes| T1A["T1 — Institutional"]
    Q3 -->|No| Q4{"source:agent +<br/>type:episodic?"}
    Q4 -->|Yes| T2A["T2 — Operational"]
    Q4 -->|No| Q5{"Transient pattern<br/>match?<br/><i>JIRA-1234, From:, standup...</i>"}
    Q5 -->|Yes| T3A["T3 — Transient"]
    Q5 -->|No| Q6{"T0 keyword<br/>match?<br/><i>architecture, compliance...</i>"}
    Q6 -->|Yes| T0B["T0 — Foundational"]
    Q6 -->|No| T2B["T2 — Default"]

    classDef t0 fill:#dc3545,stroke:#a71d2a,color:#fff
    classDef t1 fill:#e8a838,stroke:#b8841c,color:#fff
    classDef t2 fill:#4a90d9,stroke:#2c5f8a,color:#fff
    classDef t3 fill:#6c757d,stroke:#495057,color:#fff
    classDef decision fill:#f0f4f8,stroke:#4a90d9,color:#333

    class T0A,T0B t0
    class T1A t1
    class T2A,T2B,USE t2
    class T3A t3
```

#### Metadatos de Nivel Calculados en la Asignación

```typescript
{
  retention_tier: "T2",               // nivel asignado
  expires_at: "2026-06-14T12:00:00Z", // created_at + días TTL
  decay_eligible: true,               // false solo para T0
  review_due: null                    // establecido solo para T1
}
```

Para memorias T1, `review_due` se establece en `created_at + tier_ttl.T1` (365 días por defecto) y se restablece en cada recuperación.

#### Auto-Promoción por Acceso

Cuando una memoria en el nivel `T2` o `T3` alcanza el umbral de acceso (`auto_promote_access_threshold`, por defecto 5), se promueve automáticamente un nivel:

- `T3` → `T2`
- `T2` → `T1`

La promoción no puede ocurrir automáticamente a `T0`. La actualización manual a `T0` es posible pasando `retention_tier: "T0"` en una llamada `remember` posterior (lo que desencadena la ruta UPDATE) o vía el comando CLI `bhgbrain tier set <id> T0`.

La promoción es **monotónica** — la degradación automática nunca ocurre. La degradación de nivel requiere acción explícita del usuario.

Cuando se promueve una memoria, su `expires_at` se recalcula desde el TTL del nuevo nivel usando la marca de tiempo actual como ancla de la ventana deslizante.

```mermaid
stateDiagram-v2
    [*] --> T3: New memory<br/>assigned T3

    T3: T3 — Transient<br/>TTL: 30 days
    T2: T2 — Operational<br/>TTL: 90 days
    T1: T1 — Institutional<br/>TTL: 365 days
    T0: T0 — Foundational<br/>TTL: ∞ (never)

    T3 --> T2: Auto-promote<br/>(5 accesses)
    T2 --> T1: Auto-promote<br/>(5 accesses)
    T1 --> T0: Manual only<br/>(explicit tier set)

    T3 --> Expired: TTL exceeded<br/>(no access in 30d)
    T2 --> Expired: TTL exceeded<br/>(no access in 90d)
    T1 --> Expired: TTL exceeded<br/>(no access in 365d)

    T3 --> T3: Access resets<br/>sliding window
    T2 --> T2: Access resets<br/>sliding window
    T1 --> T1: Access resets<br/>sliding window

    Expired --> Archive: archive_before_delete<br/>= true
    Expired --> Deleted: archive_before_delete<br/>= false
    Archive --> Deleted: Cleanup cycle

    [*] --> T2: Default assignment
    [*] --> T0: Category or<br/>explicit T0
    [*] --> T1: agent + procedural
```

#### Expiración con Ventana Deslizante

Cuando `sliding_window_enabled: true` (el valor predeterminado), cada recuperación exitosa vía `recall`, `search` o `memory://inject` restablece el reloj de TTL:

```
new expires_at = max(current expires_at, now + tier_ttl)
```

Esto significa que una memoria en uso activo nunca expira, mientras que una memoria que nunca es recuperada alcanza su TTL y se limpia. Las memorias a las que se accede una vez en el último momento reciben una ventana TTL completamente nueva desde ese acceso.

El seguimiento de accesos se realiza en lote después de cada búsqueda (volcado diferido de hasta 5 segundos) para evitar escrituras síncronas en la base de datos en la ruta de lectura.

---

### Deduplicación

BHGBrain evita almacenar contenido duplicado o casi duplicado mediante un pipeline de deduplicación en dos fases.

```mermaid
flowchart TD
    A["Incoming Content"] --> B["Content Normalization<br/><i>strip controls, collapse blanks</i>"]
    B --> C{"Secret Detected?"}
    C -->|Yes| REJECT["❌ REJECT<br/>INVALID_INPUT"]
    C -->|No| D["SHA-256 Checksum"]
    D --> E{"Exact Match<br/>in namespace?"}
    E -->|Yes| NOOP1["🔄 NOOP<br/>Return existing ID"]
    E -->|No| F["Embed Content<br/><i>OpenAI text-embedding-3-small</i>"]
    F --> G["Semantic Dedup<br/>Top-10 similarity search"]
    G --> H{"Highest Cosine<br/>Similarity Score"}
    H -->|"score ≥ noop threshold"| NOOP2["🔄 NOOP<br/>Near-duplicate found"]
    H -->|"score ≥ update threshold"| UPD["✏️ UPDATE Path"]
    H -->|"score < update threshold"| ADD["➕ ADD Path"]

    UPD --> U1["Merge tags (union)"]
    U1 --> U2["Replace content"]
    U2 --> U3["importance = max(old, new)"]
    U3 --> U4["SQLite UPDATE"]
    U4 --> U5["Qdrant Upsert"]

    ADD --> A1["Tier Assignment"]
    A1 --> A2["SQLite INSERT"]
    A2 --> A3["Qdrant Upsert"]

    classDef reject fill:#dc3545,stroke:#a71d2a,color:#fff
    classDef noop fill:#6c757d,stroke:#495057,color:#fff
    classDef update fill:#e8a838,stroke:#b8841c,color:#fff
    classDef add fill:#5ba85b,stroke:#3d7a3d,color:#fff
    classDef process fill:#4a90d9,stroke:#2c5f8a,color:#fff

    class REJECT reject
    class NOOP1,NOOP2 noop
    class UPD,U1,U2,U3,U4,U5 update
    class ADD,A1,A2,A3 add
    class A,B,C,D,E,F,G,H process
```

#### Fase 1: Deduplicación Exacta (Checksum)

Antes de generar cualquier embedding, el contenido normalizado se hashea con SHA-256. Si ya existe una memoria con el mismo namespace y checksum (y no está archivada), la operación devuelve `NOOP` inmediatamente sin ninguna llamada a la API.

```
checksum = SHA-256(normalizeContent(content))
```

#### Fase 2: Deduplicación Semántica (Similitud Vectorial)

Si no se encuentra ninguna coincidencia exacta, el contenido se embede y se recuperan de Qdrant las 10 memorias existentes más similares en la colección. Basándose en las puntuaciones de similitud coseno y el nivel asignado a la memoria, se toma una de cuatro decisiones:

| Decisión | Condición | Efecto |
|---|---|---|
| `NOOP` | Puntuación ≥ umbral noop | El contenido se considera un duplicado; devuelve el ID de la memoria existente sin escribir |
| `DELETE` | Puntuación ≥ umbral update **y** el contenido invalida explícitamente la coincidencia (p. ej. "ya no es cierto", "corrección:", "olvida eso") | La memoria existente se elimina y el candidato se guarda como una nueva memoria que la referencia mediante `merged_from` |
| `UPDATE` | Puntuación ≥ umbral update | El contenido es una actualización del existente; fusiona etiquetas, actualiza contenido y checksum, preserva el ID |
| `ADD` | Puntuación < umbral update | Memoria genuinamente nueva; crea con un nuevo UUID |

El diagrama anterior muestra las rutas NOOP/UPDATE/ADD; DELETE es una variante de la ruta UPDATE que solo se toma cuando se activa la heurística de invalidación.

**Umbrales de deduplicación específicos por nivel:**

El `similarity_threshold` base (por defecto 0.92) se ajusta por nivel porque las memorias T0/T1 requieren coincidencias más estrictas (los casi-duplicados pueden representar versionado intencional), y T3 es más agresivo:

| Nivel | Umbral NOOP | Umbral UPDATE |
|---|---|---|
| `T0` | 0.98 | max(base, 0.95) |
| `T1` | 0.98 | max(base, 0.95) |
| `T2` | 0.98 | base (0.92) |
| `T3` | 0.95 | max(base, 0.90) |

**Comportamiento de fusión en UPDATE:**
- Las etiquetas se unen (etiquetas existentes ∪ etiquetas nuevas)
- El contenido se reemplaza con la nueva versión
- La importancia se establece en `max(importancia existente, importancia nueva)`
- El nivel de retención y la expiración se recalculan desde la clasificación del nuevo contenido

**Comportamiento de reserva:**
Si el proveedor de embeddings no está disponible y `pipeline.fallback_to_threshold_dedup: true`, el pipeline pasa a una ruta de deduplicación sin vectores en lugar de fallar la escritura. Las coincidencias exactas de checksum siguen resolviéndose directamente como `NOOP`, igual que en la Fase 1. Para el resto, el pipeline usa la búsqueda de texto completo de SQLite sobre el mismo namespace/colección para encontrar la memoria existente más cercana y la puntúa con una similitud determinista de solapamiento de palabras (no la puntuación coseno vectorial); en o por encima del umbral `update` el contenido se fusiona en esa memoria (`UPDATE`, con `vector_synced: false`), de lo contrario se escribe como una nueva memoria solo en SQLite (`ADD`, `vector_synced: false`). En cualquier caso, la memoria estará disponible para búsqueda de texto completo pero no para búsqueda semántica hasta que se restaure la sincronización con Qdrant, y entrar en esta ruta registra una advertencia estructurada `degraded_write`.

---

### Normalización de Contenido

Antes de calcular el checksum, embeder o almacenar, todo el contenido pasa por el pipeline de normalización:

1. **Eliminación de caracteres de control:** Los caracteres de control ASCII (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F) se eliminan. El salto de línea (0x0A) y el retorno de carro (0x0D) se preservan.

2. **Normalización CRLF:** `\r\n` → `\n`

3. **Eliminación de espacios en blanco al final de línea:** Los espacios y tabulaciones al final de las líneas se eliminan.

4. **Colapso de líneas en blanco excesivas:** Tres o más saltos de línea consecutivos se colapsan a dos.

5. **Recorte de espacios en blanco iniciales/finales:** La cadena completa se recorta.

6. **Detección de secretos:** Antes del almacenamiento, el contenido se verifica contra patrones para formatos comunes de credenciales:
   - `api_key=...`, `secret=...`, `token=...`, `password=...`
   - IDs de clave de acceso AWS (`AKIA...`)
   - Tokens de acceso personal de GitHub (`ghp_...`)
   - Claves API de OpenAI (`sk-...`)
   - Claves privadas PEM (`-----BEGIN ... PRIVATE KEY-----`)

   Si se detecta un secreto, la escritura es **rechazada** con `INVALID_INPUT`:
   > `Content appears to contain credentials or secrets. Memory rejected for safety.`

7. **Generación de resumen:** La primera línea del contenido normalizado se extrae como resumen (truncado a 120 caracteres con `...` si es más larga). El resumen se almacena en SQLite y se usa para visualización ligera sin recuperar el contenido completo.

---

### Puntuación de Importancia

Cada memoria tiene un campo `importance` — un float de 0.0 a 1.0.

**Predeterminado:** `0.5` si no lo proporciona el llamador.

**Cómo se usa:**
- Durante las fusiones UPDATE de deduplicación, la importancia se establece en `max(existente, nueva)` — la importancia solo aumenta a través de fusiones.
- Los candidatos a memorias obsoletas (marcados por el paso de consolidación) deben tener `importance < 0.5` y sin categoría para ser elegibles para el paso de marcado de obsolescencia. Esto protege las memorias de alta importancia de ser marcadas como obsoletas.
- La extracción futura basada en LLM puede asignar importancia basándose en el análisis del contenido.

**Configuración de importancia:**
Pasa `importance` explícitamente en la herramienta `remember`. Los valores van de `0.0` (valor muy bajo, debe decaer agresivamente) a `1.0` (crítico, debe preservarse).

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

### Categorías — Slots de Política Persistente

Las categorías son un mecanismo de almacenamiento especial para contexto de política persistente, siempre inyectado. A diferencia de las memorias regulares (que se recuperan vía búsqueda semántica), el contenido de las categorías siempre se incluye en el payload del recurso `memory://inject`.

Las categorías están diseñadas para información que debe estar siempre presente en la ventana de contexto de la IA: valores de empresa, principios de arquitectura, estándares de codificación y políticas permanentes similares.

#### Slots de Categoría

Cada categoría se asigna a uno de cuatro slots con nombre:

| Slot | Propósito | Ejemplos |
|---|---|---|
| `company-values` | Principios básicos, cultura, voz de marca | "Priorizamos la seguridad sobre la velocidad", "Nunca almacenar PII en logs" |
| `architecture` | Arquitectura del sistema, topología de componentes, decisiones de diseño clave | Mapa de servicios, contratos de API, elecciones tecnológicas |
| `coding-requirements` | Estándares de codificación, convenciones, patrones requeridos | "Siempre usar async/await", "Usar Zod para toda validación", convenciones de nombres |
| `custom` | Cualquier otra cosa que justifique contexto siempre activo | Reglas específicas del proyecto, guías de desambiguación, mapas de entidades |

#### Comportamiento de las Categorías

- Las categorías son **siempre T0** — nunca expiran, nunca decaen y el sistema de retención no puede limpiarlas.
- El contenido de las categorías se almacena como texto completo en SQLite (no se embede en Qdrant).
- En el payload `memory://inject`, el contenido de las categorías se antepone antes que cualquier memoria regular.
- Las categorías admiten revisiones — cuando actualizas una categoría con `category set`, el contador `revision` se incrementa.
- Los nombres de categoría deben ser únicos. Puedes tener múltiples categorías por slot (p.ej., `"api-contracts"` y `"database-schema"` ambas en el slot `"architecture"`).
- El contenido de las categorías puede tener hasta 100.000 caracteres.

#### Gestión de Categorías

```json
// Listar todas las categorías
{ "action": "list" }

// Obtener una categoría específica
{ "action": "get", "name": "api-contracts" }

// Crear o actualizar una categoría
{
  "action": "set",
  "name": "coding-standards",
  "slot": "coding-requirements",
  "content": "## Coding Standards\n\n- Use TypeScript strict mode\n- All functions must have JSDoc comments\n- Tests required for all public APIs"
}

// Eliminar una categoría
{ "action": "delete", "name": "coding-standards" }
```

---

### Decaimiento, Limpieza y Archivado

#### Limpieza en Segundo Plano

El servidor ejecuta un trabajo de limpieza programado (por defecto: diariamente a las 2:00 AM UTC, configurable vía `retention.cleanup_schedule` como expresión cron; desactivable con `retention.scheduled_cleanup_enabled: false`). Se ejecuta por el mismo camino de código que el comando manual `bhgbrain gc`, por lo que las ejecuciones programadas y manuales se comportan de forma idéntica.

**Fases de limpieza:**

1. **Identificar memorias expiradas:** Consultar SQLite para todas las memorias donde `decay_eligible = true` Y `expires_at < now()`. Solo `T2`/`T3` son elegibles para archivar-y-eliminar directamente:
   - `T0` siempre se excluye (T0 nunca es elegible para decaimiento).
   - `T1` nunca se elimina directamente. Las memorias `T1` expiradas o con `review_due` vencido se muestran como **candidatas de revisión** en el resultado de GC, para que un operador decida si promoverlas, volver a guardarlas o eliminarlas manualmente — o, vía MCP, listarlas y disposicionarlas con la herramienta `review` (`action: "list"` / `"keep"` / `"archive"`; ver [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp)).

2. **Archivar antes de eliminar (si está habilitado):** Para cada candidata `T2`/`T3`, se escribe un registro de resumen en la tabla `memory_archive` y se registra un evento de auditoría `ARCHIVE` distinto:

   ```sql
   memory_archive {
     id            INTEGER (autoincrement)
     memory_id     TEXT    -- UUID de la memoria original
     summary       TEXT    -- el texto de resumen de la memoria
     tier          TEXT    -- nivel en el que estaba cuando se eliminó
     namespace     TEXT    -- namespace al que pertenecía
     created_at    TEXT    -- marca de tiempo de creación original
     expired_at    TEXT    -- cuando se ejecutó la limpieza
     access_count  INTEGER -- total de accesos durante su vida útil
     tags          TEXT    -- array JSON de etiquetas
   }
   ```

   Si el archivado de una memoria falla, esa memoria se omite de la eliminación (nunca se elimina sin un registro de archivo duradero cuando el archivado está habilitado) y la ejecución se reporta como degradada en lugar de abortar o lanzar un error.

3. **Eliminar de Qdrant:** Eliminar en lote todos los IDs de puntos expirados de sus respectivas colecciones de Qdrant.

4. **Eliminar de SQLite:** Eliminar filas expiradas de las tablas `memories` y `memories_fts`.

5. **Log de auditoría:** Cada eliminación confirmada se registra en la tabla `audit_log` con `operation: FORGET` y `client_id: "system"`. El archivado, la promoción, la revisión T0 y la restauración de archivo obtienen cada uno su propio código de operación distinto (`ARCHIVE`, `PROMOTE`, `REVISE`, `RESTORE`) en lugar de mezclarse en entradas genéricas `ADD`/`UPDATE`/`FORGET` — cada evento de transición de ciclo de vida lleva en la columna `details` una carga JSON `{memory_id, prior_tier, new_tier, actor, timestamp, action}`.

6. **Compactación (dirigida por umbral, no por eliminación):** Para cada par namespace/colección del que esta ejecución eliminó memorias, una vez que la proporción de vectores eliminados supera `retention.compaction_deleted_threshold`, la ejecución impulsa al optimizador de segmentos de Qdrant a recuperar espacio vía `optimizers_config.deleted_threshold`.

7. **Volcado:** SQLite se vuelca atómicamente a disco después de todas las eliminaciones.

8. **Señal de salud:** Si algún paso de archivado o eliminación falla a mitad de camino, el resultado de la ejecución se persiste y aparece como un componente `retention` degradado en `health://status` hasta la próxima ejecución de GC limpia.

Una ejecución de GC — manual o programada — nunca lanza un error a quien la invoca: los fallos inesperados se capturan, el bloqueo de ciclo de vida en curso siempre se libera, y el resultado se reporta como `degraded: true` con el trabajo ya completado intacto.

#### Historial de Revisiones T0

Cuando se actualiza una memoria T0 (fundacional) vía la herramienta `remember` (desencadenando la ruta de dedup UPDATE), el contenido anterior se captura en la tabla `memory_revisions` antes de aplicar la actualización:

```sql
memory_revisions {
  id         INTEGER (autoincrement)
  memory_id  TEXT    -- el UUID de la memoria T0
  revision   INTEGER -- número de revisión incremental
  content    TEXT    -- contenido previo completo
  updated_at TEXT    -- cuándo ocurrió la actualización
  updated_by TEXT    -- client_id que realizó la actualización
}
```

Solo las memorias T0 tienen historial de revisiones. El embedding vectorial en Qdrant siempre refleja solo el contenido actual.

El historial de revisiones se puede leer con la herramienta `revisions` (`action: "list"`) o el recurso `memory://{id}/revisions`, más reciente primero. `revisions` (`action: "revert"`) restaura el contenido de una memoria a una revisión anterior elegida — re-generando el embedding, re-insertando el vector, y anexando (sin reescribir) el propio revert como una nueva entrada del historial — y registra un evento de auditoría `REVISE` con la revisión de origen. Vea [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp) y [Recursos MCP](#recursos-mcp).

#### Marcado de Obsolescencia (Paso de Consolidación)

El comando `bhgbrain gc --consolidate` (o `RetentionService.runConsolidation()`) realiza un segundo paso que marca memorias como candidatas **obsoletas**:

- Cualquier memoria a la que no se haya accedido en los últimos `retention.decay_after_days` (por defecto 180) días se marca como candidata obsoleta.
- Solo las memorias con `importance < 0.5` y sin categoría son elegibles.
- Las memorias obsoletas no se eliminan inmediatamente; se convierten en candidatas para el siguiente ciclo de limpieza GC.

#### Búsqueda y Restauración de Archivo

Las memorias eliminadas (cuando `archive_before_delete: true`) pueden inspeccionarse y restaurarse desde la CLI:

```bash
bhgbrain archive list                 # Listar resúmenes de memorias archivadas (eliminadas)
bhgbrain archive search <query>       # Buscar en el archivo por texto
bhgbrain archive restore <memory_id>  # Restaurar una memoria archivada
```

**Semántica de restauración:** Una memoria restaurada se recrea como una **nueva** memoria (en su nivel original) a partir del texto de resumen archivado. El contenido original (si es más largo que el resumen) no puede recuperarse — el archivo almacena solo el resumen de 120 caracteres. La memoria restaurada recibe marcas de tiempo nuevas y un nuevo UUID, y se re-embede en Qdrant. El `archive restore` de la CLI además elimina la fila de archivo tras restaurar.

Los clientes MCP tienen una ruta equivalente: el parámetro `include_archived` de la herramienta `search` encuentra memorias archivadas por coincidencia de términos en resumen/etiquetas (marcadas con `archived: true`, nunca registradas como acceso), y la acción `restore` de la herramienta `review` recrea una memoria activa a partir de un registro archivado — etiquetada como `restored-from-archive`, con la fila de archivo **conservada** (a diferencia de la ruta de la CLI) para que su origen siga siendo inspeccionable. Vea [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp).

---

### Advertencias de Expiración Anticipada

Las memorias que se acercan a la expiración (dentro de `retention.pre_expiry_warning_days` días, por defecto 7) se marcan en los resultados de búsqueda:

```json
{
  "id": "...",
  "content": "...",
  "retention_tier": "T2",
  "expires_at": "2026-03-22T12:00:00Z",
  "expiring_soon": true
}
```

El indicador `expiring_soon` aparece en:
- Resultados de `recall`
- Resultados de `search`
- El payload del recurso `memory://inject`

Esto permite a los agentes de IA notar cuándo las memorias están a punto de expirar y decidir si promoverlas (re-guardando con un `retention_tier: "T1"` o `"T0"` explícito).

---

### Límites de Recursos y Presupuestos de Capacidad

BHGBrain monitoriza la capacidad y muestra advertencias a través del sistema de salud:

| Límite | Clave de Config | Predeterminado | Comportamiento al excederse |
|---|---|---|---|
| Máximo de memorias totales | `retention.max_memories` | 500.000 | El estado de salud informa `degraded`; el trabajo de limpieza prioriza la limpieza |
| Tamaño máximo de BD | `retention.max_db_size_gb` | 2 GB | El estado de salud informa `degraded` (monitorizado, no aplicado) |
| Umbral de advertencia | `retention.warn_at_percent` | 80% | El estado de salud informa `degraded` cuando `count > max_memories * 0.8` |
| Presupuesto T1 | `retention.tier_budgets.T1` | 100.000 | El estado de salud informa `over_capacity: true`; el componente de retención se degrada |
| Presupuesto T2 | `retention.tier_budgets.T2` | 200.000 | Igual |
| Presupuesto T3 | `retention.tier_budgets.T3` | 200.000 | Igual |

T0 no tiene presupuesto de capacidad. El conocimiento fundacional siempre debe preservarse.

El campo `retention.over_capacity` del endpoint de salud es `true` si se supera cualquier presupuesto configurado. El objeto `retention.counts_by_tier` muestra el recuento actual en cada nivel, que puedes comparar con tus presupuestos configurados.

---

## Búsqueda

BHGBrain admite tres modos de búsqueda que pueden usarse de forma independiente o combinada.

### Búsqueda Semántica

La búsqueda semántica usa embeddings de OpenAI y similitud vectorial de Qdrant (distancia coseno) para encontrar memorias conceptualmente similares a la consulta — incluso si usan palabras diferentes.

**Cómo funciona:**
1. La cadena de consulta se embede usando el mismo modelo que las memorias almacenadas (`text-embedding-3-small`, 1536 dimensiones).
2. Se consulta a Qdrant por los vecinos más cercanos en la colección objetivo.
3. Qdrant aplica filtros de payload para excluir memorias expiradas: solo se devuelven memorias donde `decay_eligible = false` (T0/T1) O `expires_at > now()`.
4. Los resultados se ordenan por puntuación de similitud coseno (0.0–1.0, mayor es más similar).
5. Los metadatos de acceso se actualizan para cada memoria devuelta (access_count++, last_accessed, restablecimiento de expiración de ventana deslizante).

**Cuándo usar:** Consultas conceptuales, preguntas sobre cómo funciona algo, recuperar decisiones arquitectónicas sin conocer palabras clave exactas.

**Requisitos:** Requiere que el proveedor de embeddings esté en buen estado. Devuelve el error `EMBEDDING_UNAVAILABLE` si OpenAI no es accesible.

```json
// Búsqueda semántica vía la herramienta search
{
  "query": "how does authentication work",
  "mode": "semantic",
  "namespace": "global",
  "limit": 10
}
```

---

### Búsqueda de Texto Completo

La búsqueda de texto completo usa la coincidencia de texto interno de SQLite para encontrar memorias que contienen palabras o frases específicas.

**Cómo funciona:**
1. La consulta se divide en términos en minúsculas.
2. Cada término se compara con la tabla shadow `memories_fts` usando `LIKE %term%` en las columnas `content`, `summary` y `tags`.
3. Los resultados se ordenan por el número de términos coincidentes (más coincidencias = mayor rango).
4. El rango se normaliza a una puntuación de 0.0–1.0: `min(1.0, term_count / 10)`.
5. Las memorias archivadas se excluyen (la tabla FTS se mantiene sincronizada con la tabla principal de memorias — las filas archivadas se eliminan de FTS).
6. Los metadatos de acceso se actualizan para los resultados devueltos.

**Cuándo usar:** Búsquedas exactas de palabras clave, búsqueda de identificadores específicos (IDs de memoria, nombres de proyectos, nombres de sistemas), cuando conoces la terminología exacta utilizada.

**Requisitos:** Funciona incluso cuando el proveedor de embeddings no está disponible (no se necesita Qdrant para texto completo).

```json
// Búsqueda de texto completo vía la herramienta search
{
  "query": "JIRA-1234 authentication",
  "mode": "fulltext",
  "namespace": "global",
  "limit": 10
}
```

---

### Búsqueda Híbrida

```mermaid
flowchart TD
    Q["Search Query"] --> P1 & P2

    subgraph Semantic["Semantic Search"]
        P1["Embed Query<br/><i>OpenAI API</i>"] --> QD["Qdrant<br/>Vector Search"]
        QD --> SR["Ranked Results<br/><i>by cosine similarity</i>"]
    end

    subgraph Fulltext["Fulltext Search"]
        P2["Tokenize Query"] --> FTS["SQLite FTS<br/>LIKE matching"]
        FTS --> FR["Ranked Results<br/><i>by term count</i>"]
    end

    SR --> RRF["RRF Fusion<br/><i>semantic: 0.7 / fulltext: 0.3</i>"]
    FR --> RRF
    RRF --> RANK["Composite Ranking<br/><i>relevance x importance/access/decay prior</i>"]
    RANK --> TOP["Return Top N Results"]
    TOP --> TRACK["Update Access Tracking<br/><i>count++, sliding window reset</i>"]

    classDef search fill:#4a90d9,stroke:#2c5f8a,color:#fff
    classDef fusion fill:#8b5cf6,stroke:#6d3fc4,color:#fff
    classDef result fill:#5ba85b,stroke:#3d7a3d,color:#fff

    class P1,QD,SR,P2,FTS,FR search
    class RRF,RANK fusion
    class TOP,TRACK result
```

La búsqueda híbrida combina resultados semánticos y de texto completo usando **Reciprocal Rank Fusion (RRF)**, un algoritmo de fusión basado en rangos que es robusto a las diferencias de escala de puntuación entre los dos sistemas de recuperación.

**Cómo funciona:**
1. Tanto la búsqueda semántica como la de texto completo se ejecutan de forma independiente (en paralelo donde sea posible).
2. Cada método recupera hasta `limit * 2` candidatos.
3. La fusión RRF combina las listas ordenadas:

   ```
   RRF_score(item) = (semantic_weight / (K + semantic_rank))
                   + (fulltext_weight  / (K + fulltext_rank))
   ```
   
   Donde `K = 60` (constante RRF estándar), `semantic_weight = 0.7`, `fulltext_weight = 0.3` (configurable vía `search.hybrid_weights`).

4. Los elementos que aparecen en solo una lista reciben `0` de contribución de la otra.
5. La lista fusionada se ordena por puntuación RRF (descendente).
6. El **ranking compuesto** (ver más abajo) se aplica a los resultados de cada modo, incluida esta puntuación RRF, y la lista se reordena por la puntuación compuesta.
7. Se devuelven los `limit` resultados superiores.

**Degradación elegante:** Si el proveedor de embeddings no está disponible, la búsqueda híbrida silenciosamente recurre a resultados solo de texto completo en lugar de devolver un error.

**Cuándo usar:** Por defecto para la mayoría de las consultas — la búsqueda híbrida proporciona el mejor recall porque una memoria puede ser devuelta por coincidencia semántica aunque las palabras clave no coincidan, o por texto completo aunque el embedding esté ligeramente desviado.

```json
// Búsqueda híbrida (modo predeterminado)
{
  "query": "authentication JWT expiry",
  "mode": "hybrid",
  "namespace": "global",
  "limit": 10
}
```

---

### Ranking Compuesto

Cada modo de búsqueda (`semantic`, `fulltext`, `hybrid`) ordena sus resultados por una puntuación compuesta en lugar de solo por relevancia. La relevancia (similitud coseno, rango FTS o puntuación RRF, según el modo) se multiplica por un **prior** derivado de señales que cada memoria ya posee — `importance`, `access_count` y qué tan recientemente se actualizó — de modo que una memoria confirmada como útil muchas veces, marcada como importante, o editada recientemente supera a un duplicado obsoleto igualmente relevante.

```
final_score = relevance x (w_base + w_importance x importance + w_access x log1p(access_count) / log1p(access_norm))
                        x exp(-decay_per_day[tier] x age_days)
```

- `w_base` es fijo en `1.0` y no es configurable.
- `age_days` se mide desde `updated_at`, así que un `UPDATE` reinicia la antigüedad efectiva de una memoria — una memoria recién editada vuelve a ser "joven".
- Las memorias `T0` tienen un `decay_per_day` de `0` por defecto y por lo tanto nunca decaen, dando al conocimiento fundacional una ventaja duradera (esto reemplaza el antiguo impulso plano de `+0.1` para T0).
- La frecuencia de acceso se amortigua logarítmicamente (`log1p`) para que un puñado de accesos adicionales no pueda dominar el orden, y se normaliza mediante `access_norm` (predeterminado `50`) para que el término de acceso permanezca en una escala comparable al término de importancia.

**Configuración** (`search.ranking` en `config.json`, ver [Configuración](#configuración)):

| Campo | Predeterminado | Significado |
|---|---|---|
| `enabled` | `true` | Establecer en `false` para desactivar el ranking compuesto por completo y restaurar el orden por relevancia pura. |
| `w_importance` | `0.3` | Peso aplicado a la `importance` (0–1) de una memoria. |
| `w_access` | `0.2` | Peso aplicado al conteo de accesos amortiguado logarítmicamente. |
| `access_norm` | `50` | Normaliza el término de conteo de accesos; valores más altos requieren más accesos para alcanzar el mismo impulso. |
| `decay_per_day.T0` / `T1` / `T2` / `T3` | `0` / `0.002` / `0.008` / `0.02` | Tasa de decadencia exponencial por nivel aplicada a `age_days`. El predeterminado de `T2` da una vida media de aproximadamente 87 días, alineada con su TTL de 90 días. |

**Lo que el ranking compuesto *no* afecta:** los campos crudos `semantic_score` y `fulltext_score` de cada resultado, y el campo al que se aplica el umbral `min_score` de `recall` (`semantic_score`) — ver [Recall vs Search](#recall-vs-search--diferencias). El ranking compuesto cambia el *orden* de los resultados, nunca qué memorias superan el filtro `min_score`.

---

### Recall vs Search — Diferencias

BHGBrain expone dos herramientas para la recuperación de memorias con diferentes semánticas:

| Aspecto | `recall` | `search` |
|---|---|---|
| **Propósito principal** | Recuperar memorias más relevantes para el contexto actual | Explorar e investigar el almacén de memorias |
| **Modo de búsqueda** | Siempre semántico (similitud vectorial) | Configurable: `semantic`, `fulltext` o `hybrid` (predeterminado) |
| **Límite de resultados** | 1–20 (predeterminado 5) | 1–50 (predeterminado 10) |
| **Filtrado por puntuación** | Filtro `min_score` aplicado (predeterminado 0.6) | Sin filtro de puntuación |
| **Filtrado por tipo** | Filtro `type` opcional (`episodic`/`semantic`/`procedural`) | Sin filtro de tipo |
| **Filtrado por etiquetas** | Filtro `tags` opcional (cualquier etiqueta coincidente) | Sin filtro de etiquetas |
| **Namespace** | Requerido (predeterminado `global`) | Requerido (predeterminado `global`) |
| **Colección** | Opcional — omitir para buscar en todas las colecciones | Opcional |
| **Seguimiento de accesos** | Sí — cada recall actualiza access_count y ventana deslizante | Sí — mismo comportamiento |
| **Llamador previsto** | Agentes de IA durante la ejecución de tareas | Humanos o agentes administrativos haciendo investigación |

**Filtrado por puntuación en recall:**
El parámetro `min_score` (predeterminado 0.6) actúa como una compuerta de calidad — se aplica al campo `semantic_score` (similitud coseno), no al `score` de ranking compuesto, ya que `recall` se ejecuta en modo semántico — solo se devuelven memorias con similitud coseno ≥ 0.6. Esto previene resultados irrelevantes. Puedes reducir `min_score` para recuperar más resultados a expensas de la precisión.

```json
// Ejemplo de recall — semántico, filtrado por tipo y etiquetas
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

### Filtrado

Tanto `recall` como `search` admiten alcance por namespace y colección. `recall` además admite filtrado por tipo y etiqueta.

**Filtrado por namespace:** Siempre aplicado. Todas las búsquedas se limitan a un solo namespace. No hay búsqueda entre namespaces.

**Filtrado por colección:** Opcional. Si se omite:
- En búsqueda semántica, se busca en la colección de Qdrant `bhgbrain_{namespace}_general` (la colección predeterminada para el namespace).
- En búsqueda de texto completo, se buscan todas las memorias en el namespace independientemente de la colección.

**Filtrado por tipo (solo `recall`):** Pasa `"type": "episodic"` | `"semantic"` | `"procedural"` para restringir los resultados a un solo tipo de memoria. El filtro se empuja hacia el almacén (un filtro de payload de Qdrant en la ruta semántica, un predicado SQL en la ruta de texto completo), de modo que `limit` cuenta memorias coincidentes en lugar de gastarse en candidatos no coincidentes antes de que se aplique el filtrado. Una revalidación defensiva posterior a la recuperación sigue ejecutándose y se espera que sea un no-op en estado estable; si alguna vez elimina un resultado devuelto por el almacén, se incrementa un contador `recall_zero_after_filter` para que la inanición de filtros siga siendo observable.

**Filtrado por etiquetas (solo `recall`):** Pasa `"tags": ["auth", "security"]` para restringir los resultados a memorias que tienen al menos una de las etiquetas especificadas (coincidencia de cualquiera). Al igual que el filtrado por tipo, esto se empuja hacia el almacén en lugar de aplicarse solo después de la recuperación.

---

### Umbrales de Puntuación y Ranking Compuesto

**`min_score` (solo recall):** Una puntuación mínima de similitud coseno entre 0 y 1, aplicada específicamente al campo `semantic_score` — no al `score` de ranking compuesto — ya que `recall` fija el modo semántico y el valor predeterminado de `min_score` está calibrado para un rango de similitud coseno, no para puntuaciones RRF híbridas ni para el prior compuesto. Las memorias por debajo de este umbral se excluyen de los resultados de `recall`. Predeterminado: 0.6.

**Exclusión de memorias expiradas:** El filtro de búsqueda vectorial de Qdrant excluye memorias donde `decay_eligible = true AND expires_at < now()`. Las memorias T0/T1 (decay_eligible = false) nunca son excluidas por el filtro del lado vectorial. En el lado de SQLite, el servicio de ciclo de vida re-verifica la expiración en cualquier memoria devuelta desde el almacén de vectores.

**Ranking compuesto (todos los modos):** `score` es la relevancia multiplicada por un prior de importancia, acceso y antigüedad — ver [Ranking Compuesto](#ranking-compuesto) más arriba. Las memorias T0 (fundacionales) nunca decaen por defecto, asegurando que el contenido arquitectónicamente significativo permanezca bien clasificado de forma duradera a medida que envejece.

---

## Copia de Seguridad y Restauración

```mermaid
sequenceDiagram
    participant C as Caller
    participant S as BHGBrain Server
    participant DB as SQLite
    participant FS as Filesystem

    rect rgb(230, 245, 230)
        Note over C,FS: CREATE BACKUP
        C->>S: backup create
        S->>DB: Export full database
        DB-->>S: Raw DB bytes
        S->>S: Compute SHA-256 checksum
        S->>S: Build JSON header<br/>(version, count, checksum)
        S->>FS: Atomic write .bhgb file<br/>(write-to-temp-then-rename)
        FS-->>S: Success
        S-->>C: path, size, memory_count
    end

    rect rgb(230, 235, 250)
        Note over C,FS: RESTORE BACKUP
        C->>S: backup restore (path)
        S->>FS: Read .bhgb file
        FS-->>S: Header + DB bytes
        S->>S: Validate SHA-256 checksum
        alt Checksum mismatch
            S-->>C: ❌ INVALID_INPUT
        else Checksum valid
            S->>FS: Atomic write to data dir<br/>(write-to-temp-then-rename)
            S->>DB: Hot-reload in-memory SQLite
            S->>DB: Run schema migrations
            DB-->>S: Ready
            S-->>C: memory_count, metadata_activated: true, vector_reconciliation
        end
    end
```

### Creación de una Copia de Seguridad

```json
{ "action": "create" }
```

O vía CLI:
```bash
bhgbrain backup create
```

Las copias de seguridad capturan toda la base de datos SQLite (todas las memorias, categorías, colecciones, log de auditoría, revisiones y registros de archivo) como un único archivo `.bhgb` en el subdirectorio `backups/` de tu directorio de datos.

**Formato del archivo de copia de seguridad:**
```
[4 bytes: longitud de cabecera (UInt32LE)]
[bytes de cabecera: cabecera JSON]
[bytes restantes: exportación de base de datos SQLite]
```

La cabecera JSON contiene:
```json
{
  "version": 1,
  "memory_count": 1234,
  "checksum": "<sha256 of db data>",
  "created_at": "2026-03-15T12:00:00Z",
  "embedding_model": "text-embedding-3-small",
  "embedding_dimensions": 1536
}
```

**Lo que NO está en la copia de seguridad:**
- Los datos vectoriales de Qdrant **no** están incluidos. Después de restaurar desde una copia de seguridad, las colecciones de Qdrant deben reconstruirse re-embediendo el contenido. Hasta entonces, la búsqueda de texto completo funciona pero la búsqueda semántica no.

**Integridad de la copia de seguridad:** Un checksum SHA-256 de los datos de la base de datos se almacena en la cabecera y se verifica en la restauración. Si el archivo está corrompido, la restauración falla con `INVALID_INPUT: Backup integrity check failed`. Tras activar la base de datos restaurada, su recuento de memorias también se contrasta con `memory_count` de la cabecera; si no coinciden, la restauración falla con `INTERNAL` (registrado como `backup_restore_count_mismatch`) en lugar de devolver una respuesta exitosa sobre datos silenciosamente incorrectos.

Los **metadatos de copia de seguridad** se rastrean en la tabla SQLite `backup_metadata` para que `backup list` pueda devolver información sobre copias de seguridad históricas.

### Listado de Copias de Seguridad

```json
{ "action": "list" }
```

Devuelve:
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

### Restauración desde una Copia de Seguridad

```json
{
  "action": "restore",
  "path": "/home/user/.bhgbrain/backups/2026-03-15T12-00-00-000Z.bhgb"
}
```

**Proceso de restauración:**
1. Validar que el archivo existe y el checksum de integridad coincide.

2. Escribir atómicamente la base de datos SQLite embebida en el directorio de datos (escritura-en-temporal-luego-renombrar).
3. Recargar en caliente la base de datos SQLite en memoria desde el archivo restaurado sin reiniciar el proceso.
4. Ejecutar migraciones de esquema en la base de datos recargada para garantizar compatibilidad futura.
5. Reconciliar los vectores contra el drift real (ver abajo) y devolver `{ memory_count: <count>, metadata_activated: true, vector_reconciliation: {...} }`.

**La restauración es en vivo:** La base de datos restaurada está inmediatamente activa. No es necesario reiniciar el servidor. La respuesta incluye `metadata_activated: true` para confirmar esto.

**Comprobación del recuento de memorias tras la activación:** Dado que una copia de seguridad es una exportación byte a byte de la base de datos SQLite, el recuento de memorias tras la activación debe coincidir exactamente con `memory_count` de la cabecera. Si no coincide, la restauración lanza `INTERNAL: Backup restore integrity check failed: expected <N> memories after activation but found <M>` y registra un evento `backup_restore_count_mismatch`; la llamada no devuelve una respuesta exitosa.

**La reconciliación de vectores es solo por drift y está acotada.** La restauración no vacía y reincrusta incondicionalmente todo el corpus: compara el checksum de contenido de cada memoria restaurada con el vector ya almacenado en Qdrant y marca para reincrustación solo las memorias nuevas o cuyo contenido cambió. Si el modelo/dimensiones de embedding cambiaron desde que se creó la copia de seguridad, o el estado de Qdrant no se puede leer, la restauración recurre a una reconstrucción completa. Una vez que termina esta comprobación de drift, se libera el bloqueo del ciclo de vida de restauración — `vector_reconciliation.state` es `"reconciled"` de inmediato si nada cambió, o `"reconciling"` si la reincrustación del subconjunto con drift continúa en una tarea de fondo acotada (un timeout y un límite de lotes por pasada, con reintentos automáticos) después de que la llamada ya haya devuelto la respuesta. Consulta `health://status` (`components.vector_reconciliation`) para ver cuándo termina.

**Protección contra restauración concurrente:** Si ya hay una restauración en progreso, las solicitudes de restauración posteriores devuelven `INVALID_INPUT: Backup restore already in progress`. Ese bloqueo solo cubre la activación de metadatos y la comprobación de drift, no la reincrustación en segundo plano, así que se libera rápidamente incluso en una restauración grande.

---

## Salud y Métricas

### Endpoint de Salud

```bash
GET /health        # HTTP
# o vía CLI:
bhgbrain health
```

Devuelve un `HealthSnapshot`:

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
    "over_capacity": false,
    "cleanup_lag_seconds": 120
  }
}
```

`components.retention` también pasa a `"degraded"` (con un mensaje) cuando la última ejecución de GC — programada o manual — reportó un fallo parcial (falló un paso de archivado o eliminación), independientemente de la presión de capacidad por nivel. Vuelve a `"healthy"` en la siguiente ejecución de GC limpia.

`components.sqlite` permanece en `"healthy"` pero incluye un `message` cuando la compilación de SQLite en uso no tiene el módulo `fts5`: la búsqueda de texto completo se ejecuta con el comparador heredado basado en `LIKE` (ver [Búsqueda de texto completo](#búsqueda-de-texto-completo)) en lugar de un índice FTS5/BM25. Esto también se registra una vez al iniciar (`event: "fts5_unavailable"`).

**Lógica del estado general:**
- `unhealthy` — si SQLite o Qdrant no están en buen estado
- `degraded` — si el embedding está degradado/no disponible, O si la retención está degradada (sobre capacidad o vectores no sincronizados)
- `healthy` — todos los componentes están en buen estado

**Estados de componentes:**

| Componente | Condición saludable | Condición degradada | Condición no saludable |
|---|---|---|---|
| `sqlite` | `SELECT 1` tiene éxito | — | La consulta lanza excepción |
| `qdrant` | Una consulta vectorial acotada y de solo lectura tiene éxito (un resultado vacío o una colección que aún no existe también cuentan como saludable) | — | La consulta vectorial en sí falla, incluso con el servidor accesible |
| `embedding` | La llamada a la API de embed tiene éxito | Credenciales faltantes o no accesible | — |
| `retention` | Todos los presupuestos dentro de los límites, sin vectores no sincronizados | Presupuesto excedido O vectores no sincronizados > 0 | — |

**Códigos de estado HTTP:**
- `200` tanto para `healthy` como para `degraded`
- `503` para `unhealthy`

El estado de salud del embedding se almacena en caché durante 30 segundos para evitar llamadas a la API de OpenAI por sonda.

### Métricas

Si `observability.metrics_enabled: true`, hay un endpoint de métricas disponible:

```bash
GET /metrics
```

Devuelve métricas en formato de exposición de texto de Prometheus: una línea `# TYPE <name>
<counter|gauge|histogram>` una vez por nombre de métrica, seguida de líneas `name{label="value",...}
value` (el segmento `{...}` se omite en las métricas sin etiquetas, manteniendo la salida compatible
con el formato anterior sin etiquetas).

| Métrica | Tipo | Descripción |
|---|---|---|
| `bhgbrain_tool_calls_total` | contador | Total de invocaciones de herramientas |
| `bhgbrain_tool_handler_ms_avg` | histograma | Latencia promedio del manejador de herramientas en milisegundos, etiquetada con `tool` (nombre de la herramienta) y `status` (`ok`/`error`). Se registra en cada llamada, incluidos los fallos. |
| `bhgbrain_tool_handler_ms_p50` | histograma | Percentil 50 de la latencia del manejador de herramientas, etiquetada con `tool` y `status` |
| `bhgbrain_tool_handler_ms_p95` | histograma | Percentil 95 de la latencia del manejador de herramientas, etiquetada con `tool` y `status` |
| `bhgbrain_tool_handler_ms_p99` | histograma | Percentil 99 de la latencia del manejador de herramientas, etiquetada con `tool` y `status` |
| `bhgbrain_tool_handler_ms_count` | contador | Número de muestras de latencia del manejador de herramientas, etiquetada con `tool` y `status` |
| `embedding_embed_batch_ms_p95` | histograma | Percentil 95 de la latencia del lote de embeddings |
| `search_total_ms_p95` | histograma | Percentil 95 de la latencia de búsqueda de extremo a extremo |
| `bhgbrain_memory_count` | medidor | Recuento total de memorias actual (actualizado en escritura/eliminación) |
| `bhgbrain_rate_limit_buckets` | medidor | Cubos de seguimiento de límite de tasa activos |
| `bhgbrain_rate_limited_total` | contador | Total de solicitudes con límite de tasa excedido |
| `recall_zero_after_filter` | contador | Se incrementa cuando la revalidación defensiva de tipo/etiquetas posterior a la recuperación de `recall` elimina un resultado que el almacén ya había declarado coincidente — una señal de inanición de filtros que debería permanecer en 0 en estado estable |

Por ejemplo:

```
# TYPE bhgbrain_tool_handler_ms_p95 histogram
bhgbrain_tool_handler_ms_p95{tool="recall",status="ok"} 12
bhgbrain_tool_handler_ms_p95{tool="remember",status="error"} 340
```

Los histogramas usan un búfer circular acotado de las últimas 1.000 muestras **por combinación de
etiquetas** (cada par herramienta/estado tiene su propia ventana de 1.000 muestras). Las métricas son
solo en proceso — no hay push externo. Dado que los fallos ahora se incluyen en
`bhgbrain_tool_handler_ms`, sus p95/p99 reflejan la cola lenta de fallos (tiempos de espera agotados,
aperturas de disyuntor de circuito, etc.) y pueden mostrar valores más altos que antes de que esta
métrica registrara fallos.

---

## Seguridad

### Autenticación HTTP

Al ejecutarse en modo HTTP, las solicitudes a todos los endpoints excepto `/health` requieren un token `Bearer`:

```
Authorization: Bearer <your-token>
```

El valor del token se lee desde la variable de entorno nombrada en `transport.http.bearer_token_env` (predeterminado: `BHGBRAIN_TOKEN`). Si la variable de entorno no está configurada, todas las solicitudes HTTP pasan (se registra una advertencia pero la autenticación no se aplica — para enlaces solo de loopback esto es aceptable).

El token proporcionado se compara con el secreto configurado usando una comparación de tiempo constante (`crypto.timingSafeEqual`), de modo que una discrepancia no filtra información temporal sobre qué byte difiere. Los tokens con una longitud distinta a la del secreto configurado fallan de forma cerrada inmediatamente, sin intentar la comparación de tiempo constante.

**Fail-closed para enlaces externos:** Si el host HTTP es no-loopback (no `127.0.0.1`, `localhost` o `::1`) y no se ha configurado ningún token, el servidor **se niega a iniciar**:

```
SECURITY: HTTP binding to "0.0.0.0" is externally reachable but no bearer token is configured...
```

Para permitir explícitamente el acceso externo sin autenticación (no recomendado), establece:
```json
{ "security": { "allow_unauthenticated_http": true } }
```

Se registra una advertencia de alta visibilidad al inicio cuando esto está activo.

### Aplicación de Loopback

Por defecto, los enlaces HTTP no-loopback se rechazan incluso antes de la verificación de autenticación:

```json
{ "security": { "require_loopback_http": true } }
```

Para enlazarse a una dirección no-loopback (p.ej., para clientes remotos en una LAN):
```json
{
  "transport": { "http": { "host": "0.0.0.0" } },
  "security": { "require_loopback_http": false }
}
```

Asegúrate de que `BHGBRAIN_TOKEN` esté configurado en esta configuración.

### Confianza de Proxy

`security.trust_proxy` (predeterminado `false`) se pasa directamente a `app.set('trust proxy', ...)` de Express, lo que controla cómo se deriva `req.ip` y, por lo tanto, qué identidad usa el limitador de tasa:

- **Deshabilitado (predeterminado):** `req.ip` es el peer de socket directo. Esto es preciso para el despliegue solo-loopback documentado. Si de todos modos hay un proxy inverso delante, todos los clientes proxied colapsan en la única IP del proxy, y los encabezados `X-Forwarded-For` suministrados por el llamador se ignoran (por lo que no pueden falsificarse para dividir o evadir límites de tasa).
- **Habilitado:** `req.ip` respeta `X-Forwarded-For` establecido por el peer inmediato. Habilítalo solo detrás de un proxy inverso en el que confíes para establecer ese encabezado correctamente — habilitarlo sin un proxy confiable delante permite que cualquier cliente falsifique su identidad de límite de tasa.

```json
{ "security": { "trust_proxy": true } }
```

### Límite de Tasa

Las solicitudes HTTP tienen límite de tasa por dirección IP de cliente:

- Predeterminado: 100 solicitudes por minuto (`security.rate_limit_rpm`)
- El estado del límite de tasa se basa en la IP confiable, derivada según `security.trust_proxy` arriba (no en el encabezado `x-client-id`)
- Los clientes que exceden el límite reciben HTTP 429 con `{ error: { code: "RATE_LIMITED", retryable: true } }`
- Las solicitudes sin IP de cliente derivable fallan de forma cerrada con HTTP 400 (`INVALID_INPUT`) en lugar de compartir un único cubo de reserva
- Los encabezados de respuesta incluyen `X-RateLimit-Limit` y `X-RateLimit-Remaining`
- Los cubos de límite de tasa expirados se barren cada 30 segundos
- El estado del límite de tasa está delimitado por instancia de servidor/middleware, de modo que instancias independientes (p. ej. en pruebas) nunca comparten cubos

### Límite de Tamaño de Solicitud

Los cuerpos de solicitudes HTTP están limitados a `security.max_request_size_bytes` (predeterminado 1 MB = 1.048.576 bytes). Las solicitudes demasiado grandes reciben HTTP 413.

### Redacción de Logs

Cuando `security.log_redaction: true` (predeterminado), los bearer tokens que aparecen en la salida de logs se redactan. Los logs de fallo de autenticación muestran solo una vista previa truncada de los tokens inválidos. Los campos de contenido de memoria (`content`, `preview`, `summary` y cualquier `*.content` anidado) se redactan de la misma forma en la salida de logs estructurados, aplicado mediante las rutas de redacción configuradas del logger, no por omisión en cada punto de registro.

### Detección de Secretos en el Contenido

El pipeline de escritura escanea todo el contenido de memoria entrante en busca de credenciales y secretos antes del almacenamiento. Cualquier contenido que coincida con patrones de credenciales se rechaza con `INVALID_INPUT`. Esto se aplica a todas las herramientas y transportes.

---

## Recursos MCP

BHGBrain expone recursos MCP (legibles vía `ReadResource`) además de las herramientas.

### Recursos Estáticos

| URI | Nombre | Descripción |
|---|---|---|
| `memory://list` | Lista de Memorias | Lista paginada con cursor de memorias (más recientes primero) |
| `memory://inject` | Inject de Sesión | Bloque de contexto con presupuesto para auto-inject (categorías + memorias principales) |
| `category://list` | Categorías | Todas las categorías con vistas previas |
| `collection://list` | Colecciones | Todas las colecciones con recuentos de memorias |
| `health://status` | Estado de Salud | Instantánea completa de salud |

### Plantillas de Recursos (Parametrizadas)

| Plantilla URI | Nombre | Descripción |
|---|---|---|
| `memory://{id}` | Detalles de Memoria | Registro completo de memoria por UUID |
| `memory://{id}/revisions` | Revisiones de Memoria | Historial de revisiones de una memoria, más reciente primero |
| `memory://inject/{hint}` | Inject de Sesión (con pista) | Bloque de contexto con presupuesto cuya sección de memorias se selecciona por relevancia híbrida a la pista, en lugar de recencia |
| `category://{name}` | Categoría | Contenido completo de categoría por nombre |
| `collection://{name}` | Colección | Memorias en una colección específica |

### `memory://list` — Listado Paginado de Memorias

Parámetros de consulta:
- `namespace` — namespace a listar (predeterminado: `global`)
- `limit` — tamaño de página, 1–100 (predeterminado: 20)
- `cursor` — cursor opaco de la respuesta anterior para paginación

Respuesta:
```json
{
  "items": [/* objetos MemoryRecord */],
  "cursor": "2026-03-15T12:00:00.000Z|<uuid>",
  "total_results": 1234,
  "truncated": true
}
```

La paginación usa cursores compuestos (`created_at|id`) para un orden estable. Los empates en la misma marca de tiempo se desempatan por ID, asegurando que ninguna fila se omita o duplique entre páginas.

`memory://list` y `memory://{id}` aplican la misma regla de visibilidad de ciclo de vida que `search`/`recall`: una memoria `T2`/`T3` expirada y elegible para decaimiento se excluye (las lecturas en `memory://{id}` devuelven `NOT_FOUND`). Las memorias `T0` y `T1` permanecen visibles sin importar la expiración transitoria.

### `memory://inject` — Inyección de Contexto de Sesión

El recurso inject construye un payload de texto con presupuesto para inyectar en una ventana de contexto LLM:

1. El contenido de categorías se antepone primero (contenido completo, en orden),
   limitado a su parte reservada del presupuesto:
   `(1 - auto_inject.memory_budget_fraction) × presupuesto`. Lo que las categorías
   dejen sin usar pasa a la sección de memorias siguiente (sin desperdicio).
2. Las memorias se añaden dentro del presupuesto restante (contenido o resumen
   según el espacio) — siempre al menos `auto_inject.memory_budget_fraction ×
   presupuesto` cuando existen memorias, de modo que el contenido de categorías ya
   no puede dejar sin espacio a la sección de memorias.
   - `memory://inject` (sin pista): memorias principales por **recencia**, sin
     cambios respecto a antes de esta opción.
   - `memory://inject/{hint}`: memorias principales por **relevancia híbrida** a la
     pista (ver más abajo).
3. El payload se trunca en `auto_inject.max_chars`, interpretado según
   `auto_inject.budget_unit` (predeterminado 30.000 caracteres).

Parámetros de consulta:
- `namespace` — namespace desde el que inyectar (predeterminado: `global`)

Respuesta:
```json
{
  "content": "## company-standards (company-values)\n...\n## api-contracts (architecture)\n...\n- [semantic] Our auth service uses JWT...\n",
  "truncated": false,
  "total_results": 42,
  "categories_count": 2,
  "memories_count": 10
}
```

Acceder a una memoria vía `memory://{id}` incrementa su recuento de accesos y programa un volcado diferido.

### `memory://inject/{hint}` — Inyección de Sesión Condicionada por Relevancia

Una variante parametrizada de `memory://inject` que selecciona la sección de
memorias por **relevancia híbrida a una pista** proporcionada por el llamador (una
frase de tarea, nombre de repo o tema) en lugar de por recencia:

- La pista es un segmento de ruta URI: decodificada una vez, recortada y limitada a
  500 caracteres (el mismo límite que `search`/`recall` aplican a una consulta),
  antes de dirigir la búsqueda híbrida sobre el namespace resuelto.
- La selección reutiliza el mismo ranking compuesto/RRF, el mismo filtrado de
  expiración y el mismo límite top-K (`defaults.auto_inject_limit`) que una llamada
  normal a `search`/`recall`. A diferencia de la ruta sin pista, una lectura con
  pista **registra acceso** en las memorias seleccionadas — es un recall en todo
  sentido relevante.
- Si el proveedor de embeddings no está disponible, la selección degrada con
  elegancia a la rama de texto completo — el payload igual se produce, solo sin la
  contribución semántica.
- Una pista vacía (en blanco tras recortarla) recae en el comportamiento de
  recencia descrito arriba.
- **Supresión de casi-duplicados**: cuando `auto_inject.dedup_suppression` es
  `true` (predeterminado), se omite un candidato cuya similitud vectorial con una
  memoria ya seleccionada supere `deduplication.similarity_threshold`, y el
  presupuesto liberado pasa al siguiente candidato distinto.

Ejemplo: `memory://inject/deploy%20to%20production` condiciona la selección a
"deploy to production".

La forma de la respuesta es idéntica a `memory://inject`.

### `memory://{id}/revisions` — Historial de Revisiones

Devuelve el historial de revisiones registrado de una memoria, más reciente primero, bajo las mismas reglas de visibilidad que `memory://{id}` (`NOT_FOUND` para una memoria desconocida o excluida por visibilidad). Solo las memorias T0 acumulan revisiones (ver [Historial de Revisiones T0](#historial-de-revisiones-t0)), por lo que otras capas devuelven una lista vacía.

Respuesta:
```json
{
  "id": "<uuid>",
  "revisions": [
    { "id": 2, "memory_id": "<uuid>", "revision": 2, "content": "...", "updated_at": "2026-03-15T12:00:00.000Z", "updated_by": "client-a" },
    { "id": 1, "memory_id": "<uuid>", "revision": 1, "content": "...", "updated_at": "2026-03-10T09:00:00.000Z", "updated_by": "client-a" }
  ]
}
```

Para un cliente stdio sin soporte de recursos, use en su lugar la acción `list` de la herramienta `revisions` (los mismos datos — ver [Referencia de Herramientas MCP](#referencia-de-herramientas-mcp)).

---

## Prompt de Bootstrap

`BootstrapPrompt.txt` contiene un prompt de entrevista estructurado para construir un **perfil de segundo cerebro de trabajo** con un agente de IA.

Úsalo al incorporar un nuevo asistente de IA o cuando quieras poblar BHGBrain con un perfil rico y estructurado de tu contexto de trabajo, entidades, tenants y reglas de desambiguación.

### Cómo usarlo

1. Inicia una conversación nueva con tu asistente de IA (Claude, GPT-4, etc.).
2. Pega el contenido completo de `BootstrapPrompt.txt` como tu primer mensaje.
3. Deja que el agente te entreviste sección por sección.
4. Al final, el agente producirá un perfil estructurado que puedes guardar en BHGBrain vía llamadas `bhgbrain.remember` (o `mcporter call bhgbrain.remember`).

### Lo que cubre

La entrevista recorre 10 secciones:

| Sección | Lo que captura |
|---|---|
| 1. Identidad y rol | Nombre, títulos, roles principales vs orientados al cliente |
| 2. Responsabilidades | Lo que posees, lo que influencias |
| 3. Objetivos | Prioridades a 30 días, trimestrales, anuales |
| 4. Estilo de comunicación | Cómo quieres que se presente la información |
| 5. Patrones de trabajo | Ventanas de pensamiento estratégico vs ejecución |
| 6. Herramientas y sistemas | Fuentes de verdad, plataformas clave |
| 7. Mapa de empresa y entidades | Cada organización, cliente, producto y relación |
| 8. Estructura GitHub / repositorio | Organizaciones, repos, quién posee qué |
| 9. Mapa de tenant y entorno | Tenants de Azure, dev/staging/prod |
| 10. Reglas operativas | Convenciones de nombres, desambiguación, supuestos predeterminados |

La salida produce un perfil estructurado limpio con las 10 secciones más una guía de desambiguación — exactamente lo que BHGBrain necesita para responder preguntas sobre tu trabajo de manera confiable.

**Las memorias de bootstrap tienen por defecto T0.** El contenido ingestado vía el flujo de bootstrap debe etiquetarse con `source: import` y `tags: ["bootstrap", "profile"]`. El clasificador heurístico reconoce estas señales y asigna el nivel T0 (fundacional).

---

## Referencia de la CLI

```bash
# Operaciones de memoria
bhgbrain list                         # Listar memorias recientes (más nuevas primero)
bhgbrain search <query>               # Búsqueda híbrida
bhgbrain show <id>                    # Mostrar detalles completos de una memoria
bhgbrain forget <id>                  # Eliminar una memoria permanentemente

# Gestión de niveles
bhgbrain tier show <id>               # Mostrar nivel, expiración, recuento de accesos de una memoria
bhgbrain tier set <id> <T0|T1|T2|T3> # Cambiar el nivel de retención de una memoria
bhgbrain tier list --tier T0          # Listar todas las memorias en un nivel específico

# Gestión del archivo
bhgbrain archive list                 # Listar resúmenes de memorias archivadas (eliminadas)
bhgbrain archive search <query>       # Buscar en el archivo por texto
bhgbrain archive restore <id>         # Restaurar una memoria archivada como nueva memoria T2

# Estadísticas y diagnósticos
bhgbrain stats                        # Estadísticas de BD, resumen de colecciones
bhgbrain stats --by-tier              # Desglose del recuento de memorias por nivel de retención
bhgbrain stats --expiring             # Mostrar memorias que expiran en los próximos 7 días
bhgbrain health                       # Verificación completa del estado del sistema

# Recolección de basura (archiva + elimina T2/T3 expiradas; T1 se muestra
# como reviewCandidates en lugar de eliminarse; la compactación de Qdrant se
# ejecuta automáticamente cuando la proporción de vectores eliminados de una
# colección afectada supera el umbral configurado — ver
# retention.compaction_deleted_threshold)
bhgbrain gc                           # Ejecutar limpieza
bhgbrain gc --dry-run                 # Mostrar candidatos y elementos de revisión sin eliminar
bhgbrain gc --tier T3                 # Limpiar solo memorias T3

# Log de auditoría
bhgbrain audit                        # Mostrar entradas de auditoría recientes

# Reparación (recuperación multi-dispositivo)
bhgbrain repair --from-qdrant                # Hidratar SQLite local desde Qdrant (solo memorias del dispositivo actual, por defecto)
bhgbrain repair --from-qdrant --all-devices  # Hidratar desde las memorias de todos los dispositivos, no solo el actual

# Reparación (migración de modelo de embedding — ver Migración de Modelo de Embedding)
bhgbrain repair --re-embed                   # Migrar vectores con marca de embedding obsoleta
bhgbrain repair --re-embed --dry-run         # Previsualizar cuántas filas se re-embeberían
bhgbrain repair --re-embed --include-legacy  # Incluir también filas sin marca alguna
bhgbrain repair --re-embed --batch-size 100  # Ajustar el tamaño de lote (por defecto 50)

# Gestión de categorías
bhgbrain category list                # Listar todas las categorías
bhgbrain category get <name>          # Mostrar contenido de una categoría
bhgbrain category set <name>          # Establecer/actualizar contenido de una categoría (interactivo)
bhgbrain category delete <name>       # Eliminar una categoría

# Gestión de copias de seguridad
bhgbrain backup create                # Crear una copia de seguridad en el directorio de datos
bhgbrain backup list                  # Listar todas las copias de seguridad conocidas
bhgbrain backup restore <path>        # Restaurar desde un archivo de copia de seguridad .bhgb

# Gestión del servidor
bhgbrain server start                 # Iniciar el servidor MCP
bhgbrain server status                # Verificar si el servidor está en ejecución y en buen estado
bhgbrain server token                 # Generar un nuevo bearer token aleatorio
```

---

## Referencia de Herramientas MCP

BHGBrain expone 11 herramientas MCP. Todas las herramientas validan la entrada con esquemas Zod y devuelven JSON estructurado. Los errores usan un sobre consistente:

```json
{
  "error": {
    "code": "INVALID_INPUT | NOT_FOUND | CONFLICT | AUTH_REQUIRED | RATE_LIMITED | EMBEDDING_UNAVAILABLE | INTERNAL",
    "message": "Descripción legible por humanos",
    "retryable": true
  }
}
```

---

### `remember` — Almacenar una Memoria

Almacena contenido en BHGBrain con deduplicación automática, normalización, embedding y clasificación por nivel.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `content` | `string` | **Sí** | — | El contenido a almacenar. Máx. 100.000 caracteres. Los caracteres de control se eliminan. El contenido que coincide con patrones de secretos se rechaza. |
| `namespace` | `string` | No | `"global"` | Alcance del namespace. Patrón: `^[a-zA-Z0-9/-]{1,200}$` |
| `collection` | `string` | No | `"general"` | Colección dentro del namespace. Máx. 100 chars. |
| `type` | `"episodic" \| "semantic" \| "procedural"` | No | `"semantic"` | Tipo de memoria. Influye en la asignación predeterminada de nivel. |
| `tags` | `string[]` | No | `[]` | Etiquetas para filtrado y clasificación. Máx. 20 etiquetas, cada una máx. 100 chars. Patrón: `^[a-zA-Z0-9-]+$` |
| `category` | `string` | No | — | Adjuntar a un slot de categoría (implica nivel T0). Máx. 100 chars. |
| `importance` | `number (0–1)` | No | `0.5` | Puntuación de importancia. Los valores más altos se priorizan en la limpieza de obsolescencia. |
| `source` | `"cli" \| "api" \| "agent" \| "import"` | No | `"cli"` | Fuente de la memoria. Afecta al nivel predeterminado (p.ej., agent+procedural → T1). |
| `retention_tier` | `"T0" \| "T1" \| "T2" \| "T3"` | No | auto-asignado | Anulación explícita del nivel. Tiene precedencia sobre todas las heurísticas. |

**Salida:**

```json
{
  "id": "3f4a1b2c-...",
  "summary": "Our auth service uses JWT with 1h expiry",
  "type": "semantic",
  "operation": "ADD",
  "created_at": "2026-03-15T12:00:00Z"
}
```

`operation` es uno de:
- `ADD` — nueva memoria creada
- `UPDATE` — memoria similar existente fue actualizada (contenido fusionado)
- `NOOP` — duplicado exacto o casi exacto; se devuelve la memoria existente

Para operaciones `UPDATE`, `merged_with_id` contiene el ID de la memoria que fue actualizada.

**Ejemplos:**

```json
// Almacenar una decisión arquitectónica (T0)
{
  "content": "Authentication uses JWT tokens signed with RS256. Public keys are rotated every 90 days and published at /.well-known/jwks.json",
  "type": "semantic",
  "tags": ["auth", "jwt", "architecture"],
  "importance": 0.9,
  "retention_tier": "T0"
}

// Almacenar el resultado de una reunión (T2, asignado automáticamente)
{
  "content": "Sprint 14 retrospective: team agreed to add integration tests before merging new endpoints",
  "type": "episodic",
  "tags": ["sprint", "retrospective"],
  "source": "agent"
}

// Almacenar un runbook (T1 vía tipo procedural)
{
  "content": "## Deployment Runbook\n1. Run `npm run build`\n2. Push to staging\n3. Run smoke tests\n4. Tag release\n5. Deploy to prod",
  "type": "procedural",
  "tags": ["deployment", "runbook"],
  "source": "import",
  "importance": 0.8
}
```

---

### `recall` — Recall Semántico

Recupera las memorias más relevantes para una consulta usando búsqueda de similitud semántica (vectorial) con filtrado opcional.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `query` | `string` | **Sí** | — | Consulta de recall. Máx. 500 caracteres. |
| `namespace` | `string` | No | `"global"` | Namespace en el que buscar. |
| `collection` | `string` | No | — | Filtrar a una colección específica. Omitir para buscar en la colección predeterminada. |
| `type` | `"episodic" \| "semantic" \| "procedural"` | No | — | Filtrar resultados a un tipo de memoria específico. Empujado hacia el almacén, de modo que `limit` cuenta memorias coincidentes. |
| `tags` | `string[]` | No | — | Filtrar a memorias con al menos una etiqueta coincidente (coincidencia de cualquiera). Empujado hacia el almacén, de modo que `limit` cuenta memorias coincidentes. |
| `limit` | `integer (1–20)` | No | `5` | Número máximo de resultados. |
| `min_score` | `number (0–1)` | No | `0.6` | Puntuación mínima de similitud coseno, aplicada a `semantic_score` (no al `score` fusionado/ajustado). Los resultados por debajo de este umbral se excluyen. |

**Salida:**

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

### `forget` — Eliminar una Memoria

Elimina permanentemente una memoria específica por su UUID. Elimina tanto de SQLite como de Qdrant. Crea una entrada en el log de auditoría.

**Entrada:**

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `id` | `string (UUID)` | **Sí** | El ID de la memoria a eliminar. |

**Salida:**

```json
{
  "deleted": true,
  "id": "3f4a1b2c-..."
}
```

Devuelve el error `NOT_FOUND` si el ID no existe o ya está archivado.

---

### `search` — Búsqueda Multi-Modo

Busca memorias usando modos semántico, de texto completo o híbrido. Ofrece más control que `recall` y admite límites de resultados más altos.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `query` | `string` | **Sí** | — | Consulta de búsqueda. Máx. 500 caracteres. |
| `namespace` | `string` | No | `"global"` | Namespace en el que buscar. |
| `collection` | `string` | No | — | Filtrar a una colección específica. |
| `mode` | `"semantic" \| "fulltext" \| "hybrid"` | No | `"hybrid"` | Algoritmo de búsqueda. |
| `limit` | `integer (1–50)` | No | `10` | Número máximo de resultados. |
| `include_archived` | `boolean` | No | `false` | También busca en memorias archivadas (ver [Decaimiento, Limpieza y Archivado](#decaimiento-limpieza-y-archivado)) mediante coincidencia de términos en el resumen/etiquetas. Las coincidencias se añaden después de los resultados activos, marcadas con `archived: true`, y nunca reducen cuántos resultados activos permite `limit`. Las coincidencias archivadas no se registran como acceso. |

**Salida:** Misma estructura que `recall` — `{ "results": [...] }` — pero sin la compuerta `min_score` y admitiendo hasta 50 resultados. Las coincidencias archivadas (cuando `include_archived: true`) llevan `archived: true`, usan el resumen conservado como `content` y no tienen un `score` significativo (son coincidencias de términos en metadatos, no resultados clasificados).

---

### `tag` — Gestionar Etiquetas

Añade o elimina etiquetas de una memoria. Las etiquetas se fusionan/filtran atómicamente; el contenido y el embedding de la memoria no se ven afectados.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `id` | `string (UUID)` | **Sí** | — | Memoria a etiquetar. |
| `add` | `string[]` | No | `[]` | Etiquetas a añadir. Máx. 20 etiquetas totales tras la fusión. |
| `remove` | `string[]` | No | `[]` | Etiquetas a eliminar. |

**Salida:**

```json
{
  "id": "3f4a1b2c-...",
  "tags": ["auth", "architecture", "jwt"]
}
```

Devuelve `INVALID_INPUT` si añadir etiquetas excedería el límite de 20 etiquetas.

---

### `collections` — Gestionar Colecciones

Lista, crea o elimina colecciones dentro de un namespace.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `action` | `"list" \| "create" \| "delete"` | **Sí** | — | Acción a realizar. |
| `namespace` | `string` | No | `"global"` | Contexto del namespace. |
| `name` | `string` | Requerido para `create`/`delete` | — | Nombre de la colección. Máx. 100 chars. |
| `force` | `boolean` | No | `false` | Requerido para eliminar una colección no vacía (elimina todas las memorias). |

**Salida de `list`:**
```json
{
  "collections": [
    { "name": "general", "count": 42 },
    { "name": "architecture", "count": 10 }
  ]
}
```

**Salida de `create`:**
```json
{ "ok": true, "namespace": "global", "name": "architecture" }
```

**Salida de `delete`:**
```json
{ "ok": true, "namespace": "global", "name": "architecture", "deleted_memory_count": 10 }
```

**Importante:** Eliminar una colección no vacía sin `force: true` devuelve un error `CONFLICT`:
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

### `category` — Gestionar Categorías de Política

Gestiona categorías de política persistentes — bloques de contexto siempre disponibles que se anteponen a cada payload `memory://inject`.

**Entrada:**

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `action` | `"list" \| "get" \| "set" \| "delete"` | **Sí** | Acción a realizar. |
| `name` | `string` | Requerido para `get`/`set`/`delete` | Nombre de la categoría. Máx. 100 chars. |
| `slot` | `"company-values" \| "architecture" \| "coding-requirements" \| "custom"` | Requerido para `set` (predeterminado a `"custom"`) | Tipo de slot de categoría. |
| `content` | `string` | Requerido para `set` | Contenido de la categoría. Máx. 100.000 caracteres. |

**Salida de `list`:**
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

**Salida de `get`:**
```json
{
  "name": "coding-standards",
  "slot": "coding-requirements",
  "content": "## Coding Standards\n\n- Use TypeScript strict mode\n...",
  "revision": 3,
  "updated_at": "2026-03-01T10:00:00Z"
}
```

**Salida de `set`:** Devuelve el registro completo de categoría (igual que `get`).

**Salida de `delete`:**
```json
{ "ok": true, "name": "coding-standards" }
```

---

### `backup` — Copia de Seguridad y Restauración

Crea, lista o restaura copias de seguridad de memorias.

**Entrada:**

| Parámetro | Tipo | Requerido | Descripción |
|---|---|---|---|
| `action` | `"create" \| "list" \| "restore"` | **Sí** | Acción a realizar. |
| `path` | `string` | Requerido para `restore` | Ruta absoluta al archivo de copia de seguridad `.bhgb`. |

**Salida de `create`:**
```json
{
  "path": "/home/user/.bhgbrain/backups/2026-03-15T12-00-00-000Z.bhgb",
  "size_bytes": 2048576,
  "memory_count": 1234,
  "created_at": "2026-03-15T12:00:00Z"
}
```

**Salida de `list`:**
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

**Salida de `restore`:**
```json
{
  "memory_count": 1234,
  "metadata_activated": true,
  "vector_reconciliation": {
    "status": "degraded",
    "state": "reconciling",
    "unsynced_vectors": 42,
    "message": "Restore activated SQLite metadata; vector reconciliation for the drifted subset is continuing in the background."
  }
}
```
`vector_reconciliation.state` es `"reconciled"` cuando ningún vector tuvo drift real (nada que reincrustar), o `"reconciling"` mientras una tarea de fondo acotada reincrusta el subconjunto con drift o faltante. Ver [Restauración desde una Copia de Seguridad](#restauración-desde-una-copia-de-seguridad).

---

### `revisions` — Listar o Revertir Historial de Revisiones de una Memoria

Lista el historial de revisiones de una memoria, o revierte su contenido a una revisión anterior. La visibilidad por namespace se resuelve igual que en `forget` y `tag` (la memoria se busca primero por ID). Solo las memorias T0 acumulan revisiones — ver [Historial de Revisiones T0](#historial-de-revisiones-t0).

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `action` | `"list" \| "revert"` | **Sí** | - | Operación a realizar. |
| `id` | `string (UUID)` | **Sí** | - | El ID de la memoria. |
| `revision` | `number` | Requerido para `revert` | - | El número de revisión al que revertir. |

**Salida (`action: "list"`):**

```json
{
  "id": "3f4a1b2c-...",
  "revisions": [
    { "id": 2, "memory_id": "3f4a1b2c-...", "revision": 2, "content": "...", "updated_at": "2026-03-15T12:00:00.000Z", "updated_by": "client-a" },
    { "id": 1, "memory_id": "3f4a1b2c-...", "revision": 1, "content": "...", "updated_at": "2026-03-10T09:00:00.000Z", "updated_by": "client-a" }
  ]
}
```

Una memoria sin cambios de contenido devuelve un array `revisions` vacío, no un error.

**Salida (`action: "revert"`):**

```json
{
  "id": "3f4a1b2c-...",
  "revision": 1,
  "content": "el contenido restaurado"
}
```

**Notas:**
- El revert restaura el contenido de la revisión objetivo por la misma ruta que usa el flujo UPDATE de deduplicación de `remember`: nuevo checksum, vector re-generado, reinsertado en Qdrant. El contenido previo al revert se conserva como una nueva entrada de historial añadida (el historial nunca se reescribe).
- Un evento de auditoría `REVISE` registra el número de revisión de origen, distinguible del REVISE genérico que el pipeline de escritura registra en cambios de contenido T0 ordinarios.
- El revert requiere el proveedor de embeddings — si no está disponible, el revert falla con `EMBEDDING_UNAVAILABLE` y la memoria queda completamente sin cambios (sin escritura parcial, sin desincronización del vector).
- Revertir a un número de revisión que no existe para la memoria devuelve `NOT_FOUND`.

---

### `review` — Cola de Revisión y Recuperación de Archivo

Lista y disposiciona la cola de revisión T1, y restaura memorias archivadas. Cierra el lado de lectura del ciclo de vida por niveles: `review_due` (marcado en memorias T1, ver [Ciclo de Vida por Nivel](#ciclo-de-vida-por-nivel--asignación-promoción-ventana-deslizante)) y `archived_memories` (ver [Decaimiento, Limpieza y Archivado](#decaimiento-limpieza-y-archivado)) tenían ambos una ruta de escritura pero antes no tenían superficie de lectura desde MCP. La revisión de contenido deliberadamente no se duplica aquí — usa la ruta UPDATE de `remember` para eso.

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `action` | `"list" \| "keep" \| "archive" \| "restore"` | **Sí** | - | Operación a realizar. |
| `id` | `string (UUID)` | Requerido para `keep`/`archive`/`restore` | - | El ID de la memoria. Para `restore`, el ID de la memoria original, buscado en el archivo. |
| `days` | `integer (0–3650)` | No | `0` | (solo `list`) Ventana de anticipación en días más allá de "vencido ahora". `0` devuelve solo memorias ya vencidas. |
| `namespace` | `string` | No | `"global"` | Ámbito de namespace. |
| `limit` | `integer (1–100)` | No | `20` | (solo `list`) Tamaño de página. |
| `cursor` | `string` | No | - | (solo `list`) Cursor de paginación devuelto por una llamada `list` anterior. |

**Salida (`action: "list"`):**

```json
{
  "items": [
    {
      "id": "3f4a1b2c-...",
      "namespace": "global",
      "collection": "general",
      "summary": "Runbook de despliegue para el servicio de pagos",
      "tags": ["deployment", "runbook"],
      "retention_tier": "T1",
      "review_due": "2026-03-01T00:00:00.000Z",
      "expires_at": "2026-03-01T00:00:00.000Z"
    }
  ],
  "cursor": "2026-03-01T00:00:00.000Z|3f4a1b2c-..."
}
```

Los elementos son memorias T1 no archivadas cuyo `review_due` es en o antes de "ahora + `days`", devueltas en orden de vencimiento más antiguo primero. `cursor` es `null` una vez alcanzada la última página; pásalo de vuelta como entrada `cursor` para obtener la siguiente página.

**Salida (`action: "keep"`):**

```json
{
  "id": "3f4a1b2c-...",
  "review_due": "2027-03-01T00:00:00.000Z",
  "expires_at": "2027-03-01T00:00:00.000Z"
}
```

Confirma que la memoria sigue siendo precisa: extiende tanto `review_due` como `expires_at` según la política de ciclo de vida del nivel de la memoria (reutilizando el mismo cálculo que usan `remember` y la promoción por acceso), sin importar `sliding_window_enabled` — una confirmación humana explícita recibe la extensión completa incluso cuando la renovación pasiva por ventana deslizante está deshabilitada. Registra un evento de auditoría `REVISE` que anota una confirmación de revisión. Devuelve `NOT_FOUND` si la memoria no existe.

**Salida (`action: "archive"`):**

```json
{ "id": "3f4a1b2c-...", "archived": true }
```

Enruta la memoria por la misma transición de archivado que usa el GC: su vector se elimina, su fila se mueve a `archived_memories` (se conservan resumen, etiquetas, nivel y estadísticas de acceso; el contenido y el vector no), y se registra un evento de auditoría `ARCHIVE`. Devuelve `NOT_FOUND` si el ID nunca existió, y `CONFLICT` si ya está archivado.

**Salida (`action: "restore"`):**

```json
{
  "id": "9c2e5f10-...",
  "restored_from": "3f4a1b2c-...",
  "archive_id": 42,
  "restored": true
}
```

Recrea una memoria activa a partir del resumen y las etiquetas conservados en el registro de archivo, en el nivel original — un **stub con procedencia**, no una resurrección: el contenido y el vector originales nunca se conservaron, así que el contenido de la memoria restaurada es su resumen archivado, etiquetado con sus etiquetas originales más una etiqueta marcadora `restored-from-archive`, y re-embebido para que participe en la búsqueda. La fila de archivo se conserva (no se elimina), a diferencia del comando `archive restore` de la CLI. Registra un evento de auditoría `RESTORE` que enlaza el origen del archivo. Devuelve `NOT_FOUND` si no existe un registro de archivo para el ID dado.

---

### `repair` — Reconstruir SQLite desde Qdrant, o migrar marcas de embedding obsoletas

Repara el estado local desde fuentes externas. `mode: "from-qdrant"` (predeterminado)
recupera memorias desde Qdrant a la base de datos SQLite local — se usa para
configuración multi-dispositivo, recuperación de pérdida de datos o incorporación de
nuevos dispositivos. `mode: "re-embed"` migra memorias cuya marca de embedding
difiere del `embedding.provider`/`embedding.model` activo — ver
[Migración de Modelo de Embedding](#migración-de-modelo-de-embedding). Ver también
[Reparación y Recuperación](#reparación-y-recuperación).

**Entrada:**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|---|---|---|---|---|
| `mode` | `"from-qdrant" \| "re-embed"` | No | `"from-qdrant"` | Qué operación de reparación ejecutar. |
| `dry_run` | `boolean` | No | `false` | Cuando es `true`, reporta lo que cambiaría sin hacer cambios. |
| `device_id` | `string` | No | — | (solo `from-qdrant`) Filtrar la recuperación a memorias creadas por un dispositivo específico. Mutuamente excluyente con `all_devices`. |
| `all_devices` | `boolean` | No | `false` | (solo `from-qdrant`) Recuperar explícitamente memorias de todos los dispositivos. Mutuamente excluyente con `device_id`. Este es también el comportamiento predeterminado cuando no se proporciona ninguno de los dos campos. |
| `include_legacy` | `boolean` | No | `false` | (solo `re-embed`) Incluir también filas heredadas sin marca de embedding alguna, no solo filas con un modelo distinto. |
| `batch_size` | `number` | No | `50` | (solo `re-embed`) Memorias re-embebidas por lote (1-500). |

**Salida (`mode: "from-qdrant"`):**

```json
{
  "dry_run": false,
  "all_devices": true,
  "device_id_filter": null,
  "collections_scanned": 2,
  "points_scanned": 47,
  "already_in_sqlite": 12,
  "skipped_no_content": 3,
  "recovered": 32,
  "errors": 0
}
```

**Notas:**
- Solo los puntos con `content` en su payload de Qdrant pueden recuperarse. Las memorias pre-1.3 sin contenido en Qdrant se reportan como `skipped_no_content`.
- Las memorias recuperadas preservan su `device_id` original del payload de Qdrant. Si no existe `device_id` en el payload, se usa el ID del dispositivo local.
- Las memorias recuperadas también preservan la identidad de embedding (si existe) que su vector de origen ya tenía marcada, en lugar de reclamar la identidad de la configuración activa — la recuperación reconstruye metadatos para un vector existente, no produce uno nuevo.
- Pasar tanto `device_id` como `all_devices: true` se rechaza como entrada inválida.
- Después de la recuperación, ejecuta `npm run build` y reinicia el servidor si es necesario. Las memorias recuperadas están inmediatamente disponibles para búsqueda y recall.

**Salida (`mode: "re-embed"`):**

```json
{
  "mode": "re-embed",
  "dry_run": false,
  "active_identity": "openai/text-embedding-3-small@1536",
  "include_legacy": false,
  "updated": 118,
  "failed": 0,
  "remaining": 0,
  "bound_reached": false,
  "converged": true
}
```

**Notas:**
- La selección se basa en la propia marca, por lo que una ejecución interrumpida se reanuda de forma segura — las filas ya re-marcadas con la identidad activa simplemente dejan de coincidir en la siguiente llamada.
- Un fallo de embed/upsert por memoria se aísla (se cuenta en `failed`, se deja para una ejecución futura) en lugar de abortar todo el lote.
- `converged: true` significa que no quedan filas con marca obsoleta (dentro del alcance de `include_legacy` solicitado); la identidad esperada del almacén se actualiza y la degradación de salud `embedding` se resuelve de inmediato, sin reinicio.
- También disponible desde la CLI: `bhgbrain repair --re-embed [--include-legacy] [--batch-size <n>] [--dry-run]`.

---

## Actualización

### 1.2 → 1.3 (Memoria Multi-Dispositivo y Resiliencia de Datos)

**No se requiere migración manual.** BHGBrain actualiza automáticamente al iniciar.

Lo que ocurre en el primer inicio después de la actualización:

- **SQLite**: Se añade una columna nullable `device_id` a la tabla `memories`. Las memorias existentes permanecen con `device_id = null` (pre-migración).
- **Qdrant**: Se crea un índice keyword `device_id` en cada colección (gestionado por `ensureCollection`).
- **Config**: Se resuelve un campo `device.id` (desde la configuración, variable de entorno o hostname) y se persiste en `config.json`.
- **Ruta de escritura**: Todas las nuevas memorias almacenan `content`, `summary` y `device_id` en el payload de Qdrant junto con el embedding vectorial.
- **Ruta de búsqueda**: Si una memoria existe en Qdrant pero no en el SQLite local, el resultado de búsqueda se construye desde el payload de Qdrant en lugar de ser descartado.

**Nueva herramienta**: `repair` — reconstruye el SQLite local desde Qdrant. Ejecútala en cualquier dispositivo que tenga una base de datos SQLite vacía o incompleta para recuperar memorias compartidas.

**Nueva sección de configuración**:
```jsonc
{
  "device": {
    "id": "my-workstation"  // opcional — auto-generado desde el hostname si se omite
  }
}
```

**Retrocompatible**: Las memorias pre-1.3 sin `device_id` o contenido en Qdrant continúan funcionando normalmente. Simplemente no pueden recuperarse vía la herramienta `repair`.

**Refinamientos post-1.3 (1.4.10)**: Una auditoría de la función multi-dispositivo encontró y corrigió una brecha de migración real más un par de desviaciones de contrato:

- El índice de payload de Qdrant `device_id` ahora se garantiza **incondicionalmente** en cada llamada a `ensureCollection`, no solo cuando se crea una colección por primera vez — las colecciones creadas antes de que esta función se lanzara ahora también se migran.
- `BHGBRAIN_DEVICE_ID` ahora **tiene prioridad** sobre un `device.id` persistido, siguiendo el contrato de "las variables de entorno ganan" usado en otros lugares. Cuando anula un valor persistido, el nuevo valor se vuelve a persistir.
- `config.json` se reescribe solo cuando el device id fue recién generado o cambiado por un override de entorno, no en cada arranque.
- La herramienta `repair` obtuvo un booleano `all_devices` explícito, mutuamente excluyente con `device_id`, como la ruta documentada de todos los dispositivos (el comportamiento implícito anterior de "omitir `device_id`" sigue funcionando sin cambios).

---

### 1.0 → 1.2 (Ciclo de Vida de Memoria por Niveles)

**No se requiere migración manual.** BHGBrain actualiza automáticamente las bases de datos existentes al inicio.

Lo que ocurre en el primer inicio después de la actualización:

- El esquema SQLite se migra en el sitio — se añaden nuevas columnas (`retention_tier`, `expires_at`, `decay_eligible`, `review_due`, `archived`, `vector_synced`) a la tabla `memories` con valores predeterminados seguros.
- A todas las memorias existentes se les asigna `retention_tier = T2` (retención estándar, TTL de 90 días por defecto).
- Las colecciones de Qdrant no cambian — no se requiere re-indexación.
- Los archivos `config.json` existentes son totalmente compatibles hacia adelante. Los nuevos campos de configuración (`retention.tier_ttl`, `retention.tier_budgets`, etc.) se aplican desde los predeterminados.

**Se recomienda hacer una copia de seguridad antes de actualizar** (por precaución):

```bash
bhgbrain backup create
```

La copia de seguridad se almacena en el directorio de datos (`%LOCALAPPDATA%\BHGBrain\` en Windows, `~/.bhgbrain/` en Linux/macOS).

---

## Notas de Comportamiento

### Semántica de Eliminación de Colecciones

`collections.delete` rechaza las colecciones no vacías por defecto. Usa `force: true` para anular esto:

```json
{
  "action": "delete",
  "namespace": "global",
  "name": "general",
  "force": true
}
```

### Activación de Restauración de Copia de Seguridad

`backup.restore` recarga el estado SQLite en tiempo de ejecución antes de devolver el éxito. Las respuestas de restauración incluyen `metadata_activated: true` cuando los datos restaurados están inmediatamente activos. No es necesario reiniciar el servidor.

La restauración adquiere un bloqueo de seguridad (`beginRestoreOperation()`) que solo bloquea las escrituras concurrentes mientras SQLite se activa y los vectores restaurados se comprueban contra Qdrant en busca de drift. Los vectores **no** se vacían y reincrustan incondicionalmente: solo se marcan para reincrustación las memorias cuyo checksum de contenido difiere de (o falta en) Qdrant, de modo que una restauración sin drift se completa sin llamar en absoluto al proveedor de embeddings. Si el modelo/dimensiones de embedding cambiaron desde que se tomó la copia de seguridad, o el estado de Qdrant no se puede leer, la restauración recurre en su lugar a una reconstrucción completa.

Una vez que termina la comprobación de drift, se libera el bloqueo — la reincrustación del subconjunto con drift (si lo hay) se ejecuta en una tarea de fondo acotada (un timeout y un límite de lotes por pasada) en lugar de retener la llamada de restauración o bloquear otras escrituras durante ese tiempo. Reintenta automáticamente con backoff ante fallos transitorios; si nunca llega a ponerse al día del todo, `health://status` sigue reportando `vector_reconciliation.state: "pending"` (o `"reconciling"` mientras una pasada está en curso) en lugar de dejar la búsqueda semántica en blanco silenciosamente. El progreso se vuelca a disco por lotes, así que un fallo brusco durante la reconciliación pierde como máximo un lote de trabajo — al reiniciar se reanuda de forma segura desde el conjunto no sincronizado restante mediante un re-upsert idempotente.

### Fortalecimiento HTTP

- `/health` es intencionalmente sin autenticación para compatibilidad con sondas.
- El límite de tasa se basa en la identidad de solicitud confiable (IP) e ignora `x-client-id` para su aplicación.
- El `client_id` de los logs de auditoría/solicitud también se deriva de la identidad de solicitud confiable (`req.ip`), nunca del encabezado `x-client-id` proporcionado por el llamante; ese encabezado solo se acepta como una pista de depuración no autoritativa y nunca se confía en él para el registro de auditoría.
- `memory://list` aplica límites de `limit` de `1..100`; los valores inválidos devuelven `INVALID_INPUT`.

### Autenticación Fail-Closed

- Los enlaces HTTP no-loopback requieren un bearer token por defecto.
- Si `BHGBRAIN_TOKEN` no está configurado y el host es no-loopback, el servidor se niega a iniciar.
- Para permitir explícitamente el acceso externo sin autenticación, establece `security.allow_unauthenticated_http: true` en la configuración. Se registra una advertencia de alta visibilidad al inicio.

### Modo de Embedding Degradado

- Si las credenciales del proveedor de embeddings faltan al inicio, el servidor inicia en **modo degradado** en lugar de fallar.
- Las operaciones que dependen de embeddings (búsqueda semántica, ingesta de memorias) devuelven `EMBEDDING_UNAVAILABLE` en el momento de la solicitud.
- La búsqueda de texto completo y las lecturas de categorías siguen funcionando en modo degradado.
- Las sondas de salud informan el estado del embedding como `degraded` sin realizar llamadas reales a la API.
- Cuando hay un proveedor configurado, su sonda de salud de embeddings es una **solicitud única y acotada** (respetando `embedding.request_timeout_ms`), sin reintentos ni backoff, de forma consistente entre `openai` y `azure-foundry`. La sonda omite el circuit breaker e informa un valor booleano, reflejando el estado actual del proveedor rápidamente en lugar de bloquearse varios segundos durante una interrupción.

### Contratos de Respuesta MCP

- Las respuestas de llamadas a herramientas incluyen payloads JSON estructurados.
- Las respuestas de error establecen `isError: true` en el protocolo MCP para el enrutamiento del lado del cliente.
- Los recursos parametrizados (`memory://{id}`, `memory://inject/{hint}`, `category://{name}`, `collection://{name}`) se exponen como plantillas de recursos MCP vía `resources/templates/list`.

### Búsqueda y Paginación

- **Alcance de colección:** La búsqueda de texto completo e híbrida respeta el filtro `collection` proporcionado por el llamador tanto en los conjuntos de candidatos semánticos como léxicos.
- **Paginación estable:** `memory://list` usa cursores compuestos (`created_at|id`) para un orden determinista. Las filas que comparten la misma marca de tiempo no se omiten ni se duplican entre páginas.
- **Surfacing de dependencias:** La búsqueda semántica propaga los fallos de Qdrant como errores explícitos en lugar de devolver resultados vacíos silenciosamente.

### Observabilidad Operacional

- **Métricas acotadas:** Los valores del histograma usan un búfer circular acotado (últimas 1.000 muestras).
- **Semántica de métricas:** Las métricas de histograma emiten sufijos `_avg` y `_count`.
- **Escrituras atómicas:** Las escrituras de archivos de base de datos y copia de seguridad usan escritura-en-temporal-luego-renombrar para prevenir archivos parciales truncados en caso de fallo.
- **Volcado diferido:** Los metadatos de acceso en la ruta de lectura (recuentos de toque) usan agrupación asíncrona acotada (ventana de 5s) en lugar de volcados síncronos completos de base de datos por solicitud.
- **Consistencia entre almacenes:** Las actualizaciones de SQLite se revierten si la operación correspondiente de Qdrant falla.

### Historial de Revisiones T0

Cuando se actualiza una memoria T0 (fundacional), la versión anterior se captura automáticamente en la tabla `memory_revisions`. Esto proporciona un historial de auditoría de solo adición para cambios de conocimiento crítico. La revisión actual es siempre lo que Qdrant almacena; las revisiones anteriores solo son consultables vía texto completo.

### Compatibilidad del Modelo de Embedding

Las colecciones bloquean su modelo de embedding y dimensiones al momento de la creación. Si cambias `embedding.model` o `embedding.dimensions` en la configuración, las nuevas memorias en colecciones existentes serán rechazadas con un error `CONFLICT` hasta que crees una nueva colección. Esto previene mezclar espacios de embedding incompatibles en el mismo índice de Qdrant.

### Detección de Secretos

El pipeline de escritura rechaza cualquier contenido que coincida con patrones de claves API, credenciales de base de datos, claves privadas y formatos comunes de secretos. Esto es una red de seguridad — nunca uses BHGBrain como bóveda de secretos.

### La Promoción de Nivel No Alcanza T0

La promoción automática por recuento de accesos puede promover `T3 → T2` y `T2 → T1`, pero **nunca a T0**. La asignación de T0 requiere intención explícita: pasa `retention_tier: "T0"` en la llamada `remember`, o adjunta la memoria a una categoría. Esto asegura que las memorias fundacionales siempre sean designadas deliberadamente.
