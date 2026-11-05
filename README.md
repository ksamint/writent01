# Writer Tracker / 作家追踪器

> Bilingual content management system for tracking thought leaders and literary masters.
> 双语内容管理系统，用于追踪思想领袖与文学巨匠。

## Features / 功能特点

- **Bilingual Display / 双语展示** - Chinese and English content
- **REST API** - Full CRUD operations for content management
- **MCP Tool** - Machine Context Protocol for AI integration
- **Update Tracking / 更新追踪** - RSS feed monitoring
- **Cloudflare Native / Cloudflare 原生** - Workers + D1 + Pages
- **Git Auto-push / Git 自动推送** - Version control integration

## Deploy to Cloudflare / 部署到 Cloudflare

### Prerequisites

```bash
npm install -g wrangler
```

### 1. Create D1 Database

```bash
wrangler d1 create writer-tracker-db
# Copy the database_id into wrangler.toml [[d1_databases]]
```

### 2. Deploy Worker

```bash
npm install
wrangler deploy
```

### 3. Seed Database

```bash
wrangler d1 execute writer-tracker-db --file=data/seed.sql
```

### 4. Set Secrets

```bash
wrangler secret put WRITER_TRACKER_API_KEY
```

### 5. Deploy Frontend (Pages)

```bash
wrangler pages deploy public
```

### 6. Configure Pages Redirects

Update `public/_redirects` with your Worker URL, then re-deploy Pages.

### Deploying updates / 日常部署

There is no GitHub Actions workflow (owner decision 2026-11-05); deploys run from the operator's
machine:

```bash
export CLOUDFLARE_API_TOKEN=...   # from your shell or secret manager, never committed
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy                    # = scripts/deploy.sh all: worker, seed, pages
scripts/deploy.sh worker          # npm install + wrangler deploy
scripts/deploy.sh seed            # wrangler d1 execute writer-tracker-db --file=data/seed.sql
scripts/deploy.sh pages           # wrangler pages deploy public --project-name=writer-tracker
```

The script refuses unless `main` or `initial-commit` is checked out, the working tree is clean and
`HEAD` equals `origin/<branch>`, and it builds from a clean `git archive` export of `HEAD`. The
`seed` step runs without `--remote`, as the old workflow did, so with wrangler 3 it only touches
local D1 state; seed the production database by hand with `--remote` when needed.

### Email (Optional)

Set `SENDING_DOMAIN` and `MAIL_TO` in `wrangler.toml` [vars]. Requires Cloudflare DNS with SPF record for MailChannels.

---

## Local Development / 本地开发

```bash
# Install dependencies / 安装依赖
npm install
cd mcp-writer-tracker && npm install && cd ..

# Start services / 启动服务
./restart.sh start

# Or with API key / 或设置API密钥启动
WRITER_TRACKER_API_KEY=your-secret-key ./restart.sh start
```

### Cloudflare Local Dev

```bash
npm run cf:dev
# Worker runs at http://localhost:8787
```

## Access / 访问

- **Main Server**: http://localhost:3000
- **API Health**: http://localhost:3000/api/health

## API Documentation / API 文档

### Public Endpoints / 公开端点

| Method | Endpoint | Description / 描述 |
|--------|----------|-------------------|
| GET | `/api/writers` | Get all writers / 获取所有作家 |
| GET | `/api/writers/modern` | Get modern writers / 获取现代作家 |
| GET | `/api/writers/historical` | Get historical writers / 获取历史作家 |
| GET | `/api/writers/:id` | Get single writer / 获取单个作家 |
| GET | `/api/search?q=` | Search writers / 搜索作家 |
| GET | `/api/check-updates/:id` | Check RSS updates / 检查RSS更新 |
| GET | `/api/health` | Health check / 健康检查 |

### Protected Endpoints (requires API key) / 受保护端点（需要API密钥）

