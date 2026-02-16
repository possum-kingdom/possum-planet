#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = Number(
  process.env.PORT ||
  process.env.NODEJS_PORT ||
  process.env.APP_PORT ||
  4173
);

// IMPORTANT for cPanel/Passenger: bind to all interfaces
const HOST = process.env.IP || process.env.HOST || "0.0.0.0";

// App root is where this file lives
const APP_ROOT = __dirname;

// IMPORTANT: serve your website files from ./public
// Put fur-paint-canvas.html and all assets inside: public_html/garden/public/
const STATIC_ROOT = path.join(APP_ROOT, "public");

const SSE_KEEPALIVE_MS = 15000;
const MAX_MESSAGE_BYTES = 48 * 1024;

// Persist state in the app root (NOT in public)
const STATE_FILE = path.join(APP_ROOT, ".possumpaint-state.json");
const MAX_FUR_OPS = 50000;
const MAX_FLOWER_OPS = 12000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

// roomCode -> Map(clientId, response)
const rooms = new Map();
let nextClientId = 1;
let stateSaveTimer = null;

const worldState = loadWorldState();

function loadWorldState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { rooms: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.rooms !== "object") {
      return { rooms: {} };
    }
    return parsed;
  } catch {
    return { rooms: {} };
  }
}

function scheduleStateSave() {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(worldState), "utf8", (err) => {
      if (err) console.error("Failed to save world state:", err.message);
    });
  }, 200);
}

function getRoomState(room) {
  if (!worldState.rooms[room]) {
    worldState.rooms[room] = { furOps: [], flowerOps: [] };
  }
  return worldState.rooms[room];
}

function persistOperation(room, message) {
  const type = String(message?.type || "");
  const roomState = getRoomState(room);

  if (type === "clear_fur") {
    roomState.furOps = [];
    scheduleStateSave();
    return;
  }

  if (type === "paint") {
    roomState.furOps.push(message);
    if (roomState.furOps.length > MAX_FUR_OPS) {
      roomState.furOps.splice(0, roomState.furOps.length - MAX_FUR_OPS);
    }
    scheduleStateSave();
    return;
  }

  if (type === "clear_flowers") {
    roomState.flowerOps = [];
    scheduleStateSave();
    return;
  }

  if (
    type === "seed" ||
    type === "cheese_seed" ||
    type === "rose_pick" ||
    type === "rose_place_ball" ||
    type === "rose_place_flower"
  ) {
    roomState.flowerOps.push(message);
    if (roomState.flowerOps.length > MAX_FLOWER_OPS) {
      roomState.flowerOps.splice(0, roomState.flowerOps.length - MAX_FLOWER_OPS);
    }
    scheduleStateSave();
  }
}

function buildSnapshot(room) {
  const roomState = getRoomState(room);
  return {
    sender: "server",
    room,
    type: "snapshot",
    payload: { ops: [...roomState.furOps, ...roomState.flowerOps] }
  };
}

function sanitizeRoom(input) {
  const room = String(input || "main")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
  return room || "main";
}

function roomClients(room) {
  let clients = rooms.get(room);
  if (!clients) {
    clients = new Map();
    rooms.set(room, clients);
  }
  return clients;
}

function removeClient(room, clientId) {
  const clients = rooms.get(room);
  if (!clients) return;
  clients.delete(clientId);
  if (clients.size === 0) rooms.delete(room);
}

function broadcast(room, message) {
  const clients = rooms.get(room);
  if (!clients || clients.size === 0) return;
  const packet = `data: ${JSON.stringify(message)}\n\n`;
  for (const [clientId, res] of clients) {
    try {
      res.write(packet);
    } catch {
      removeClient(room, clientId);
    }
  }
}

function handleEvents(req, res, url) {
  const room = sanitizeRoom(url.searchParams.get("room"));
  const clientId = nextClientId++;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.write(": connected\n\n");
  roomClients(room).set(clientId, res);
  res.write(`data: ${JSON.stringify(buildSnapshot(room))}\n\n`);

  req.on("close", () => removeClient(room, clientId));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

async function handleSend(req, res, url) {
  const room = sanitizeRoom(url.searchParams.get("room"));
  try {
    const message = await readJsonBody(req, MAX_MESSAGE_BYTES);
    if (!message || typeof message !== "object") {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Invalid payload" }));
      return;
    }

    message.room = room;
    message.serverTs = Date.now();
    persistOperation(room, message);
    broadcast(room, message);

    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
  } catch (err) {
    res.writeHead(400, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify({ error: err.message || "Bad Request" }));
  }
}

// Safely map URL path -> file inside STATIC_ROOT
function safePathFromUrl(urlPathname) {
  const requested = decodeURIComponent(urlPathname || "/");

  // Default file when visiting "/"
  const relPath = requested === "/" ? "/fur-paint-canvas.html" : requested;

  const full = path.normalize(path.join(STATIC_ROOT, relPath));
  if (!full.startsWith(STATIC_ROOT)) return null;
  return full;
}

function serveStatic(req, res, url) {
  const fullPath = safePathFromUrl(url.pathname);
  if (!fullPath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(fullPath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(fullPath).pipe(res);
  });
}

function routePathname(pathname) {
  const normalized = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (normalized === "/healthz" || normalized.endsWith("/healthz")) return "/healthz";
  if (normalized === "/events" || normalized.endsWith("/events")) return "/events";
  if (normalized === "/send" || normalized.endsWith("/send")) return "/send";
  return normalized;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = routePathname(url.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && route === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && route === "/events") {
    handleEvents(req, res, url);
    return;
  }

  if (req.method === "POST" && route === "/send") {
    handleSend(req, res, url);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, url);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

const keepAliveTimer = setInterval(() => {
  for (const [room, clients] of rooms) {
    for (const [clientId, res] of clients) {
      try {
        res.write(": ping\n\n");
      } catch {
        removeClient(room, clientId);
      }
    }
  }
}, SSE_KEEPALIVE_MS);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the old app process, then start again.`);
    return;
  }
  console.error(err);
});

server.listen(PORT, HOST, () => {
  console.log(`PossumPaint multiplayer server running (behind cPanel proxy).`);
  console.log(`Host bind: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log(`Static root: ${STATIC_ROOT}`);
  console.log(`Default page: /fur-paint-canvas.html`);
});

function shutdown() {
  clearInterval(keepAliveTimer);
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(worldState), "utf8");
  } catch (err) {
    console.error("Failed to flush world state on shutdown:", err.message);
  }
  for (const [, clients] of rooms) {
    for (const [, res] of clients) {
      try {
        res.end();
      } catch {}
    }
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
