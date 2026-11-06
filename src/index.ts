import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './auth';
import * as db from './db';
import { getMCPTools } from './mcp';
import { parseRSS } from './rss';
import { sendRequestEmail } from './email';

// ── Environment ────────────────────────────────────────

interface Env {
  DB: D1Database;
  WRITER_TRACKER_API_KEY: string;
  SENDING_DOMAIN: string;
  MAIL_TO: string;
}

// ── App Setup ──────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
}));

// Error handling
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

// DB initialization on first request
let dbInitialized = false;

async function ensureDB(c: Context<{ Bindings: Env }>) {
  if (!dbInitialized) {
    await db.initDB(c.env.DB);
    dbInitialized = true;
  }
}

// ── Auth helper ────────────────────────────────────────

function auth(c: Context<{ Bindings: Env }>) {
  return authMiddleware(c.env.WRITER_TRACKER_API_KEY)(c, async () => {});
}

// ── Health ─────────────────────────────────────────────

app.get('/api/health', async (c) => {
  await ensureDB(c);
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!c.env.WRITER_TRACKER_API_KEY,
    platform: 'cloudflare-workers',
  });
});

// ── Writers - Public ───────────────────────────────────

app.get('/api/writers', async (c) => {
  await ensureDB(c);
  const [modern, historical] = await Promise.all([
    db.getWritersByType(c.env.DB, 'modern'),
    db.getWritersByType(c.env.DB, 'historical'),
  ]);
  return c.json({
    modern,
    historical,
    total: { modern: modern.length, historical: historical.length }
  });
});

app.get('/api/writers/modern', async (c) => {
  await ensureDB(c);
  const writers = await db.getWritersByType(c.env.DB, 'modern');
  return c.json({ writers, total: writers.length });
});

app.get('/api/writers/historical', async (c) => {
  await ensureDB(c);
  const writers = await db.getWritersByType(c.env.DB, 'historical');
  return c.json({ writers, total: writers.length });
});

app.get('/api/writers/:id', async (c) => {
  await ensureDB(c);
  const writer = await db.getWriterById(c.env.DB, c.req.param('id'));
  if (!writer) return c.json({ error: 'Writer not found' }, 404);
  return c.json({ writer });
});

app.get('/api/search', async (c) => {
  await ensureDB(c);
  const q = c.req.query('q') || '';
  if (!q.trim()) return c.json({ results: [], count: 0 });
  const results = await db.searchWriters(c.env.DB, q);
  return c.json({ results, count: results.length });
});

// ── Writers - Protected ────────────────────────────────

app.post('/api/writers/modern', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const body = await c.req.json();
  const id = body.id || body.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const existing = await db.getWriterById(c.env.DB, id);
  if (existing) return c.json({ error: 'Writer already exists' }, 409);

  await db.createWriter(c.env.DB, {
    id,
    name: body.name || '',
    identity: body.identity || '',
    website: body.website || '',
    twitter: body.twitter || '',
    type: 'modern',
    feed_url: body.feedUrl || (body.website ? `${body.website}/feed` : ''),
    articles: body.articles || [],
  });

  const writer = await db.getWriterById(c.env.DB, id);
  return c.json({ success: true, writer }, 201);
});

app.put('/api/writers/modern/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  const body = await c.req.json();
  // Map camelCase API fields to snake_case DB columns
  if (body.feedUrl !== undefined) {
    body.feed_url = body.feedUrl;
    delete body.feedUrl;
  }
  await db.updateWriter(c.env.DB, id, body);
  const updated = await db.getWriterById(c.env.DB, id);
  return c.json({ success: true, writer: updated });
});

app.delete('/api/writers/modern/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  await db.deleteWriter(c.env.DB, id);
  return c.json({ success: true, deleted: writer });
});

app.post('/api/writers/modern/:id/articles', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  const body = await c.req.json();
  if (!body.title || !body.url) {
    return c.json({ error: 'title and url are required' }, 400);
  }
  await db.addWriterArticle(c.env.DB, id, body.title, body.url);
  const updated = await db.getWriterById(c.env.DB, id);
  return c.json({ success: true, writer: updated }, 201);
});