| Method | Endpoint | Description / 描述 |
|--------|----------|-------------------|
| POST | `/api/writers/modern` | Add modern writer / 添加现代作家 |
| PUT | `/api/writers/modern/:id` | Update modern writer / 更新现代作家 |
| DELETE | `/api/writers/modern/:id` | Delete modern writer / 删除现代作家 |
| POST | `/api/writers/modern/:id/articles` | Add article / 添加文章 |
| DELETE | `/api/writers/modern/:id/articles?url=` | Delete article / 删除文章 |
| POST | `/api/writers/historical` | Add historical writer / 添加历史作家 |
| PUT | `/api/writers/historical/:id` | Update historical writer / 更新历史作家 |
| DELETE | `/api/writers/historical/:id` | Delete historical writer / 删除历史作家 |

### Authentication / 认证

Add API key to request header:
```bash
curl -H "X-API-Key: your-api-key" http://localhost:3000/api/writers/modern
```

Or use query parameter:
```bash
curl "http://localhost:3000/api/writers/modern?api_key=your-api-key"
```

## MCP Tool / MCP 工具

The MCP server runs on port 3111 and provides:

| Tool | Description / 描述 |
|------|-------------------|
| `list-writers` | List all writers / 列出所有作家 |
| `check-updates` | Check writer updates / 检查更新 |
| `get-history` | Get update history / 获取更新历史 |
| `search-writers` | Search writers / 搜索作家 |
| `get-all-updates` | Check all writers / 检查所有作家 |
| `add-writer` | Add writer (requires API key) / 添加作家 |
| `update-writer` | Update writer (requires API key) / 更新作家 |
| `delete-writer` | Delete writer (requires API key) / 删除作家 |

## Script Commands / 脚本命令

```bash
./restart.sh start    # Start services + git push / 启动服务+git推送
./restart.sh stop     # Stop services / 停止服务
./restart.sh restart  # Restart / 重启
./restart.sh status   # Show status / 显示状态
./restart.sh logs     # Show logs / 显示日志
./restart.sh git      # Git status / Git状态
./restart.sh push     # Git push only / 仅Git推送
```

## Environment Variables / 环境变量

| Variable | Description / 描述 |
|----------|-------------------|
| `WRITER_TRACKER_API_KEY` | API key for content management / 内容管理API密钥 |
| `GIT_REMOTE_URL` | Git repository URL / Git仓库地址 |
| `GIT_BRANCH` | Git branch (default: main) / Git分支 |
| `AUTO_PUSH` | Auto push on start (default: true) / 启动时自动推送 |

## Example / 示例

```bash
# Start with API key and git
WRITER_TRACKER_API_KEY=my-secret-key \
GIT_REMOTE_URL=https://github.com/username/writent01.git \
./restart.sh start

# Add new writer via API
curl -X POST http://localhost:3000/api/writers/modern \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-secret-key" \
  -d '{
    "id": "new-writer",
    "name": "New Writer / 新作家",
    "identity": "Description / 描述",
    "website": "https://example.com",
    "articles": [{"title": "Article / 文章", "url": "https://example.com/article"}]
  }'
```

## Writers List / 作家列表

### Modern Writers / 现代作家 (30)

Naval Ravikant, Shane Parrish, Adam Grant, Daniel Kahneman, Annie Duke, Morgan Housel, James Clear, Ryan Holiday, Brené Brown, Seth Godin, Ben Thompson, Lenny Rachitsky, Noah Smith, Azeem Azhar, Gergely Orosz, David Perell, Julian Shapiro, Tim Denning, Justin Welsh, Sahil Bloom, Amy Edmondson, Jim Collins, Rita McGrath, Amy Webb, Scott D. Anthony, Peter Winick, Paul Polman, Simon Sinek, Richard Branson, Gini Dietrich

### Historical Writers / 历史作家 (13)

Homer, Sophocles, Virgil, Dante, Shakespeare, Voltaire, Jane Austen, Charles Dickens, Fyodor Dostoevsky, Leo Tolstoy, Franz Kafka, James Joyce, George Orwell

## License / 许可证

MIT