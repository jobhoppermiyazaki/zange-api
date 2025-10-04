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
