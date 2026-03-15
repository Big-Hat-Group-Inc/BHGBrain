# BHGBrain

为 MCP 客户端（Claude、Codex、OpenClaw 等）提供持久化的向量记忆存储。

BHGBrain 将记忆存储于 SQLite（元数据 + 全文）和 Qdrant（语义向量）中，通过 stdio 或 HTTP 以 MCP 协议对外暴露。其设计目标是为 AI 智能体提供一个跨会话、持久可搜索的第二大脑。

---

## 目录

1. [前置要求](#前置要求)
2. [Qdrant 安装配置](#qdrant-安装配置)
3. [安装](#安装)
4. [配置](#配置)
5. [环境变量](#环境变量)
6. [启动服务器](#启动服务器)
7. [MCP 客户端配置](#mcp-客户端配置)
8. [引导提示词](#引导提示词)
9. [CLI 参考](#cli-参考)
10. [行为说明](#行为说明)

---

## 前置要求

| 依赖项 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20.0.0 | 推荐使用 LTS 版本 |
| Qdrant | ≥ 1.9 | 必须在启动 BHGBrain 之前运行 |
| OpenAI API key | — | 用于生成向量嵌入（默认使用 `text-embedding-3-small`） |

---

## Qdrant 安装配置

BHGBrain **需要一个外部 Qdrant 实例**。即使在默认的 `embedded` 模式下，服务器也会连接到 `http://localhost:6333`——BHGBrain 本身不内置 Qdrant 二进制文件，需要您自行运行。

### 方案 A：Docker（推荐）

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

验证是否正常运行：

```bash
curl http://localhost:6333/health
# → {"title":"qdrant - vector search engine","version":"..."}
```

### 方案 B：Docker Compose

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

### 方案 C：原生二进制文件

从 [https://github.com/qdrant/qdrant/releases](https://github.com/qdrant/qdrant/releases) 下载后运行：

```bash
./qdrant
```

### 方案 D：Qdrant Cloud（外部模式）

在配置文件中将 `qdrant.mode` 设置为 `external`，并将 `external_url` 指向您的云集群 URL。将 `qdrant.api_key_env` 设置为存储 Qdrant API 密钥的环境变量名称。

---

## 安装

```bash
git clone https://github.com/Big-Hat-Group-Inc/BHGBrain.git
cd BHGBrain
npm install
npm run build
```

全局安装为 CLI 工具：

```bash
npm install -g .
bhgbrain --help
```

---

## 配置

BHGBrain 从以下路径加载配置文件：

- **Windows：** `%LOCALAPPDATA%\BHGBrain\config.json`
- **Linux/macOS：** `~/.bhgbrain/config.json`

首次运行时会自动创建带有默认值的配置文件，可编辑该文件以自定义行为。

### 关键配置字段

```jsonc
{
  // Qdrant 连接模式："embedded" = localhost:6333，"external" = 自定义 URL
  "qdrant": {
    "mode": "embedded",
    "embedded_path": "./qdrant",
    "external_url": null,
    "api_key_env": null
  },

  // 嵌入模型（OpenAI）
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY",
    "dimensions": 1536
  },

  // HTTP 传输（用于远程 MCP 客户端或 mcporter）
  "transport": {
    "http": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3721,
      "bearer_token_env": "BHGBRAIN_TOKEN"
    },
    "stdio": {
      "enabled": true
    }
  },

  // 记忆默认值
  "defaults": {
    "namespace": "global",
    "collection": "general",
    "recall_limit": 5,
    "min_score": 0.6
  }
}
```

完整 schema 及所有默认值请参见 `src/config/index.ts`。

---

## 环境变量

| 变量名 | 是否必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 是（用于嵌入） | OpenAI API 密钥。缺失时服务器以**降级模式**启动。 |
| `BHGBRAIN_TOKEN` | 是（HTTP 非回环地址） | HTTP 认证所需的 Bearer 令牌。在非回环绑定下为必填项，除非设置 `security.allow_unauthenticated_http: true`。 |
| `BHGBRAIN_EXTRACTION_API_KEY` | 否 | 用于提取/流水线模型的 OpenAI 密钥。未设置时回退到 `OPENAI_API_KEY`。 |

生成令牌：

```bash
bhgbrain server token
# 或：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 启动服务器

### stdio 模式（MCP over stdin/stdout）

```bash
# 开发模式（无需构建）
npm run dev

# 生产模式
node dist/index.js
```

### HTTP 模式

HTTP 默认在 `127.0.0.1:3721` 上启用。启动前请先设置 `BHGBRAIN_TOKEN`：

```bash
export OPENAI_API_KEY=sk-...
export BHGBRAIN_TOKEN=<your-token>
node dist/index.js
```

健康检查（无需认证）：

```bash
curl http://127.0.0.1:3721/health
```

---

## MCP 客户端配置

### Claude Desktop（`claude_desktop_config.json`）

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

### OpenClaw / mcporter（HTTP 传输）

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "http",
      "url": "http://127.0.0.1:3721",
      "env": {
        "BHGBRAIN_TOKEN": "<your-token>"
      }
    }
  }
}
```

---

## 引导提示词

`BootstrapPrompt.txt` 包含一个结构化的访谈提示词，用于与 AI 智能体共同构建**工作第二大脑档案**。

当您需要接入一个新的 AI 助手，或希望将丰富的结构化工作上下文、实体信息、租户信息及消歧义规则填充到 BHGBrain 时，可使用此文件。

### 使用方法

1. 与您的 AI 助手（Claude、GPT-4 等）开启一个全新对话。
2. 将 `BootstrapPrompt.txt` 的全部内容粘贴为第一条消息。
3. 让智能体逐章节对您进行访谈。
4. 访谈结束后，智能体将生成一份结构化档案，您可通过 `bhgbrain.remember` 调用（或 `mcporter call bhgbrain.remember`）将其保存到 BHGBrain。

### 涵盖内容

访谈共分 10 个章节：

| 章节 | 采集内容 |
|---|---|
| 1. 身份与角色 | 姓名、职衔、主要职责与对客职责 |
| 2. 工作职责 | 您负责的事项及您影响的范围 |
| 3. 目标 | 30 天、季度、年度优先事项 |
| 4. 沟通风格 | 您希望信息呈现的方式 |
| 5. 工作模式 | 战略思考时段与执行时段 |
| 6. 工具与系统 | 可信来源、关键平台 |
| 7. 公司与实体图谱 | 所有组织、客户、产品及其关系 |
| 8. GitHub / 仓库结构 | 组织、仓库、归属责任人 |
| 9. 租户与环境图谱 | Azure 租户、开发/预发布/生产环境 |
| 10. 操作规则 | 命名规范、消歧义规则、默认假设 |

输出结果将包含全部 10 个章节的整洁结构化档案及消歧义指南——这正是 BHGBrain 可靠回答工作相关问题所需的基础数据。

---

## CLI 参考

```bash
bhgbrain list                    # 列出最近的记忆
bhgbrain search <query>          # 混合搜索
bhgbrain show <id>               # 显示完整记忆
bhgbrain forget <id>             # 删除一条记忆
bhgbrain stats                   # 数据库 + 集合统计信息
bhgbrain health                  # 系统健康检查
bhgbrain gc                      # 垃圾回收
bhgbrain gc --consolidate        # 垃圾回收 + 合并整理
bhgbrain audit                   # 显示审计日志
bhgbrain category list           # 列出所有分类
bhgbrain category get <name>     # 获取分类内容
bhgbrain category set <name>     # 设置分类内容
bhgbrain backup create           # 创建备份
bhgbrain backup list             # 列出所有备份
bhgbrain backup restore <path>   # 从备份恢复
bhgbrain server start            # 启动 MCP 服务器
bhgbrain server status           # 检查服务器健康状态
bhgbrain server token            # 生成新的 Bearer 令牌
```

---

## 行为说明

### 集合删除语义

`collections.delete` 默认拒绝删除非空集合。使用 `force: true` 可强制覆盖：

```json
{
  "action": "delete",
  "namespace": "global",
  "name": "general",
  "force": true
}
```

### 备份恢复激活

`backup.restore` 在返回成功前会重新加载运行时 SQLite 状态。当恢复数据立即生效时，恢复响应中会包含 `activated: true`。

### HTTP 安全加固

- `/health` 端点有意设计为无需认证，以兼容探针检测。
- 速率限制基于可信请求身份（IP）进行计数，不采用 `x-client-id` 作为执行依据。
- `memory://list` 对 `limit` 参数强制限定在 `1..100` 范围内；非法值将返回 `INVALID_INPUT`。

### 认证失败关闭策略

- 非回环 HTTP 绑定默认要求提供 Bearer 令牌。
- 若 `BHGBRAIN_TOKEN` 未设置且主机为非回环地址，服务器将拒绝启动。
- 若要明确允许未认证的外部访问，请在配置文件中设置 `security.allow_unauthenticated_http: true`，启动时将记录一条醒目警告日志。

### 嵌入降级模式

- 若启动时嵌入服务提供商的凭据缺失，服务器将以**降级模式**启动，而非直接崩溃。
- 依赖嵌入的操作（语义搜索、记忆写入）在请求时将返回 `EMBEDDING_UNAVAILABLE`。
- 健康探针将嵌入状态报告为 `degraded`，不会发起真实的 API 调用。

### MCP 响应契约

- 工具调用响应包含结构化 JSON 载荷。
- 错误响应在 MCP 协议中设置 `isError: true`，供客户端路由使用。
- 参数化资源（`memory://{id}`、`category://{name}`、`collection://{name}`）通过 `resources/templates/list` 以 MCP 资源模板的形式对外暴露。

### 搜索与分页

- **集合作用域：** 全文搜索和混合搜索在语义候选集和词法候选集中均遵从调用方提供的 `collection` 过滤条件。
- **稳定分页：** `memory://list` 使用复合游标（`created_at|id`）实现确定性排序，时间戳相同的行在跨页时不会被跳过或重复返回。
- **依赖故障透传：** 语义搜索会将 Qdrant 故障作为显式错误向上传播，而非静默返回空结果。

### 运维可观测性

- **有界指标：** 直方图值使用有界环形缓冲区（保留最近 1000 个样本）。
- **指标语义：** 直方图指标以 `_avg` 和 `_count` 为后缀输出。
- **原子写入：** 数据库和备份文件的写入采用"先写临时文件再重命名"策略，防止崩溃时产生截断的不完整文件。
- **延迟刷新：** 读路径的访问元数据（触达计数）采用有界异步批处理（5 秒窗口），而非每次请求时同步全量刷库。
- **跨存储一致性：** 若对应的 Qdrant 操作失败，SQLite 更新将被回滚。
