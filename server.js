// ---- server.js (clean + lazy PG connect) ----
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 10000;                 // Render は 10000 で動きます
const SECRET_KEY = process.env.SECRET_KEY || '';        // 管理操作用キー（RenderのEnvironmentに設定）
const DATABASE_URL = process.env.DATABASE_URL;          // Neon の接続文字列（必須）


// ====== ここがポイント：遅延でプール生成 ======
let pool = null;
/** 初回呼び出し時だけプール生成（起動時クラッシュを防ぐ） */
function getPool() {
  if (!pool) {
    if (!DATABASE_URL) {
      // 起動は通しつつ、アクセス時に分かるよう投げる
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon は SSL 必須
      keepAlive: true,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.error('[pg pool error]', err);
    });
  }
  return pool;
}

// ====== 公開エンドポイント ======
app.get('/', (_req, res) => {
  res.type('text/plain').send('Zange API is running 🚀');
});

app.get('/health', async (_req, res) => {
  // ヘルスは DB 依存にしない（DBダウンでも200で生存を返し、詳細はdbフィールドで伝える）
  const out = { status: 'ok', time: new Date().toISOString() };
  try {
    const p = getPool();
    await p.query('select 1');
    out.db = 'ok';
  } catch (e) {
    out.db = 'error';
    out.db_message = String(e.message || e);
  }
  res.json(out);
});

// ====== 管理用（SECRET_KEY で保護） ======
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (!SECRET_KEY || key !== SECRET_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

/** DB疎通テスト（安全に原因切り分け用） */
app.get('/admin/dbping', requireAdmin, async (_req, res) => {
  try {
    const p = getPool();
    const r = await p.query('select version()');
    res.json({ ok: true, version: r.rows?.[0]?.version || null });
  } catch (e) {
    console.error('[dbping] error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** === マイグレーション（MVP用） === */
app.post('/admin/migrate', requireAdmin, async (_req, res) => {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // users
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

    // zanges（投稿）
    await client.query(`
      CREATE TABLE IF NOT EXISTS zanges (
        id          BIGSERIAL PRIMARY KEY,
        owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
        text        TEXT NOT NULL,
        targets     TEXT[],                     -- ["上司","母"] など
        future_tag  TEXT,                       -- "#集中します"
        scope       TEXT NOT NULL DEFAULT 'public', -- 'public' or 'private'
        bg          TEXT,                       -- 背景画像ファイル名
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_zanges_created_at ON zanges(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_zanges_scope ON zanges(scope);
    `);

    // comments
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id          BIGSERIAL PRIMARY KEY,
        zange_id    BIGINT NOT NULL REFERENCES zanges(id) ON DELETE CASCADE,
        user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        name        TEXT,                       -- 匿名名保存用
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_comments_zange_id ON comments(zange_id);
    `);

    // reactions（組み込み & カスタム）
    await client.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id          BIGSERIAL PRIMARY KEY,
        zange_id    BIGINT NOT NULL REFERENCES zanges(id) ON DELETE CASCADE,
        user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
        type        TEXT NOT NULL,              -- 'pray','laugh','sympathy','growth' など
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_rx_zange_type ON reactions(zange_id, type);
    `);

    await client.query('COMMIT');
    res.json({ ok: true, applied: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[migrate] error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    client.release();
  }
});

/** ざっくり件数確認 */
app.get('/admin/dbcheck', requireAdmin, async (_req, res) => {
  try {
    const p = getPool();
    const { rows } = await p.query(`
      SELECT
        (SELECT count(*) FROM users)      ::int AS users,
        (SELECT count(*) FROM zanges)     ::int AS zanges,
        (SELECT count(*) FROM comments)   ::int AS comments,
        (SELECT count(*) FROM reactions)  ::int AS reactions
    `);
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** デモ用データ投入（任意） */
app.post('/admin/seed', requireAdmin, async (_req, res) => {
  const p = getPool();
  const c = await p.connect();
  try {
    await c.query('BEGIN');

    const u = await c.query(
      `INSERT INTO users(email, nickname, avatar_url)
       VALUES($1,$2,$3)
       ON CONFLICT (email) DO UPDATE
         SET nickname = EXCLUDED.nickname
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
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    c.release();
  }
});

// 404 明示（デバッグしやすく）
app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found (custom 404)');
});

app.listen(PORT, () => {
  console.log(`server started on :${PORT}`);
});
