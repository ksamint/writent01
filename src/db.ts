import type { D1Database } from '@cloudflare/workers-types';

// ── Schema ──────────────────────────────────────────────

// One statement per `;`. Also applied to the remote database by
// scripts/deploy.sh seed, so keep it to CREATE ... IF NOT EXISTS.
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS writers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      identity TEXT DEFAULT '',
      website TEXT DEFAULT '',
      twitter TEXT DEFAULT '',
      era TEXT DEFAULT '',
      masterpiece TEXT DEFAULT '',
      description TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'modern',
      feed_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS writer_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      writer_id TEXT NOT NULL REFERENCES writers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      writer_id TEXT NOT NULL REFERENCES writers(id),
      writer_name TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      excerpt TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_snippet TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      published_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      writer_name TEXT NOT NULL,
      website TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      submitted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      writer_id TEXT NOT NULL REFERENCES writers(id),
      title TEXT DEFAULT '',
      url TEXT DEFAULT '',
      published_at TEXT DEFAULT '',
      checked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_articles_writer ON articles(writer_id);
    CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
    CREATE INDEX IF NOT EXISTS idx_articles_tags ON articles(tags);
    CREATE INDEX IF NOT EXISTS idx_writers_type ON writers(type);
`;

export async function initDB(db: D1Database): Promise<void> {
  // D1's exec() runs every line as its own statement, so multi-line
  // CREATE TABLEs fail there; run the statements as one batch instead.
  const statements = SCHEMA_SQL.split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0)
    .map((sql) => db.prepare(sql));
  await db.batch(statements);
}

// ── Writers ─────────────────────────────────────────────

export interface Writer {
  id: string;
  name: string;
  identity?: string;
  website?: string;
  twitter?: string;
  era?: string;
  masterpiece?: string;
  description?: string;
  type: string;
  feed_url?: string;
  articles?: { title: string; url: string }[];
}

export async function getAllWriters(db: D1Database): Promise<Writer[]> {
  const { results } = await db.prepare(
    'SELECT * FROM writers ORDER BY type, name'
  ).all();
  return (results || []).map(rowToWriter);
}

export async function getWritersByType(db: D1Database, type: string): Promise<Writer[]> {
  const { results } = await db.prepare(
    'SELECT * FROM writers WHERE type = ? ORDER BY name'
  ).bind(type).all();

  // Load featured articles for each writer
  const writers = (results || []).map(rowToWriter);
  for (const w of writers) {
    w.articles = await getWriterArticles(db, w.id);
  }
  return writers;
}

export async function getWriterById(db: D1Database, id: string): Promise<Writer | null> {
  const row = await db.prepare('SELECT * FROM writers WHERE id = ?').bind(id).first();
  if (!row) return null;
  const w = rowToWriter(row);
  w.articles = await getWriterArticles(db, w.id);
  return w;
}

export async function searchWriters(db: D1Database, query: string): Promise<Writer[]> {
  const q = `%${query}%`;
  const { results } = await db.prepare(
    'SELECT * FROM writers WHERE name LIKE ? OR identity LIKE ? OR website LIKE ? ORDER BY name LIMIT 20'
  ).bind(q, q, q).all();
  return (results || []).map(rowToWriter);
}

export async function createWriter(db: D1Database, writer: Writer): Promise<void> {
  await db.prepare(`
    INSERT INTO writers (id, name, identity, website, twitter, era, masterpiece, description, type, feed_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    writer.id, writer.name,
    writer.identity || '', writer.website || '',
    writer.twitter || '', writer.era || '',
    writer.masterpiece || '', writer.description || '',
    writer.type || 'modern', writer.feed_url || ''
  ).run();

  if (writer.articles) {
    for (const a of writer.articles) {
      await db.prepare(
        'INSERT INTO writer_articles (writer_id, title, url) VALUES (?, ?, ?)'
      ).bind(writer.id, a.title, a.url).run();
    }
  }
}

