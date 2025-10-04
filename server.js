const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ログでヒット確認できるように
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ルート
app.get("/", (req, res) => {
  res.type("text/plain").send("Zange API is running 🚀");
});

// ヘルスチェック
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// 404 のときの見え方を明確化（デバッグ用）
app.use((req, res) => {
  res.status(404).type("text/plain").send("Not found (custom 404)");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ---- server.js ----
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.SECRET_KEY || ''; // 管理操作用
const DATABASE_URL = process.env.DATABASE_URL;

// pg Pool（Render/Neon向けの安定オプション）
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// ヘルスチェック
app.get('/', (_req, res) => res.send('Zange API is running 🚀'));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'db_error', message: e.message });
  }
});

// --- 管理保護ミドルウェア ---
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// === ここが「マイグレーション」本体 ===
app.post('/admin/migrate', requireAdmin, async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT UNIQUE,
        nickname    TEXT NOT NULL DEFAULT '匿名',
        avatar_url  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    // 2) zanges（投稿）
    await client.query(`
      CREATE TABLE IF NOT EXISTS zanges (
        id          BIGSERIAL PRIMARY KEY,
        owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
        text        TEXT NOT NULL,
        targets     TEXT[],                    -- ["上司","母"] など
        future_tag  TEXT,                      -- "#集中します"
        scope       TEXT NOT NULL DEFAULT 'public', -- 'public' or 'private'
        bg          TEXT,                      -- 背景画像ファイル名
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_zanges_created_at ON zanges(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_zanges_scope ON zanges(scope);
    `);

    // 3) comments
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id          BIGSERIAL PRIMARY KEY,
        zange_id    BIGINT NOT NULL REFERENCES zanges(id) ON DELETE CASCADE,
        user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        name        TEXT,                      -- 匿名名保存用
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_comments_zange_id ON comments(zange_id);
    `);

    // 4) reactions（組み込み & カスタムを1テーブルに）
    await client.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id          BIGSERIAL PRIMARY KEY,
        zange_id    BIGINT NOT NULL REFERENCES zanges(id) ON DELETE CASCADE,
        user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        type        TEXT NOT NULL,             -- 'pray' 'laugh' 'sympathy' 'growth' など
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_rx_zange_type ON reactions(zange_id, type);
    `);

    await client.query('COMMIT');
    res.json({ ok: true, message: 'migrated' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[migrate] error', e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// DBの簡易確認
app.get('/admin/dbcheck', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users)      ::int as users,
      (SELECT count(*) FROM zanges)     ::int as zanges,
      (SELECT count(*) FROM comments)   ::int as comments,
      (SELECT count(*) FROM reactions)  ::int as reactions
  `);
  res.json(rows[0]);
});

// --- サンプル: 1件だけ投稿を作る管理用seed（お試し） ---
app.post('/admin/seed', requireAdmin, async (_req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query(
      `INSERT INTO users(email, nickname, avatar_url)
       VALUES($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET nickname=EXCLUDED.nickname
       RETURNING id`,
      ['demo@zange.local', 'zange開発者', 'images/default-avatar.png']
    );
    const ownerId = u.rows[0].id;
    const z = await c.query(
      `INSERT INTO zanges(owner_id, text, targets, future_tag, scope, bg)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        ownerId,
        'Neonに保存される最初の投稿です 🙏',
        ['上司'],
        '#集中します',
        'public',
        null
      ]
    );
    await c.query('COMMIT');
    res.json({ ok: true, user_id: ownerId, zange_id: z.rows[0].id });
  } catch (e) {
    await c.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    c.release();
  }
});

app.listen(PORT, () => {
  console.log(`server started on :${PORT}`);
});
