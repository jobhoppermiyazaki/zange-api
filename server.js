// ---- server.js ----
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.SECRET_KEY || '';           // 管理操作用（migrate/dbcheck/seed）
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

// ---- ユーティリティ ----
const toArray = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') {
    // カンマ／スペース／読点で区切る
    return v
      .split(/[,\s、]+/u)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
};

// users テーブルに email か nickname でユーザーを用意（なければ作る）
async function ensureUser({ email, nickname, avatar_url }) {
  // email があれば email 基準で upsert。なければ nickname で暫定作成（email NULL）
  if (email) {
    const q = `
      INSERT INTO users(email, nickname, avatar_url)
      VALUES($1, $2, $3)
      ON CONFLICT (email)
        DO UPDATE SET nickname = COALESCE(EXCLUDED.nickname, users.nickname),
                      avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
      RETURNING id
    `;
    const { rows } = await pool.query(q, [email, nickname || '匿名', avatar_url || null]);
    return rows[0].id;
  } else {
    const q = `
      INSERT INTO users(email, nickname, avatar_url)
      VALUES(NULL, $1, $2)
      RETURNING id
    `;
    const { rows } = await pool.query(q, [nickname || '匿名', avatar_url || null]);
    return rows[0].id;
  }
}

// ---- ルート & ヘルス ----
app.get('/', (_req, res) => res.send('Zange API is running 🚀'));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ status: 'ok', time: new Date().toISOString(), db: 'ok' });
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

/* ===================== マイグレーション系（既存） ===================== */
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
        targets     TEXT[],                         -- ["上司","母"] 等
        future_tag  TEXT,                           -- "#集中します"
        scope       TEXT NOT NULL DEFAULT 'public', -- 'public' or 'private'
        bg          TEXT,                           -- 背景画像ファイル名
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

    // 4) reactions（組み込み & カスタム）
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

    // user_id + zange_id + type の重複防止（1ユーザーが1種類につき1回だけ押せる）
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rx_user_once
        ON reactions (zange_id, user_id, type)
        WHERE user_id IS NOT NULL;
    `);
    
    await client.query('COMMIT');
    res.json({ ok: true, applied: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[migrate] error', e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get('/admin/dbping', requireAdmin, async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, ping: 'ok' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/dbcheck', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users)      ::int as users,
      (SELECT count(*) FROM zanges)     ::int as zanges,
      (SELECT count(*) FROM comments)   ::int as comments,
      (SELECT count(*) FROM reactions)  ::int as reactions
  `);
  res.json({ ok: true, ...rows[0] });
});

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

/* ===================== ★ ここからアプリAPI（追加） ===================== */

/**
 * POST /zanges
 * 本文・対象・タグ・公開範囲などを受け取り、DBへ保存。
 * 認証は未実装のため、email or nickname で暫定オーナーを確保する。
 *
 * body 例:
 * {
 *   "text": "会議中にSlackばっか見てました📱",
 *   "targets": ["上司","同僚"],              // 文字列でもOK
 *   "futureTag": "#集中します",
 *   "scope": "public",                       // "public"|"private"
 *   "bg": "bg01.jpg",
 *   "ownerEmail": "foo@example.com",         // 任意
 *   "ownerNickname": "匿名A",                // 任意
 *   "avatarUrl": "images/default-avatar.png" // 任意
 * }
 */
app.post('/zanges', async (req, res) => {
  try {
    const {
      text,
      targets,
      futureTag,
      scope,
      bg,
      ownerEmail,
      ownerNickname,
      avatarUrl
    } = req.body || {};

    // バリデーション（MVPは最小限）
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }
    if (text.length > 325) {
      return res.status(400).json({ ok: false, error: 'text must be <= 325 chars' });
    }
    const targetsArr = toArray(targets);
    const scopeVal = (scope === 'private') ? 'private' : 'public';
    const futureTagVal = typeof futureTag === 'string' ? futureTag.trim() : null;
    const bgVal = typeof bg === 'string' && bg.trim() ? bg.trim() : null;

    // 暫定ユーザー確保（email優先、無ければnickname）
    const owner_id = await ensureUser({
      email: ownerEmail || null,
      nickname: ownerNickname || '匿名',
      avatar_url: avatarUrl || null
    });

    const q = `
      INSERT INTO zanges(owner_id, text, targets, future_tag, scope, bg)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING id, created_at
    `;
    const { rows } = await pool.query(q, [
      owner_id,
      text.trim(),
      targetsArr.length ? targetsArr : null,
      futureTagVal,
      scopeVal,
      bgVal
    ]);

    res.status(201).json({
      ok: true,
      id: rows[0].id,
      created_at: rows[0].created_at,
      owner_id
    });
  } catch (e) {
    console.error('[POST /zanges] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /feed
 * 公開投稿の新着を返す。コメント数・リアクション数もまとめて返す。
 * クエリ: ?limit=20
 */
app.get('/feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const q = `
      SELECT
        z.id,
        z.text,
        z.targets,
        z.future_tag,
        z.scope,
        z.bg,
        z.created_at,
        u.id          AS owner_id,
        u.nickname    AS owner_nickname,
        u.avatar_url  AS owner_avatar,
        -- コメント数
        COALESCE(c.cnt, 0) AS comments_count,
        -- リアクション種別ごとの件数（簡易にSUM）
        COALESCE(r.pray, 0)      AS rx_pray,
        COALESCE(r.laugh, 0)     AS rx_laugh,
        COALESCE(r.sympathy, 0)  AS rx_sympathy,
        COALESCE(r.growth, 0)    AS rx_growth
      FROM zanges z
      LEFT JOIN users u ON u.id = z.owner_id
      LEFT JOIN (
        SELECT zange_id, COUNT(*)::int AS cnt
        FROM comments
        GROUP BY zange_id
      ) c ON c.zange_id = z.id
      LEFT JOIN (
        SELECT
          zange_id,
          COUNT(*) FILTER (WHERE type='pray')::int     AS pray,
          COUNT(*) FILTER (WHERE type='laugh')::int    AS laugh,
          COUNT(*) FILTER (WHERE type='sympathy')::int AS sympathy,
          COUNT(*) FILTER (WHERE type='growth')::int   AS growth
        FROM reactions
        GROUP BY zange_id
      ) r ON r.zange_id = z.id
      WHERE z.scope = 'public'
      ORDER BY z.created_at DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(q, [limit]);

    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('[GET /feed] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===================== 最後に404 & 起動 ===================== */
app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found (custom 404)');
});

app.listen(PORT, () => {
  console.log(`server started on :${PORT}`);
});
