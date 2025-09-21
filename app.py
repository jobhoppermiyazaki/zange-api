# app.py
from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3, os, threading, secrets

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_ROOT, "data.sqlite3")

app = Flask(__name__, static_folder='.', static_url_path='')

# 将来クッキーを跨いで使う場合に備えて credentials を許可
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)

# ===== セッション鍵（本番は環境変数で） =====
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
# Render/https なら Secure をON
if os.environ.get("RENDER"):
    app.config["SESSION_COOKIE_SECURE"] = True

_lock = threading.Lock()

def _conn():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    # 外部キー有効化
    con.execute("PRAGMA foreign_keys = ON;")
    return con

def _init_db():
    with _lock, _conn() as con:
        # 投稿
        con.execute("""
        CREATE TABLE IF NOT EXISTS posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          author TEXT,
          target TEXT,
          tag TEXT,
          bg TEXT,
          scope TEXT,
          createdAt TEXT
        )
        """)
        # コメント
        con.execute("""
        CREATE TABLE IF NOT EXISTS comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          postId INTEGER NOT NULL,
          user TEXT,
          text TEXT NOT NULL,
          createdAt TEXT,
          FOREIGN KEY(postId) REFERENCES posts(id)
        )
        """)
        # ユーザー
        con.execute("""
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          nickname TEXT,
          createdAt TEXT
        )
        """)

        # 既存DBに users.createdAt が無い場合に追加（簡易マイグレーション）
        try:
            con.execute("SELECT createdAt FROM users LIMIT 1;")
        except sqlite3.OperationalError:
            con.execute("ALTER TABLE users ADD COLUMN createdAt TEXT;")

        con.commit()

_init_db()

@app.after_request
def no_store(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/")
def root():
    return send_from_directory(".", "index.html")

# ========== ユーザー/認証 ==========
def _current_user():
    uid = session.get("uid")
    if not uid:
        return None
    with _lock, _conn() as con:
        row = con.execute(
            "SELECT id,email,nickname,createdAt FROM users WHERE id=?", (uid,)
        ).fetchone()
        return dict(row) if row else None

@app.post("/api/signup")
def api_signup():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()
    nickname = (data.get("nickname") or "").strip() or None

    if not email or not password:
        return jsonify({"ok": False, "error": "email and password required"}), 400
    if len(password) < 8:
        return jsonify({"ok": False, "error": "password too short"}), 400

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        with _lock, _conn() as con:
            cur = con.execute(
                "INSERT INTO users(email, password_hash, nickname, createdAt) VALUES (?,?,?,?)",
                (email, generate_password_hash(password), nickname, now_iso)
            )
            uid = cur.lastrowid
            con.commit()
    except sqlite3.IntegrityError:
        return jsonify({"ok": False, "error": "already exists"}), 409

    session["uid"] = uid
    user = {"id": uid, "email": email, "nickname": nickname, "createdAt": now_iso}
    return jsonify({"ok": True, "user": user}), 201

@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()

    with _lock, _conn() as con:
        row = con.execute(
            "SELECT id,email,password_hash,nickname,createdAt FROM users WHERE email=?",
            (email,)
        ).fetchone()

    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"ok": False, "error": "invalid credentials"}), 401

    session["uid"] = row["id"]
    user = {"id": row["id"], "email": row["email"], "nickname": row["nickname"], "createdAt": row["createdAt"]}
    return jsonify({"ok": True, "user": user}), 200

@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True}), 200

@app.get("/api/me")
def api_me():
    user = _current_user()
    return jsonify({"ok": bool(user), "user": user}), 200

# ========== Posts ==========
@app.get("/api/posts")
def list_posts():
    with _lock, _conn() as con:
        cur = con.execute("SELECT * FROM posts ORDER BY datetime(createdAt) DESC")
        rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows), 200

@app.post("/api/posts")
def add_post():
    data = request.get_json(silent=True) or {}
    text   = (data.get("text")   or "").strip()
    target = (data.get("target") or "").strip()
    tag    = (data.get("tag")    or "").strip()
    bg     = (data.get("bg")     or "").strip()
    scope  = (data.get("scope")  or "public").strip()

    if not text:
        return jsonify({"error": "text is required"}), 400

    # ★ クライアントからの author は無視し、サーバーで決定
    cu = _current_user()
    author = (cu.get("nickname") if cu else None) or (cu.get("email") if cu else None) or "匿名"

    now_iso = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as con:
        cur = con.execute(
            "INSERT INTO posts (text,author,target,tag,bg,scope,createdAt) VALUES (?,?,?,?,?,?,?)",
            (text, author, target, tag, bg, scope, now_iso)
        )
        new_id = cur.lastrowid
        con.commit()
        row = dict(con.execute("SELECT * FROM posts WHERE id=?", (new_id,)).fetchone())
    return jsonify(row), 201

# ========== Comments ==========
@app.get("/api/comments")
def list_comments():
    """?postId= を付けて呼ぶ想定。未指定なら新しい順で全件（テスト用）"""
    post_id = request.args.get("postId", "").strip()
    with _lock, _conn() as con:
        if post_id:
            cur = con.execute(
                "SELECT * FROM comments WHERE postId=? ORDER BY datetime(createdAt) ASC",
                (post_id,)
            )
        else:
            cur = con.execute("SELECT * FROM comments ORDER BY datetime(createdAt) DESC")
        rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows), 200

@app.post("/api/comments")
def add_comment():
    data = request.get_json(silent=True) or {}
    post_id = str(data.get("postId") or "").strip()
    text    = (data.get("text") or "").strip()

    if not post_id.isdigit():
        return jsonify({"error": "postId is required"}), 400
    if not text:
        return jsonify({"error": "text is required"}), 400

    # ★ ログイン済みならニックネーム/メールを優先、未ログインなら「匿名」
    cu = _current_user()
    user = (cu.get("nickname") if cu else None) or (cu.get("email") if cu else None) or "匿名"

    now_iso = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as con:
        chk = con.execute("SELECT 1 FROM posts WHERE id=?", (post_id,)).fetchone()
        if not chk:
            return jsonify({"error": "post not found"}), 404
        cur = con.execute(
            "INSERT INTO comments (postId,user,text,createdAt) VALUES (?,?,?,?)",
            (int(post_id), user, text, now_iso)
        )
        new_id = cur.lastrowid
        con.commit()
        row = dict(con.execute("SELECT * FROM comments WHERE id=?", (new_id,)).fetchone())
    return jsonify(row), 201

# ヘルスチェック（任意）
@app.get("/api/health")
def health():
    return jsonify({"ok": True}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port, debug=False)
