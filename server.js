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

const KNOWN_REACTION_TYPES = new Set(['pray', 'laugh', 'sympathy', 'growth']);

// reactions のサマリーを取得
async function getReactionSummary(zangeId) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE type='pray')::int     AS pray,
      COUNT(*) FILTER (WHERE type='laugh')::int    AS laugh,
      COUNT(*) FILTER (WHERE type='sympathy')::int AS sympathy,
      COUNT(*) FILTER (WHERE type='growth')::int   AS growth,
      COUNT(*) FILTER (WHERE type NOT IN ('pray','laugh','sympathy','growth'))::int AS other
    FROM reactions
    WHERE zange_id = $1
    `,
    [zangeId]
  );
  return rows[0] || { pray: 0, laugh: 0, sympathy: 0, growth: 0, other: 0 };
}

// users テーブルに email か nickname でユーザーを用意（なければ作る）
async function ensureUser({ email, nickname, avatar_url }) {
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

/* ===================== マイグレーション系 ===================== */
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

    // user_id + zange_id + type は 1回だけ（匿名は user_id=NULL のため対象外）
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
    const { rows } = await pool.query(`select version()`);
    res.json({ ok: true, version: rows[0].version });
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

/* ===================== 投稿API ===================== */

/**
 * POST /zanges
 * 本文・対象・タグ・公開範囲などを受け取り、DBへ保存。
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
        -- リアクション種別ごとの件数
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

/* ===================== リアクションAPI 🙏 ===================== */
/**
 * POST /reactions
 * 追加/削除/トグルでリアクションを付ける。
 * body:
 * {
 *   "zangeId": 123,                 // 必須
 *   "type": "pray" | "laugh" | ...  // 必須（任意文字列OKだが長すぎはNG）
 *   "action": "toggle" | "add" | "remove" (既定: "toggle")
 *   "userEmail": "...",             // 任意（あると重複防止が効く）
 *   "userNickname": "...",          // 任意
 *   "avatarUrl": "..."              // 任意
 * }
 *
 * 返り値:
 * {
 *   ok: true,
 *   summary: { pray, laugh, sympathy, growth, other },
 *   my: { reacted: boolean }
 * }
 */
app.post('/reactions', async (req, res) => {
  const { zangeId, type, action = 'toggle', userEmail, userNickname, avatarUrl } = req.body || {};
  try {
    // バリデーション
    const zid = parseInt(zangeId, 10);
    if (!zid || zid <= 0) return res.status(400).json({ ok: false, error: 'zangeId is required' });

    let rxType = (typeof type === 'string' ? type.trim() : '');
    if (!rxType) return res.status(400).json({ ok: false, error: 'type is required' });
    if (rxType.length > 20) return res.status(400).json({ ok: false, error: 'type too long' });

    // zange の存在チェック（なければ 404）
    const { rowCount: zExists } = await pool.query(`SELECT 1 FROM zanges WHERE id=$1`, [zid]);
    if (!zExists) return res.status(404).json({ ok: false, error: 'zange not found' });

    // ユーザーが特定できる場合は upsert / 削除で重複防止を効かせる
    let userId = null;
    if (userEmail || userNickname) {
      userId = await ensureUser({
        email: userEmail || null,
        nickname: userNickname || '匿名',
        avatar_url: avatarUrl || null
      });
    }

    if (action === 'remove') {
      if (!userId) {
        // 匿名は誰のリアクションか特定できないため remove は不可
        const summary = await getReactionSummary(zid);
        return res.status(400).json({ ok: false, error: 'remove requires identified user', summary, my: { reacted: false } });
      }
      await pool.query(`DELETE FROM reactions WHERE zange_id=$1 AND user_id=$2 AND type=$3`, [zid, userId, rxType]);
      const summary = await getReactionSummary(zid);
      return res.json({ ok: true, summary, my: { reacted: false } });
    }

    if (action === 'toggle' && userId) {
      // 既に押していれば消す、無ければ入れる
      const { rowCount: existed } = await pool.query(
        `DELETE FROM reactions WHERE zange_id=$1 AND user_id=$2 AND type=$3`,
        [zid, userId, rxType]
      );
      if (existed === 0) {
        await pool.query(
          `INSERT INTO reactions(zange_id, user_id, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [zid, userId, rxType]
        );
        const summary = await getReactionSummary(zid);
        return res.json({ ok: true, summary, my: { reacted: true } });
      } else {
        const summary = await getReactionSummary(zid);
        return res.json({ ok: true, summary, my: { reacted: false } });
      }
    }

    // action: 'add' or toggle(匿名)
    if (userId) {
      await pool.query(
        `INSERT INTO reactions(zange_id, user_id, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [zid, userId, rxType]
      );
      const summary = await getReactionSummary(zid);
      // 自分は必ず 1件ある前提（コンフリクト＝既にあったときも reacted:true として返す）
      const { rowCount: mine } = await pool.query(
        `SELECT 1 FROM reactions WHERE zange_id=$1 AND user_id=$2 AND type=$3`,
        [zid, userId, rxType]
      );
      return res.json({ ok: true, summary, my: { reacted: mine > 0 } });
    } else {
      // 匿名は記録のみ（重複防止なし）
      await pool.query(
        `INSERT INTO reactions(zange_id, user_id, type) VALUES($1,NULL,$2)`,
        [zid, rxType]
      );
      const summary = await getReactionSummary(zid);
      return res.json({ ok: true, summary, my: { reacted: true } });
    }
  } catch (e) {
    console.error('[POST /reactions] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /zanges/:id/reactions
 * 指定 zange のリアクション集計のみ返す。
 */
app.get('/zanges/:id/reactions', async (req, res) => {
  try {
    const zid = parseInt(req.params.id, 10);
    if (!zid) return res.status(400).json({ ok: false, error: 'invalid id' });

    const summary = await getReactionSummary(zid);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('[GET /zanges/:id/reactions] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===================== コメントAPI（追加） ===================== */
/**
 * POST /zanges/:id/comments
 * コメントを1件作成（匿名名 or ユーザー特定どちらでもOK）
 *
 * body 例:
 * {
 *   "text": "それ、あるあるです…！",
 *   "name": "匿名B",                 // 任意：画面に出す表示名（未指定ならユーザーのnickname or "匿名"）
 *   "email": "foo@example.com",      // 任意：ユーザー特定に使う（あれば ensureUser で upsert）
 *   "nickname": "太郎",              // 任意：email 無い時の暫定作成に使用
 *   "avatarUrl": "images/a.png"      // 任意
 * }
 */
app.post('/zanges/:id/comments', async (req, res) => {
  const zangeId = parseInt(req.params.id, 10);
  if (!Number.isInteger(zangeId) || zangeId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid zange id' });
  }

  try {
    const { text, name, email, nickname, avatarUrl } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }
    if (text.length > 500) {
      return res.status(400).json({ ok: false, error: 'text must be <= 500 chars' });
    }

    // 該当の zange が存在するか軽くチェック（無ければ 404）
    const z = await pool.query('SELECT id FROM zanges WHERE id=$1', [zangeId]);
    if (z.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'zange not found' });
    }

    // コメント主のユーザー（任意）
    let userId = null;
    if (email || nickname) {
      userId = await ensureUser({
        email: email || null,
        nickname: nickname || '匿名',
        avatar_url: avatarUrl || null
      });
    }

    const displayName =
      (typeof name === 'string' && name.trim()) ||
      (nickname && nickname.trim()) ||
      '匿名';

    const q = `
      INSERT INTO comments (zange_id, user_id, name, text)
      VALUES ($1, $2, $3, $4)
      RETURNING id, zange_id, user_id, name, text, created_at
    `;
    const { rows } = await pool.query(q, [
      zangeId,
      userId,
      displayName.trim(),
      text.trim()
    ]);
    res.status(201).json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error('[POST /zanges/:id/comments] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /zanges/:id/comments
 * コメント一覧を新着順で取得。シンプルなカーソル方式。
 * クエリ:
 *   ?limit=20             // 1〜100（デフォ20）
 *   ?beforeId=123         // これより小さいIDだけ返す（次ページを取るときに使う）
 *
 * レスポンス:
 * { ok:true, items:[...], nextCursor: { beforeId: <number> } | null }
 */
app.get('/zanges/:id/comments', async (req, res) => {
  const zangeId = parseInt(req.params.id, 10);
  if (!Number.isInteger(zangeId) || zangeId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid zange id' });
  }

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;

    const params = [zangeId];
    let where = 'WHERE c.zange_id=$1';
    if (Number.isInteger(beforeId) && beforeId > 0) {
      params.push(beforeId);
      where += ` AND c.id < $${params.length}`;
    }
    params.push(limit + 1); // 1件多めに取って nextCursor 判定
    const limitIdx = params.length;

    const q = `
      SELECT
        c.id, c.zange_id, c.user_id, c.name, c.text, c.created_at,
        u.nickname AS user_nickname,
        u.avatar_url AS user_avatar
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      ${where}
      ORDER BY c.id DESC
      LIMIT $${limitIdx}
    `;
    const { rows } = await pool.query(q, params);

    let nextCursor = null;
    if (rows.length > limit) {
      const nextBeforeId = rows[limit].id;
      rows.length = limit;
      nextCursor = { beforeId: nextBeforeId };
    }

    res.json({ ok: true, items: rows, nextCursor });
  } catch (e) {
    console.error('[GET /zanges/:id/comments] error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * DELETE /zanges/:id/comments/:commentId
 * コメントを削除。
 * ルール:
 *  - 管理者（SECRET_KEY 提供）なら無条件で削除可
 *  - それ以外は、email/nickname で本人を特定し、かつ本人のコメントのみ削除可
 *
 * クエリ/ヘッダー:
 *  - x-admin-key or ?key=...  （管理者用）
 *  - もしくは body/query に email/nickname を指定して本人確認
 */
app.delete('/zanges/:id/comments/:commentId', async (req, res) => {
  const zangeId = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (!Number.isInteger(zangeId) || !Number.isInteger(commentId)) {
    return res.status(400).json({ ok: false, error: 'invalid id' });
  }

  const adminKey = req.get('x-admin-key') || req.query.key;

  try {
    // 管理者は無条件で削除
    if (ADMIN_KEY && adminKey === ADMIN_KEY) {
      const r = await pool.query('DELETE FROM comments WHERE id=$1 AND zange_id=$2', [
        commentId,
        zangeId
      ]);
      return res.json({ ok: true, deleted: r.rowCount });
    }

    // 一般ユーザー：email/nickname で本人を特定
    const { email, nickname } = { ...req.body, ...req.query };
    if (!email && !nickname) {
      return res.status(401).json({ ok: false, error: 'unauthorized (need email or nickname or admin key)' });
    }

    const userId = await ensureUser({
      email: email || null,
      nickname: nickname || '匿名',
      avatar_url: null
    });

    const r = await pool.query(
      'DELETE FROM comments WHERE id=$1 AND zange_id=$2 AND user_id=$3',
      [commentId, zangeId, userId]
    );
    if (r.rowCount === 0) {
      return res.status(403).json({ ok: false, error: 'forbidden (not your comment or not found)' });
    }
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[DELETE /zanges/:id/comments/:commentId] error', e);
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
