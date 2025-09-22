# app.py
from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3, os, threading, secrets, json, unicodedata

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_ROOT, "data.sqlite3")

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True)

app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
if os.environ.get("RENDER"):
    app.config["SESSION_COOKIE_SECURE"] = True

_lock = threading.Lock()

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

# -------- helpers --------
def _read_json():
    data = request.get_json(silent=True)
    if data is None:
        try:
            raw = request.data.decode("utf-8", "ignore")
            data = json.loads(raw) if raw.strip().startswith("{") else {}
        except Exception:
            data = {}
    if not data and request.form:
        data = request.form.to_dict()
    return data or {}

def _clean(s: str) -> str:
    s = s or ""
    s = unicodedata.normalize("NFKC", s)
    for ch in ("\u200b","\u200c","\u200d","\ufeff","\u2060","\u00a0"):
        s = s.replace(ch, "")
    return s.strip()

def _current_user():
    uid = session.get("uid")
    if not uid:
        return None
    with _lock, _conn() as con:
        row = con.execute(
            "SELECT id,email,nickname,createdAt FROM users WHERE id=?", (uid,)
        ).fetchone()
        return dict(row) if row else None

# -------- auth --------
@app.post("/api/signup")
def api_signup():
    data = _read_json()
    email_raw = (data.get("email") or "")
    pw_raw    = (data.get("password") or "")
    nickname  = _clean(data.get("nickname") or "") or None

    email = _clean(email_raw).lower()
    password = pw_raw  # ここは“生”で保存（従来互換）
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
    session.permanent = True
    return jsonify({"ok": True, "user": {
        "id": uid, "email": email, "nickname": nickname, "createdAt": now_iso
    }}), 201

@app.post("/api/login")
def api_login():
    data = _read_json()
    email_raw = (data.get("email") or "")
    pw_raw    = (data.get("password") or "")

    email_clean = _clean(email_raw).lower()
    pw_clean    = _clean(pw_raw)

    # email は clean / raw の両方で試す（DBの表記ゆれに対応）
    with _lock, _conn() as con:
        row = con.execute(
            "SELECT id,email,password_hash,nickname,createdAt FROM users WHERE email=?",
            (email_clean,)
        ).fetchone()
        if not row and email_raw != email_clean:
            row = con.execute(
                "SELECT id,email,password_hash,nickname,createdAt FROM users WHERE email=?",
                (email_raw.lower(),)
            ).fetchone()

    ok = False
    if row:
        # パスワードは clean と raw の両方を試す（後方互換）
        if check_password_hash(row["password_hash"], pw_clean):
            ok = True
        elif pw_raw != pw_clean and check_password_hash(row["password_hash"], pw_raw):
            ok = True

    if not ok:
        return jsonify({"ok": False, "error": "invalid credentials"}), 401

    session["uid"] = row["id"]
    session.permanent = True
    return jsonify({"ok": True, "user": {
        "id": row["id"], "email": row["email"], "nickname": row["nickname"], "createdAt": row["createdAt"]
    }}), 200

@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True}), 200

@app.get("/api/me")
def api_me():
    user = _current_user()
    return jsonify({"ok": bool(user), "user": user}), 200

# -------- posts --------
@app.get("/api/posts")
def list_posts():
    with _lock, _conn() as con:
        cur = con.execute("SELECT * FROM posts ORDER BY datetime(createdAt) DESC")
        rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows), 200

@app.post("/api/posts")
def add_post():
    data = _read_json()
    text   = _clean(data.get("text")   or "")
    target = _clean(data.get("target") or "")
    tag    = _clean(data.get("tag")    or "")
    bg     = _clean(data.get("bg")     or "")
    scope  = _clean(data.get("scope")  or "public") or "public"

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

# -------- comments --------
@app.get("/api/comments")
def list_comments():
    post_id = (request.args.get("postId", "") or "").strip()
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
    data = _read_json()
    post_id = _clean(str(data.get("postId") or ""))
    text    = _clean(data.get("text") or "")

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

@app.get("/api/health")
def health():
    return jsonify({"ok": True}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port, debug=False)
