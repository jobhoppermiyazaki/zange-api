from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from datetime import datetime, timezone
import sqlite3, os, threading

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_ROOT, "data.sqlite3")

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ---- SQLite helpers ----
_lock = threading.Lock()

def _conn():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
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
        )
        """)
        con.commit()

_init_db()

@app.after_request
def no_store(resp):
    # キャッシュ無効化
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

# ---- 静的トップ ----
@app.get("/")
def root():
    return send_from_directory(".", "index.html")

# ---- API ----
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


# ---- Main ----
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)