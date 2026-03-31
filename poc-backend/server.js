const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const API_KEY = process.env.API_KEY || "your-api-key-here";

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

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// POST /messages — receive a message and broadcast it to all clients
app.post("/messages", (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }
  const message = { id: Date.now(), content, created_at: new Date().toISOString() };
  console.log(`Message received: ${content}`);
  io.emit("receive_message", message);
  res.status(201).json(message);
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

  socket.on("send_message", (payload) => {
    const { content } = payload;
    const message = { id: Date.now(), content, created_at: new Date().toISOString() };
    console.log(`Message received: ${content}`);
    io.emit("receive_message", message);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