export async function updateWriter(db: D1Database, id: string, updates: Partial<Writer>): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.identity !== undefined) { fields.push('identity = ?'); values.push(updates.identity); }
  if (updates.website !== undefined) { fields.push('website = ?'); values.push(updates.website); }
  if (updates.twitter !== undefined) { fields.push('twitter = ?'); values.push(updates.twitter); }
  if (updates.era !== undefined) { fields.push('era = ?'); values.push(updates.era); }
  if (updates.masterpiece !== undefined) { fields.push('masterpiece = ?'); values.push(updates.masterpiece); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.feed_url !== undefined) { fields.push('feed_url = ?'); values.push(updates.feed_url); }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    values.push(id);
    await db.prepare(`UPDATE writers SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  // Replace articles if provided
  if (updates.articles !== undefined) {
    await db.prepare('DELETE FROM writer_articles WHERE writer_id = ?').bind(id).run();
    for (const a of updates.articles) {
      await db.prepare(
        'INSERT INTO writer_articles (writer_id, title, url) VALUES (?, ?, ?)'
      ).bind(id, a.title, a.url).run();
    }
  }
}

export async function deleteWriter(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM writers WHERE id = ?').bind(id).run();
  return (meta?.changes || 0) > 0;
}

// ── Writer Articles (featured) ─────────────────────────

export async function getWriterArticles(db: D1Database, writerId: string): Promise<{ title: string; url: string }[]> {
  const { results } = await db.prepare(
    'SELECT title, url FROM writer_articles WHERE writer_id = ?'
  ).bind(writerId).all();
  return (results || []) as { title: string; url: string }[];
}

export async function addWriterArticle(db: D1Database, writerId: string, title: string, url: string): Promise<void> {
  await db.prepare(
    'INSERT INTO writer_articles (writer_id, title, url) VALUES (?, ?, ?)'
  ).bind(writerId, title, url).run();
}

export async function deleteWriterArticle(db: D1Database, writerId: string, url: string): Promise<boolean> {
  const { meta } = await db.prepare(
    'DELETE FROM writer_articles WHERE writer_id = ? AND url = ?'
  ).bind(writerId, url).run();
  return (meta?.changes || 0) > 0;
}

// ── Articles ────────────────────────────────────────────

export interface Article {
  id: string;
  title: string;
  url: string;
  writerId: string;
  writerName: string;
  tags: string[];
  excerpt: string;
  content: string;
  contentSnippet: string;
  source: string;
  publishedAt: string;
  createdAt: string;
}

export interface ArticleQuery {
  tag?: string;
  writerId?: string;
  source?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

function rowToArticle(row: any): Article {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    writerId: row.writer_id,
    writerName: row.writer_name,
    tags: safeJsonParse(row.tags, []),
    excerpt: row.excerpt || '',
    content: row.content || '',
    contentSnippet: row.content_snippet || '',
    source: row.source || 'manual',
    publishedAt: row.published_at || '',
    createdAt: row.created_at || '',
  };
}

function safeJsonParse(str: string, fallback: any): any {
  try { return JSON.parse(str); } catch { return fallback; }
}

export async function getArticles(db: D1Database, q: ArticleQuery = {}): Promise<Article[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  if (q.writerId) {
    conditions.push('writer_id = ?');
    values.push(q.writerId);
  }
  if (q.tag) {
    conditions.push('tags LIKE ?');
    values.push(`%"${q.tag}"%`);
  }
  if (q.source) {
    conditions.push('source = ?');
    values.push(q.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = q.sort === 'asc' ? 'ASC' : 'DESC';
  const limit = q.limit || 50;
  const offset = q.offset || 0;

  const { results } = await db.prepare(
    `SELECT * FROM articles ${where} ORDER BY created_at ${order} LIMIT ? OFFSET ?`
  ).bind(...values, limit, offset).all();

  return (results || []).map(rowToArticle);
}

export async function getArticleById(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
  return row ? rowToArticle(row) : null;
}

export async function getArticleByUrl(db: D1Database, url: string): Promise<Article | null> {
  const row = await db.prepare('SELECT * FROM articles WHERE url = ?').bind(url).first();
  return row ? rowToArticle(row) : null;
}

export async function getArticleFeed(db: D1Database, limit: number = 20): Promise<Article[]> {
  const { results } = await db.prepare(
    'SELECT * FROM articles ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  return (results || []).map(rowToArticle);
}

export async function getArticleTags(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(
    'SELECT DISTINCT tags FROM articles'
  ).all();

  const tagSet = new Set<string>();
  for (const row of results || []) {
    const tags = safeJsonParse(row.tags as string, []);
    for (const t of tags) tagSet.add(t);
  }
  return Array.from(tagSet).sort();
}

export async function createArticle(db: D1Database, article: Article): Promise<void> {
  const content = (article.content || '').substring(0, 900000); // ~900KB safe
  await db.prepare(`
    INSERT INTO articles (id, title, url, writer_id, writer_name, tags, excerpt, content, content_snippet, source, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    article.id, article.title, article.url, article.writerId, article.writerName,
    JSON.stringify(article.tags || []), article.excerpt || '',
    content, article.contentSnippet || '', article.source || 'manual',
    article.publishedAt || ''
  ).run();
}

