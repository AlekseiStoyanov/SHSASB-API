const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ============================================================
// ENV VARS
// ============================================================
const API_KEY = process.env.API_KEY;
const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

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
// JWT MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "superadmin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ============================================================
// ENDPOINTS
// ============================================================

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// POST /auth/register — create a new user account
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ error: "Username must be 3–50 characters" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  // Prevent anyone from claiming the super admin username
  if (SUPER_ADMIN_USERNAME && username === SUPER_ADMIN_USERNAME) {
    return res.status(409).json({ error: "Username already taken" });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.execute(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, hash]
    );
    res.status(201).json({ status: "registered" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Username already taken" });
    }
    console.error("POST /auth/register error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /auth/login — returns a JWT on success
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  // Super admin is validated against env vars — not stored in DB
  if (SUPER_ADMIN_USERNAME && username === SUPER_ADMIN_USERNAME && password === SUPER_ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: "superadmin" }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token, role: "superadmin", username });
  }

  // Regular users from DB
  try {
    const [rows] = await pool.execute(
      "SELECT id, username, password_hash, role FROM users WHERE username = ?",
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token, role: user.role, username: user.username });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /messages?after=<id> — API key only (public read)
app.get("/messages", async (req, res) => {
  try {
    const after = parseInt(req.query.after, 10) || 0;
    const [rows] = await pool.execute(
      "SELECT id, content, username, created_at FROM messages WHERE id > ? ORDER BY id ASC",
      [after]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /messages — requires valid JWT (must be logged in)
app.post("/messages", requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO messages (content, username) VALUES (?, ?)",
      [content, req.user.username]
    );
    const [rows] = await pool.execute(
      "SELECT id, content, username, created_at FROM messages WHERE id = ?",
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

// DELETE /messages — requires JWT + superadmin role
app.delete("/messages", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.execute("DELETE FROM messages");
    console.log(`Super admin (${req.user.username}) wiped all messages`);
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

// Validate API key AND JWT on every socket connection
io.use((socket, next) => {
  const key = socket.handshake.auth.apiKey;
  if (!key || key !== API_KEY) {
    return next(new Error("Unauthorized"));
  }
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Unauthorized"));
  }
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return next(new Error("Unauthorized"));
  }
  next();
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id} (${socket.user.username})`);

  socket.on("send_message", async (payload) => {
    const { content } = payload;
    if (!content) return;
    try {
      const [result] = await pool.execute(
        "INSERT INTO messages (content, username) VALUES (?, ?)",
        [content, socket.user.username]
      );
      const [rows] = await pool.execute(
        "SELECT id, content, username, created_at FROM messages WHERE id = ?",
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
