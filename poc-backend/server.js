const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mysql = require("mysql2/promise");

// Read API key from environment variable — set this in Azure App Service > Configuration > Application Settings
const API_KEY = process.env.API_KEY || "your-api-key-here";

// MySQL connection pool — all credentials come from environment variables
const pool = mysql.createPool({
  host: process.env.DB_HOST,       // e.g. shsasb-api-server.mysql.database.azure.com
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "shsasb-api-database",
  ssl: { rejectUnauthorized: false }, // Azure MySQL requires SSL; use proper CA cert in production
  waitForConnections: true,
  connectionLimit: 10
});

async function initDB() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL
    )
  `);
  console.log("Database ready");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Middleware
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

// GET /messages — return full message history from DB
app.get("/messages", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT id, content, created_at FROM messages ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /messages — listed for completeness, same logic as socket handler
app.post("/messages", async (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const created_at = new Date().toISOString();
    const [result] = await pool.execute(
      "INSERT INTO messages (content, created_at) VALUES (?, ?)",
      [content, created_at]
    );
    const message = { id: result.insertId, content, created_at };
    console.log(`Message received: ${content}`);
    io.emit("receive_message", message);
    res.status(201).json(message);
  } catch (err) {
    console.error("POST /messages error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Socket.io — validate API key on connection
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
    try {
      const created_at = new Date().toISOString();
      const [result] = await pool.execute(
        "INSERT INTO messages (content, created_at) VALUES (?, ?)",
        [content, created_at]
      );
      const message = { id: result.insertId, content, created_at };
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

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
