const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// Neon 接続設定
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 投稿を保存
app.post("/api/posts", async (req, res) => {
  try {
    const { text } = req.body;
    const result = await pool.query(
      "INSERT INTO posts (text) VALUES ($1) RETURNING *",
      [text]
    );
    res.json({ ok: true, post: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Database insert failed" });
  }
});

// 投稿を取得
app.get("/api/posts", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM posts ORDER BY id DESC");
    res.json({ ok: true, posts: result.rows });
  } catch (err) {
    console.error(err);

    const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// ルートパス (/) にアクセスした時に返すレスポンス
app.get("/", (req, res) => {
  res.send("Zange API is running 🚀");
});

// 他のエンドポイント例
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
    res.status(500).json({ ok: false, error: "Database fetch failed" });
  }
});

// Render でポートを拾う（環境変数PORTが指定される）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
