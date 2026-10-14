// Relay-Server fuer das Haus-Spiel: Raeume mit 5-stelligem Code, bis zu 5 Spieler pro Raum.
// Leitet Nachrichten eines Spielers an alle anderen im Raum weiter. Start: npm install && npm start
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_SPIELER = 5;
const ZEICHEN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Haus-Spiel Relay laeuft. Raeume: " + raeume.size);
});
const wss = new WebSocketServer({ server });
const raeume = new Map(); // code -> Map(id -> ws)
let naechsteId = 1;

function neuerCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += ZEICHEN[Math.floor(Math.random() * ZEICHEN.length)];
    if (!raeume.has(c)) return c;
  }
}

function senden(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function verlassen(ws) {
  if (!ws.raum) return;
  const raum = raeume.get(ws.raum);
  if (raum) {
    raum.delete(ws.id);
    for (const [, andere] of raum) senden(andere, { t: "peer_leave", id: ws.id });
    if (raum.size === 0) raeume.delete(ws.raum);
  }
  ws.raum = null;
}

wss.on("connection", (ws) => {
  ws.id = naechsteId++;
  ws.raum = null;
  ws.lebt = true;
  ws.on("pong", () => (ws.lebt = true));

  ws.on("message", (daten) => {
    let m;
    try {
      m = JSON.parse(daten.toString());
    } catch (e) {
      return;
    }
    if (m.t === "create" && !ws.raum) {
      const code = neuerCode();
      raeume.set(code, new Map([[ws.id, ws]]));
      ws.raum = code;
      senden(ws, { t: "created", code, id: ws.id });
    } else if (m.t === "join" && !ws.raum) {
      const code = String(m.code || "").toUpperCase().trim();
      const raum = raeume.get(code);
      if (!raum) return senden(ws, { t: "error", msg: "Raum nicht gefunden." });
      if (raum.size >= MAX_SPIELER) return senden(ws, { t: "error", msg: "Raum ist voll." });
      const peers = [...raum.keys()];
      for (const [, andere] of raum) senden(andere, { t: "peer_join", id: ws.id });
      raum.set(ws.id, ws);
      ws.raum = code;
      senden(ws, { t: "joined", code, id: ws.id, peers });
    } else if (m.t === "list" && !ws.raum) {
      const liste = [];
      for (const [code, raum] of raeume) liste.push({ code, n: raum.size });
      senden(ws, { t: "rooms", list: liste });
    } else if (m.t === "msg" && ws.raum) {
      const raum = raeume.get(ws.raum);
      if (!raum) return;
      for (const [id, andere] of raum) if (id !== ws.id) senden(andere, { t: "msg", from: ws.id, d: m.d });
    }
  });
  ws.on("close", () => verlassen(ws));
  ws.on("error", () => verlassen(ws));
});

// Verbindungen am Leben halten (Hosting-Dienste trennen sonst nach Leerlauf) und tote aufraeumen
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.lebt) {
      ws.terminate();
      continue;
    }
    ws.lebt = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log("Relay laeuft auf Port " + PORT));