app.delete('/api/writers/modern/:id/articles', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'url query parameter required' }, 400);

  const deleted = await db.deleteWriterArticle(c.env.DB, id, url);
  if (!deleted) return c.json({ error: 'Article not found' }, 404);

  return c.json({ success: true });
});

app.post('/api/writers/historical', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const body = await c.req.json();
  const id = body.id || body.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const existing = await db.getWriterById(c.env.DB, id);
  if (existing) return c.json({ error: 'Writer already exists' }, 409);

  await db.createWriter(c.env.DB, {
    id,
    name: body.name || '',
    era: body.era || '',
    masterpiece: body.masterpiece || '',
    description: body.description || '',
    type: 'historical',
    identity: '',
    website: '',
  });

  const writer = await db.getWriterById(c.env.DB, id);
  return c.json({ success: true, writer }, 201);
});

app.put('/api/writers/historical/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  const body = await c.req.json();
  // Map camelCase API fields to snake_case DB columns
  if (body.feedUrl !== undefined) {
    body.feed_url = body.feedUrl;
    delete body.feedUrl;
  }
  await db.updateWriter(c.env.DB, id, body);
  const updated = await db.getWriterById(c.env.DB, id);
  return c.json({ success: true, writer: updated });
});

app.delete('/api/writers/historical/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  await db.deleteWriter(c.env.DB, id);
  return c.json({ success: true, deleted: writer });
});

// ── RSS Check Updates ──────────────────────────────────

app.get('/api/check-updates/:id', async (c) => {
  await ensureDB(c);
  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  try {
    const website = (writer.website || '').replace(/\/+$/, '');
    const feedUrl = writer.feed_url || `${website}/feed`;
    const feed = await parseRSS(feedUrl);
    const items = feed.items.slice(0, 10).map(item => ({
      title: item.title,
      url: item.link,
      date: item.pubDate,
    }));

    return c.json({ writer: writer.name, updates: items, feedTitle: feed.title });
  } catch (e: any) {
    return c.json({ writer: writer.name, error: e.message });
  }
});

// ── Update History ────────────────────────────────────

app.get('/api/updates/history', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  // Return update history for all writers
  const writers = await db.getWritersByType(c.env.DB, 'modern');
  const result: Record<string, any> = {};
  for (const w of writers) {
    result[w.id] = await db.getUpdateHistory(c.env.DB, w.id, 50);
  }
  return c.json(result);
});

app.get('/api/updates/history/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const writer = await db.getWriterById(c.env.DB, id);
  if (!writer) return c.json({ error: 'Writer not found' }, 404);

  const history = await db.getUpdateHistory(c.env.DB, id, 50);
  return c.json({ writerId: id, history });
});

// ── Articles - Public ──────────────────────────────────

app.get('/api/articles', async (c) => {
  await ensureDB(c);
  const q: db.ArticleQuery = {
    tag: c.req.query('tag') || undefined,
    writerId: c.req.query('writerId') || undefined,
    source: c.req.query('source') || undefined,
    sort: c.req.query('sort') || 'desc',
    limit: parseInt(c.req.query('limit') || '50'),
    offset: parseInt(c.req.query('offset') || '0'),
  };
  const articles = await db.getArticles(c.env.DB, q);
  return c.json({ articles, total: articles.length });
});

app.get('/api/articles/feed', async (c) => {
  await ensureDB(c);
  const limit = parseInt(c.req.query('limit') || '20');
  const articles = await db.getArticleFeed(c.env.DB, limit);
  return c.json({ articles });
});

app.get('/api/articles/tags', async (c) => {
  await ensureDB(c);
  const tags = await db.getArticleTags(c.env.DB);
  return c.json({ tags });
});

