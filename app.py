# app.py（抜粋＆追記）
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from datetime import datetime, timezone
import sqlite3, os, threading

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_ROOT, "data.sqlite3")

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app, resources={r"/api/*": {"origins": "*"}})

_lock = threading.Lock()

def _conn():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con

def _init_db():
    with _lock, _conn() as con:
        # 投稿テーブル（既存）
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
        # ★ コメントテーブル（新規）
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

# ---- Posts API（既存） ----
@app.get("/api/posts")
def list_posts():
    with _lock, _conn() as con:
        cur = con.execute("SELECT * FROM posts ORDER BY datetime(createdAt) DESC")
        rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows), 200

@app.post("/api/posts")
def add_post():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    author = (data.get("author") or "").strip()
    target = (data.get("target") or "").strip()
    tag = (data.get("tag") or "").strip()
    bg = (data.get("bg") or "").strip()
    scope = (data.get("scope") or "public").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    now_iso = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as con:
        cur = con.execute(
            "INSERT INTO posts (text,author,target,tag,bg,scope,createdAt) VALUES (?,?,?,?,?,?,?)",
            (text, author, target, tag, bg, scope, now_iso)
        )
        new_id = cur.lastrowid
        con.commit()
        cur = con.execute("SELECT * FROM posts WHERE id=?", (new_id,))
        row = dict(cur.fetchone())
    return jsonify(row), 201

# ---- ★ Comments API（新規） ----
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
    text = (data.get("text") or "").strip()
    user = (data.get("user") or "匿名").strip()
    if not post_id.isdigit():
        return jsonify({"error": "postId is required"}), 400
    if not text:
        return jsonify({"error": "text is required"}), 400
    now_iso = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as con:
        # 対象投稿の存在チェック（簡易）
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

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port, debug=False)
