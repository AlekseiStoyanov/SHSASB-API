const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mysql = require("mysql2/promise");

// ============================================================
// ENV VARS
// ============================================================
const API_KEY = process.env.API_KEY;
const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;

// ============================================================
// MYSQL CONNECTION POOL
// ============================================================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: { rejectUnauthorized: true }   // required for Azure MySQL
});

// ============================================================
// EXPRESS + SOCKET.IO SETUP
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

// HTTP API key middleware
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ============================================================
// ENDPOINTS
// ============================================================

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// GET /messages?after=<id>
// Returns all messages with id > after. If after is omitted, returns all.
app.get("/messages", async (req, res) => {
  try {
    const after = parseInt(req.query.after, 10) || 0;
    const [rows] = await pool.execute(
      "SELECT id, content, created_at FROM messages WHERE id > ? ORDER BY id ASC",
      [after]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /messages — insert a message and broadcast it
app.post("/messages", async (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO messages (content) VALUES (?)",
      [content]
    );
    const [rows] = await pool.execute(
      "SELECT id, content, created_at FROM messages WHERE id = ?",
      [result.insertId]
    );
    const message = rows[0];
    console.log(`Message received: ${content}`);
    io.emit("receive_message", message);
    res.status(201).json(message);
  } catch (err) {
    console.error("POST /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE /messages — super admin wipe (all messages)
// Requires X-Admin-Username and X-Admin-Password headers
app.delete("/messages", async (req, res) => {
  const username = req.headers["x-admin-username"];
  const password = req.headers["x-admin-password"];

  if (
    !SUPER_ADMIN_USERNAME || !SUPER_ADMIN_PASSWORD ||
    username !== SUPER_ADMIN_USERNAME ||
    password !== SUPER_ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await pool.execute("DELETE FROM messages");
    console.log("Super admin wiped all messages");
    io.emit("messages_wiped");    // tell all connected clients
    res.json({ status: "all messages deleted" });
  } catch (err) {
    console.error("DELETE /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ============================================================
// SOCKET.IO
// ============================================================

// Validate API key on connection
io.use((socket, next) => {
  const key = socket.handshake.auth.apiKey;
  if (!key || key !== API_KEY) {
    return next(new Error("Unauthorized"));
  }
  next();
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("send_message", async (payload) => {
    const { content } = payload;
    if (!content) return;
    try {
      const [result] = await pool.execute(
        "INSERT INTO messages (content) VALUES (?)",
        [content]
      );
      const [rows] = await pool.execute(
        "SELECT id, content, created_at FROM messages WHERE id = ?",
        [result.insertId]
      );
      const message = rows[0];
      console.log(`Message received: ${content}`);
      io.emit("receive_message", message);
    } catch (err) {
      console.error("send_message error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Verify DB connection on startup
    const conn = await pool.getConnection();
    console.log("Connected to Azure MySQL");
    conn.release();
  } catch (err) {
    console.error("DB connection failed:", err);
  }

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start();