app.get('/api/articles/:id', async (c) => {
  await ensureDB(c);
  const article = await db.getArticleById(c.env.DB, c.req.param('id'));
  if (!article) return c.json({ error: 'Article not found' }, 404);
  return c.json({ article });
});

// ── Articles - Protected ───────────────────────────────

app.post('/api/articles', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const body = await c.req.json();
  const id = body.id || await db.getNextArticleId(c.env.DB);

  const article: db.Article = {
    id,
    title: body.title || 'Untitled',
    url: body.url || '',
    writerId: body.writerId || '',
    writerName: body.writerName || '',
    tags: body.tags || [],
    excerpt: body.excerpt || '',
    content: body.content || '',
    contentSnippet: body.contentSnippet || body.excerpt || '',
    source: body.source || 'manual',
    publishedAt: body.publishedAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  if (!article.url || !article.writerId) {
    return c.json({ error: 'url and writerId are required' }, 400);
  }

  // Check for duplicate URL
  const existing = await db.getArticleByUrl(c.env.DB, article.url);
  if (existing) return c.json({ error: 'Article with this URL already exists' }, 409);

  await db.createArticle(c.env.DB, article);
  return c.json({ success: true, article }, 201);
});

app.put('/api/articles/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const existing = await db.getArticleById(c.env.DB, id);
  if (!existing) return c.json({ error: 'Article not found' }, 404);

  const body = await c.req.json();
  await db.updateArticle(c.env.DB, id, body);
  const updated = await db.getArticleById(c.env.DB, id);
  return c.json({ success: true, article: updated });
});

app.delete('/api/articles/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const deleted = await db.deleteArticle(c.env.DB, id);
  if (!deleted) return c.json({ error: 'Article not found' }, 404);
  return c.json({ success: true, deleted: { id } });
});

// ── Bulk RSS Fetch ─────────────────────────────────────

app.post('/api/fetch-articles', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const writerId = c.req.query('writerId');
  const modernWriters = writerId
    ? [await db.getWriterById(c.env.DB, writerId)].filter(Boolean) as db.Writer[]
    : await db.getWritersByType(c.env.DB, 'modern');

  let fetched = 0;
  let newArticles = 0;
  let skipped = 0;

  for (const writer of modernWriters) {
    // Detect Substack writers and use their feed URL
    let primaryUrl = writer.feed_url || writer.website || '';
    if (writer.articles && writer.articles[0]?.url?.includes('substack')) {
      const sm = writer.articles[0].url.match(/https?:\/\/([^.]+)\.substack\.com/);
      if (sm) primaryUrl = `https://${sm[1]}.substack.com/feed`;
    }

    try {
      const feed = await parseRSS(primaryUrl);
      for (const item of feed.items) {
        fetched++;
        const articleUrl = item.link;
        if (articleUrl) {
          const exists = await db.getArticleByUrl(c.env.DB, articleUrl);
          if (exists) { skipped++; continue; }
        }

        const articleId = await db.getNextArticleId(c.env.DB);
        await db.createArticle(c.env.DB, {
          id: articleId,
          title: item.title || 'Untitled',
          url: articleUrl,
          writerId: writer.id,
          writerName: writer.name,
          tags: [],
          excerpt: item.contentSnippet || '',
          content: item.content || '',
          contentSnippet: item.contentSnippet || '',
          source: 'rss',
          publishedAt: item.pubDate || new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
        newArticles++;
      }
    } catch (e: any) {
      // Skip writers whose feeds can't be fetched
    }
  }

  return c.json({ fetched, new: newArticles, skipped });
});

// ── Article Proxy ──────────────────────────────────────

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname;
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname)) return false;
    if (hostname.startsWith('10.') || hostname.startsWith('172.16.') ||
        hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) return false;
    if (hostname.match(/^127\.\d+\.\d+\.\d+$/)) return false;
    // Block Cloudflare metadata endpoint
    if (hostname === 'metadata.google.internal') return false;
    return true;
  } catch { return false; }
}

