# Architecture — Club App Prototype

## Overview

A real-time web application embedded in a mobile app (Android + iOS via Capacitor). Users view club information live. Admins log in to edit club pages. All components hosted on Azure in the same resource group and region.

---

## Components

```
Mobile App (Capacitor)
    └── WebView
            └── Frontend (Azure Static Web Apps)
                    │
                    ├── HTTP (REST)      ──► Backend API (Azure App Service — Node.js 22)
                    │                               └── Azure MySQL Flexible Server
                    └── WebSocket        ──►         (same App Service, WebSockets enabled)
```

---

## Component Responsibilities

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| Frontend | HTML / CSS / JS | UI, user input, rendering live updates, super admin panel |
| Mobile wrapper | Capacitor | Packages frontend for Play Store + App Store |
| Backend | Node.js + Express + Socket.io | REST endpoints, real-time broadcast, all DB operations, super admin wipe |
| Database | Azure MySQL Flexible Server | Persistent storage of messages |

---

## Data Flow

### Page load / reconnect (delta sync)

Frontend → `GET /messages?after=<lastMessageId>` → API → MySQL `SELECT WHERE id > ?` → returns only new messages

The client tracks the highest `id` it has seen (`lastMessageId`). On first load this is `0` (fetch everything). On reconnect it sends the last known ID so only missing messages are returned. This prevents re-downloading the entire history every time.

### New message

Frontend emits `send_message` → server `INSERT INTO messages` → reads back the inserted row (with auto-increment `id` + server timestamp) → broadcasts `receive_message` to all connected clients

### Super admin wipe

Frontend sends `DELETE /messages` with `X-Admin-Username` + `X-Admin-Password` headers → server validates against env vars → `DELETE FROM messages` → broadcasts `messages_wiped` event → all connected clients clear their message list and reset `lastMessageId` to `0`

---

## Security

- All traffic over HTTPS / WSS (enforced by Azure)
- `X-API-Key` header required on all HTTP requests
- Socket.io connections validated via `handshake.auth.apiKey`
- `API_KEY`, DB credentials, and super admin credentials stored as Azure App Service Application Settings (never in code)
- All SQL queries use parameterized statements (`pool.execute` with `?` placeholders) — no string concatenation
- Super admin wipe requires `X-Admin-Username` + `X-Admin-Password` headers matching env vars `SUPER_ADMIN_USERNAME` + `SUPER_ADMIN_PASSWORD`
- SSL/TLS enforced on the MySQL connection (`ssl: { rejectUnauthorized: true }`)

---

## Environment Variables

All set in Azure App Service → Configuration → Application Settings.

| Variable | Purpose |
|----------|---------|
| `API_KEY` | Shared secret for all HTTP + WebSocket requests |
| `DB_HOST` | MySQL server hostname (e.g. `shsasb.mysql.database.azure.com`) |
| `DB_USER` | MySQL username |
| `DB_PASSWORD` | MySQL password |
| `DB_NAME` | Database name (e.g. `shsasb`) |
| `SUPER_ADMIN_USERNAME` | Username for the super admin wipe endpoint |
| `SUPER_ADMIN_PASSWORD` | Password for the super admin wipe endpoint |

---

## Database Schema

```sql
CREATE TABLE messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  content     VARCHAR(1000) NOT NULL,
  created_at  DATETIME DEFAULT UTC_TIMESTAMP()
);
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | API key | Health check |
| GET | `/messages?after=<id>` | API key | Delta fetch — returns messages with `id > after` (default `0` = all) |
| POST | `/messages` | API key | Insert a message, broadcast to all clients |
| DELETE | `/messages` | API key + admin headers | Super admin wipe — deletes all messages |

## WebSocket Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `send_message` | Client → Server | `{ content }` | Client sends a new message |
| `receive_message` | Server → Client | `{ id, content, created_at }` | Broadcast after insert |
| `messages_wiped` | Server → Client | *(none)* | Broadcast after super admin wipe |

---

## Azure Resources

| Resource | Tier |
|----------|------|
| Azure Static Web Apps | Free |
| Azure App Service (backend) | Basic B1 — WebSockets enabled, Always On |
| Azure MySQL Flexible Server | Burstable B1s (or provisioned via Web App + Database wizard) |

---

## Deployment

- Code lives in GitHub
- Push to `main` → GitHub Actions auto-deploys backend to App Service (configured via Deployment Center)
- DB credentials, API key, and super admin credentials set in App Service → Configuration → Application Settings