export async function updateArticle(db: D1Database, id: string, updates: Partial<Article>): Promise<boolean> {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url); }
  if (updates.writerId !== undefined) { fields.push('writer_id = ?'); values.push(updates.writerId); }
  if (updates.writerName !== undefined) { fields.push('writer_name = ?'); values.push(updates.writerName); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.excerpt !== undefined) { fields.push('excerpt = ?'); values.push(updates.excerpt); }
  if (updates.content !== undefined) { fields.push('content = ?'); values.push((updates.content || '').substring(0, 900000)); }
  if (updates.contentSnippet !== undefined) { fields.push('content_snippet = ?'); values.push(updates.contentSnippet); }
  if (updates.source !== undefined) { fields.push('source = ?'); values.push(updates.source); }
  if (updates.publishedAt !== undefined) { fields.push('published_at = ?'); values.push(updates.publishedAt); }

  if (fields.length === 0) return false;
  values.push(id);
  const { meta } = await db.prepare(
    `UPDATE articles SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();
  return (meta?.changes || 0) > 0;
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
  return (meta?.changes || 0) > 0;
}

// ── Requests ────────────────────────────────────────────

export interface WriterRequest {
  id: string;
  writerName: string;
  website: string;
  reason: string;
  submittedAt: string;
}

export async function getRequests(db: D1Database): Promise<WriterRequest[]> {
  const { results } = await db.prepare(
    'SELECT * FROM requests ORDER BY submitted_at DESC'
  ).all();
  return (results || []).map(r => ({
    id: r.id as string,
    writerName: r.writer_name as string,
    website: r.website as string,
    reason: r.reason as string,
    submittedAt: r.submitted_at as string,
  }));
}

export async function createRequest(db: D1Database, req: WriterRequest): Promise<void> {
  await db.prepare(
    'INSERT INTO requests (id, writer_name, website, reason, submitted_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(req.id, req.writerName, req.website, req.reason, req.submittedAt).run();
}

export async function deleteRequest(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM requests WHERE id = ?').bind(id).run();
  return (meta?.changes || 0) > 0;
}

export function getNextRequestId(existing: WriterRequest[]): string {
  const ids = existing.map(r => parseInt(r.id.replace('req-', '')) || 0);
  return 'req-' + (ids.length > 0 ? Math.max(...ids) + 1 : 1);
}

// ── State ───────────────────────────────────────────────

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
  return row ? (row.value as string) : null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    'INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)'
  ).bind(key, value).run();
}

export async function getNextArticleId(db: D1Database): Promise<string> {
  let val = await getState(db, 'next_article_id');
  let num = parseInt(val || '1', 10);
  const id = `a-${num}`;
  await setState(db, 'next_article_id', String(num + 1));
  return id;
}

// ── Update History ──────────────────────────────────────

export async function addUpdateHistory(db: D1Database, writerId: string, entry: {
  title: string; url: string; date: string;
}): Promise<void> {
  await db.prepare(
    'INSERT INTO update_history (writer_id, title, url, published_at) VALUES (?, ?, ?, ?)'
  ).bind(writerId, entry.title, entry.url, entry.date).run();

  // Keep only last 50 entries per writer
  await db.prepare(`
    DELETE FROM update_history WHERE writer_id = ? AND id NOT IN (
      SELECT id FROM update_history WHERE writer_id = ? ORDER BY id DESC LIMIT 50
    )
  `).bind(writerId, writerId).run();
}

export async function getUpdateHistory(db: D1Database, writerId: string, limit: number = 10) {
  const { results } = await db.prepare(
    'SELECT * FROM update_history WHERE writer_id = ? ORDER BY checked_at DESC LIMIT ?'
  ).bind(writerId, limit).all();
  return results || [];
}

// ── Helpers ─────────────────────────────────────────────

function rowToWriter(row: any): Writer {
  return {
    id: row.id as string,
    name: row.name as string,
    identity: row.identity as string || '',
    website: row.website as string || '',
    twitter: row.twitter as string || '',
    era: row.era as string || '',
    masterpiece: row.masterpiece as string || '',
    description: row.description as string || '',
    type: row.type as string || 'modern',
    feed_url: row.feed_url as string || '',
  };
}