app.get('/api/articles/:id/proxy', async (c) => {
  await ensureDB(c);
  const article = await db.getArticleById(c.env.DB, c.req.param('id'));
  if (!article) return c.json({ error: 'Article not found' }, 404);
  if (!isSafeUrl(article.url)) return c.json({ error: 'Unsafe URL' }, 400);

  try {
    const resp = await fetch(article.url, {
      headers: { 'User-Agent': 'WriterTracker/2.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return c.json({ error: `Could not fetch article: HTTP ${resp.status}` }, 502);

    const contentType = resp.headers.get('content-type') || 'text/html';
    let body = await resp.text();
    if (body.length > 5 * 1024 * 1024) {
      body = body.substring(0, 5 * 1024 * 1024);
    }
    return new Response(body, {
      headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e: any) {
    return c.json({ error: 'Failed to fetch article', details: e.message }, 502);
  }
});

// ── Markdown Download ──────────────────────────────────

app.get('/api/articles/:id/markdown', async (c) => {
  await ensureDB(c);
  const article = await db.getArticleById(c.env.DB, c.req.param('id'));
  if (!article) return c.json({ error: 'Article not found' }, 404);

  const body = article.content || article.contentSnippet || article.excerpt || 'No content available.';
  const tags = (article.tags || []).join(', ');
  const published = article.publishedAt
    ? new Date(article.publishedAt).toLocaleDateString('zh-CN')
    : 'Unknown';

  const markdown = [
    `# ${article.title}`,
    '',
    `**Author:** ${article.writerName}`,
    `**Published:** ${published}`,
    `**Tags:** ${tags || 'none'}`,
    `**Original:** [${article.url}](${article.url})`,
    '',
    '---',
    '',
    body,
  ].join('\n');

  const filename = article.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60) + '.md';

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// ── Requests ───────────────────────────────────────────

app.post('/api/requests', async (c) => {
  await ensureDB(c);
  const body = await c.req.json();

  if (!body.writerName || body.writerName.trim().length === 0) {
    return c.json({ error: 'writerName is required' }, 400);
  }

  // Get all existing requests to compute next ID
  const existing = await db.getRequests(c.env.DB);
  const nextId = db.getNextRequestId(existing);

  const request: db.WriterRequest = {
    id: nextId,
    writerName: body.writerName.trim(),
    website: (body.website || '').trim(),
    reason: (body.reason || '').trim(),
    submittedAt: new Date().toISOString(),
  };

  await db.createRequest(c.env.DB, request);

  // Send email if configured (non-blocking)
  c.executionCtx?.waitUntil(
    sendRequestEmail(request, c.env.SENDING_DOMAIN, c.env.MAIL_TO)
  );

  return c.json({ success: true, request }, 201);
});

app.get('/api/requests', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const requests = await db.getRequests(c.env.DB);
  return c.json({ requests, total: requests.length });
});

app.delete('/api/requests/:id', async (c) => {
  await ensureDB(c);
  const authed = await auth(c);
  if (authed) return authed;

  const id = c.req.param('id');
  const deleted = await db.deleteRequest(c.env.DB, id);
  if (!deleted) return c.json({ error: 'Request not found' }, 404);
  return c.json({ success: true, deleted: { id } });
});

// ── MCP Routes ─────────────────────────────────────────

const mcpTools = getMCPTools();

app.get('/mcp/tools', (c) => {
  const toolList = Object.entries(mcpTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return c.json({ tools: toolList });
});

app.post('/mcp/tools/call', async (c) => {
  const body = await c.req.json();
  const { tool, parameters } = body;

  if (!mcpTools[tool]) {
    return c.json({ error: `Unknown tool: ${tool}` }, 400);
  }

  try {
    const result = await mcpTools[tool].handler(
      parameters || {},
      c.env.DB,
      c.env.WRITER_TRACKER_API_KEY
    );
    return c.json({ result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Static files ───────────────────────────────────────

// public/ is served by Workers static assets ([assets] in wrangler.toml):
// requests that match a file never reach this app.

// ── Export ─────────────────────────────────────────────

export default app;
