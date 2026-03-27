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
                    │                               └── MySQL Flexible Server
                    └── WebSocket        ──►         (same App Service, WebSockets enabled)
```

---

## Component Responsibilities

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| Frontend | HTML / CSS / JS | UI, user input, rendering live updates |
| Mobile wrapper | Capacitor | Packages frontend for Play Store + App Store |
| Backend | Node.js + Express + Socket.io | REST endpoints, real-time broadcast, all DB operations |
| Database | Azure MySQL Flexible Server | Persistent storage of messages and club data |

---

## Data Flow

**Page load** — Frontend → `GET /messages` → API → MySQL → returns history

**New message** — Frontend emits `send_message` → server inserts into MySQL → broadcasts `receive_message` to all connected clients

---

## Security

- All traffic over HTTPS / WSS (enforced by Azure)
- `X-API-Key` header required on all HTTP requests
- Socket.io connections validated via `handshake.auth.apiKey`
- `API_KEY` and all DB credentials stored as Azure App Service Application Settings (never in code)
- All SQL queries use parameterized statements — no string concatenation

---

## Azure Resources

| Resource | Tier |
|----------|------|
| Azure Static Web Apps | Free |
| Azure App Service (backend) | Basic B1 — WebSockets enabled, Always On |
| Azure MySQL Flexible Server | Provisioned via Web App + Database wizard |

---

## Deployment

- Code lives in GitHub
- Push to `main` → GitHub Actions auto-deploys backend to App Service (configured via Deployment Center)
- DB credentials and API key set in App Service → Configuration → Application Settings
