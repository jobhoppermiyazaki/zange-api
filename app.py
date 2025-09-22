# app.py
from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3, os, threading, secrets, unicodedata as _ud

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_ROOT, "data.sqlite3")

app = Flask(__name__, static_folder='.', static_url_path='')

# ===== CORS / セッション設定 =====
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
if os.environ.get("RENDER"):  # Render/https 環境なら Secure をON
    app.config["SESSION_COOKIE_SECURE"] = True

_lock = threading.Lock()

# ===== DB接続 =====
def _conn():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON;")
    return con

def _init_db():
    with _lock, _conn() as con:
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
        )""")
        con.execute("""
        CREATE TABLE IF NOT EXISTS comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          postId INTEGER NOT NULL,
          user TEXT,
          text TEXT NOT NULL,
          createdAt TEXT,
          FOREIGN KEY(postId) REFERENCES posts(id)
        )""")
        con.execute("""
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          nickname TEXT,
          createdAt TEXT
        )""")
        # 簡易マイグレーション
        try:
            con.execute("SELECT createdAt FROM users LIMIT 1;")
        except sqlite3.OperationalError:
            con.execute("ALTER TABLE users ADD COLUMN createdAt TEXT;")
        con.commit()
_init_db()

# ===== 正規化ユーティリティ（① 揺れ吸収）=====
def _nfc(s: str) -> str:
    try:
        return _ud.normalize("NFC", s or "")
    except Exception:
        return (s or "")

def _strip_odd_spaces(s: str) -> str:
    # NBSP/全角空白/ゼロ幅空白などを通常空白へ or 除去
    return (s or "").replace("\u00A0", " ").replace("\u3000", " ").replace("\u200B", "")

def _norm_email(s: str) -> str:
    s = _nfc(_strip_odd_spaces(s))
    return s.strip().lower()

def _norm_pw(s: str) -> str:
    s = _nfc(_strip_odd_spaces(s))
    return s.strip()

# ===== レスポンスキャッシュ無効化 =====
@app.after_request
def no_store(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/")
def root():
    return send_from_directory(".", "index.html")

# ===== ユーザー関連 =====
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
    email_in = (data.get("email") or "")
    password_in = (data.get("password") or "")
    nickname = (data.get("nickname") or "").strip() or None

    # ② サインアップ時：正規化して保存
    email = _norm_email(email_in)
    password = _norm_pw(password_in)

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
    email_in = (data.get("email") or "")
    password_in = (data.get("password") or "")

    email_norm = _norm_email(email_in)
    pw_norm = _norm_pw(password_in)

    # ③ ログイン時：正規化後 と 生入力 の両方で検索＋検証
    with _lock, _conn() as con:
        row = con.execute(
            "SELECT id,email,password_hash,nickname,createdAt FROM users WHERE email=?",
            (email_norm,)
        ).fetchone()
        if not row and email_in.strip() != email_norm:
            row = con.execute(
                "SELECT id,email,password_hash,nickname,createdAt FROM users WHERE email=?",
                (email_in.strip(),)
            ).fetchone()

    ok = False
    if row:
        # 生→ダメなら正規化後で照合
        if check_password_hash(row["password_hash"], password_in):
            ok = True
        elif pw_norm != password_in and check_password_hash(row["password_hash"], pw_norm):
            ok = True

    if not row or not ok:
        return jsonify({"ok": False, "error": "invalid credentials"}), 401

    session.permanent = True
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

# ===== Posts =====
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

# ===== Comments =====
@app.get("/api/comments")
def list_comments():
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

# ===== ヘルスチェック / バージョン確認（⑤ 印）=====
@app.get("/api/health")
def health():
    return jsonify({"ok": True}), 200

@app.get("/api/ping")
def ping():
    # “新しいコードが動いている”ことを確認する印
    return jsonify({"ok": True, "version": "login-fallback-v3"}), 200

# ===== デバッグ系（⑥ 観測用&開発用ユーティリティ） =====
@app.get("/api/auth-debug")
def api_auth_debug():
    """
    開発確認用：メールの存在を確認するだけ。
    例: /api/auth-debug?email=a@example.com
    レスポンス: {"ok": true, "exists_raw": false, "exists_n": true, "sample":"auth-debug-v1"}
    """
    email_raw = (request.args.get("email") or "").strip()
    email_n   = _norm_email(email_raw)
    with _lock, _conn() as con:
        row_raw = con.execute("SELECT id FROM users WHERE email=?", (email_raw,)).fetchone()
        row_n   = con.execute("SELECT id FROM users WHERE email=?", (email_n,)).fetchone()
    return jsonify({
        "ok": True,
        "exists_raw": bool(row_raw),
        "exists_n": bool(row_n),
        "sample": "auth-debug-v1"
    }), 200

@app.post("/api/dev-reset-password")
def api_dev_reset_password():
    """
    開発専用：パスワードを強制更新（本番では使わない）。
    使い方:
      1) 環境変数 DEV_RESET_TOKEN を設定してデプロイ
      2) POST /api/dev-reset-password?email=...&new=...&token=＜DEV_RESET_TOKEN＞
         もしくは JSON で {email,new,token}
    """
    token_expect = os.environ.get("DEV_RESET_TOKEN")
    if not token_expect:
        return jsonify({"ok": False, "error": "disabled"}), 403

    token = (request.args.get("token") or (request.json.get("token") if request.is_json else "") or "").strip()
    if token != token_expect:
        return jsonify({"ok": False, "error": "forbidden"}), 403

    email_raw = (request.args.get("email") or (request.json.get("email") if request.is_json else "") or "").strip()
    new_pw    = (request.args.get("new")    or (request.json.get("new")    if request.is_json else "") or "").strip()
    if not email_raw or not new_pw:
        return jsonify({"ok": False, "error": "email and new required"}), 400

    email_n = _norm_email(email_raw)
    with _lock, _conn() as con:
        row = con.execute("SELECT id FROM users WHERE email=? OR email=?", (email_raw, email_n)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "user not found"}), 404
        con.execute("UPDATE users SET password_hash=? WHERE id=?",
                    (generate_password_hash(_norm_pw(new_pw)), row["id"]))
        con.commit()
    return jsonify({"ok": True}), 200

# ===== 低リスクな内部デバッグ（有効化時のみ）=====
@app.post("/api/_debug_login")
def _debug_login():
    if not os.environ.get("DEBUG_LOGIN"):
        return jsonify({"ok": False, "error": "disabled"}), 403
    d = request.get_json(silent=True) or {}
    email_in = (d.get("email") or "")
    password_in = (d.get("password") or "")
    email_norm = _norm_email(email_in)
    pw_norm = _norm_pw(password_in)
    with _lock, _conn() as con:
        row_n = con.execute("SELECT id,password_hash FROM users WHERE email=?", (email_norm,)).fetchone()
        row_r = con.execute("SELECT id,password_hash FROM users WHERE email=?", (email_in.strip(),)).fetchone()
    def chk(r, pw):
        try:
            return bool(r and check_password_hash(r["password_hash"], pw))
        except Exception:
            return False
    return jsonify({
        "ok": True,
        "email_in": email_in,
        "email_norm": email_norm,
        "found_norm": bool(row_n),
        "found_raw": bool(row_r),
        "pw_check_raw": chk(row_n or row_r, password_in),
        "pw_check_norm": chk(row_n or row_r, pw_norm),
    })

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port, debug=False)
