// Relay-Server fuer THE HOUSE, HORRORMARKT, DOENER DER TOTEN (Port 3000) und WUESTENDUELL (Port 3001, Pfad /wd):
// Raeume mit 5-stelligem Code, bis zu 5 Spieler pro Raum. Leitet Nachrichten eines Spielers an alle anderen
// im Raum weiter (oder gezielt an einen: "to"). Spiel-Kennung "g" trennt die Spiele (ohne Kennung = THE HOUSE).
//
// Schutz (Version 3):
//  - max. 1 MB pro Nachricht, Zeit-/Groessenlimits fuer HTTP
//  - Mengenbremse pro Verbindung (150 Nachrichten/s, 2 MB/s), bei Dauerflut Trennung
//  - pro IP: max. 10 Verbindungen, 30 Verbindungsversuche/min, 3 Raeume, 10 Beitrittsversuche/min
//  - gesamt: max. 500 Verbindungen, 200 Raeume
//  - langsame Empfaenger (> 2 MB Rueckstau) werden getrennt
//  - strenge Pruefung aller Felder, Leerlauf ohne Raum > 10 min wird getrennt
//  - Statusseite verraet nichts ("ok")
//
// Protokoll (nur Verbindungsdaten, NIE Chat/Sprachchat/Spielinhalte):
//  - eine Datei pro Tag in LOG_DIR (Standard /var/log/relay), nach 7 Tagen automatisch geloescht, nur fuer den Besitzer lesbar
//  - normal: Zeit, IP, Land/Region/Stadt (falls geoip-lite installiert), Spiel, Raum, Spielername + Figur (mitgelesen), Dauer
//  - auffaellig: zusaetzlich alle Verbindungs-Header, welche Grenze verletzt wurde, wie oft, Nachrichtenarten/-groessen
//  - live und uebersichtlich: /var/log/relay/uebersicht-JJJJ-MM-TT.txt (alle 3 s neu) – ansehen: node bericht.js live
//
// Start: npm install && npm start

"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { Uebersicht } = require("./uebersicht");

let geoip = null;
try {
  geoip = require("geoip-lite"); // optional: Land/Region/Stadt zur IP (kostenlos, offline)
} catch (e) {
  geoip = null;
}

// ------------------------------------------------------------------ Einstellungen
const PORT = process.env.PORT || 8080;
const MAX_SPIELER = 5;
const ZEICHEN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const STANDARD_SPIEL = "haus";

const MAX_NACHRICHT = 1024 * 1024; // 1 MB
const MSG_PRO_S = 150, MSG_SPITZE = 300; // Nachrichten pro Sekunde / kurzfristige Spitze
const BYTES_PRO_S = 2 * 1024 * 1024, BYTES_SPITZE = 4 * 1024 * 1024;
const VERSTOESSE_BIS_TRENNUNG = 200; // gedrosselte Nachrichten, bevor getrennt wird
const MAX_VERB_PRO_IP = 10;
const MAX_VERSUCHE_PRO_IP_MIN = 30;
const MAX_RAEUME_PRO_IP = 3;
const MAX_BEITRITTE_PRO_IP_MIN = 10;
const MAX_LISTEN_PRO_IP_MIN = 60;
const MAX_VERBINDUNGEN = 500;
const MAX_RAEUME = 200;
const MAX_RUECKSTAU = 2 * 1024 * 1024;
const LEERLAUF_OHNE_RAUM_MS = 10 * 60 * 1000;
const SPERRE_MS = 10 * 60 * 1000; // Auffaellige IP nach Trennung 10 min sperren

const LOG_DIR = process.env.LOG_DIR || "/var/log/relay";
const LOG_TAGE = 7;
const LOG_MAX_BYTES_TAG = 50 * 1024 * 1024; // Schutz: Protokoll selbst darf die Platte nicht fuellen

// ------------------------------------------------------------------ Protokoll
// Jede Zeile wird SOFORT geschrieben (live). Zusaetzlich alle 3 s eine uebersichtliche Tabelle:
//   /var/log/relay/uebersicht-JJJJ-MM-TT.txt   (ansehen: node bericht.js live)
const LAUF = Date.now().toString(36); // Kennung dieses Server-Laufs
let ueb = new Uebersicht(LAUF);
let uebGeaendert = true;
let logTag = "", logBytes = 0, logAufPlatte = true;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOG_DIR, 0o700);
} catch (e) {
  logAufPlatte = false; // z. B. auf Render: dann nur Konsole
}

function heute() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
}

function alteLogsLoeschen() {
  if (!logAufPlatte) return;
  try {
    const grenze = Date.now() - LOG_TAGE * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const t = Date.parse(f.slice(0, 10) + "T23:59:59Z");
      if (t < grenze) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch (e) {}
}

let vollGemeldet = false;
function log(art, daten) {
  const obj = Object.assign({ z: new Date().toISOString(), art }, daten);
  const tag = heute();
  if (tag !== logTag) {
    if (logTag) neuerTagUebersicht();
    logTag = tag;
    logBytes = 0;
    vollGemeldet = false;
    try {
      logBytes = fs.statSync(path.join(LOG_DIR, tag + ".log")).size;
    } catch (e) {}
    alteLogsLoeschen();
  }
  ueb.ereignis(obj);
  uebGeaendert = true;
  const zeile = JSON.stringify(obj) + "\n";
  if (!logAufPlatte) {
    process.stdout.write(zeile);
    return;
  }
  if (logBytes > LOG_MAX_BYTES_TAG) {
    if (vollGemeldet) return;
    vollGemeldet = true;
    const hinweis = JSON.stringify({ z: obj.z, art: "voll", info: "Tageslimit Protokoll erreicht – Uebersicht laeuft weiter" }) + "\n";
    try { fs.appendFileSync(path.join(LOG_DIR, tag + ".log"), hinweis, { mode: 0o600 }); } catch (e) {}
    return;
  }
  logBytes += zeile.length;
  try {
    fs.appendFileSync(path.join(LOG_DIR, tag + ".log"), zeile, { mode: 0o600 });
  } catch (e) {}
}

// Pro IP nicht mehr als N gleichartige Eintraege pro Minute (sonst koennte man das Protokoll fluten)
const logZaehler = new Map();
function logBegrenzt(ip, art, daten) {
  const k = ip + "|" + art + "|" + ((daten && daten.grund) || "");
  const jetzt = Date.now();
  let e = logZaehler.get(k);
  if (!e || jetzt - e.t > 60000) {
    if (e && e.unterdrueckt > 0) log("zusammenfassung", { ip, ueber: art, grund: daten && daten.grund, unterdrueckt: e.unterdrueckt });
    e = { t: jetzt, n: 0, unterdrueckt: 0 };
    logZaehler.set(k, e);
  }
  e.n++;
  if (e.n <= 10) log(art, Object.assign({ ip }, daten));
  else e.unterdrueckt++;
}

// Aufrufe von Startseite / Status / Protokoll-Seite als "Besuche": jeder Besuch wird einzeln protokolliert
// (Beginn sofort mit IP/Ort/Programm/Benutzer, Ende mit Anzahl Aufrufe). Aufrufe derselben IP auf derselben Seite
// mit weniger als `pause` Abstand (z. B. das automatische Neuladen der Protokoll-Seite) gehoeren zum selben Besuch.
const webBesuche = new Map(); // ip|art|pfad -> { b, n, start, letzt, pause }
function webAufruf(ip, art, pfad, req, pause, benutzer) {
  const k = ip + "|" + art + "|" + pfad;
  const jetzt = Date.now();
  const v = webBesuche.get(k);
  if (v && jetzt - v.letzt < v.pause) { v.n++; v.letzt = jetzt; uebGeaendert = true; return; }
  if (v) webEnde(v);
  const z = new Date(jetzt).toISOString();
  const b = k + "|" + z;
  if (webBesuche.size > 5000) { for (const x of webBesuche.values()) webEnde(x); }
  webBesuche.set(k, { b, n: 1, start: jetzt, letzt: jetzt, pause: pause || 10 * 60000 });
  log(art, {
    ip, b, pfad: String(pfad).slice(0, 60), methode: String(req.method).slice(0, 10), benutzer,
    ua: String(req.headers["user-agent"] || "").slice(0, 200), geo: geo(ip),
  });
}
function webEnde(v) {
  for (const [k, x] of webBesuche) if (x === v) webBesuche.delete(k);
  log("web_ende", { b: v.b, anzahl: v.n, bis: new Date(v.letzt).toISOString(), dauer_s: Math.round((v.letzt - v.start) / 1000) });
}
// abgelaufene Besuche jede Minute abschliessen
setInterval(() => {
  const jetzt = Date.now();
  for (const v of [...webBesuche.values()]) if (jetzt - v.letzt >= v.pause) webEnde(v);
}, 60000).unref();

function geo(ip) {
  if (!geoip || typeof ip !== "string") return undefined;
  ip = ip.replace(/^::ffff:/, "");
  // nur saubere IP-Adressen an die Bibliothek geben (Schutz vor praeparierten, ueberlangen Eingaben)
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !(ip.length <= 39 && /^[0-9a-fA-F:]+$/.test(ip))) return undefined;
  try {
    const g = geoip.lookup(ip);
    if (!g) return undefined;
    const land = { AT: "Österreich", DE: "Deutschland", CH: "Schweiz", TR: "Türkei", US: "USA" }[g.country] || g.country;
    const bl = g.country === "AT" ? { 1: "Burgenland", 2: "Kärnten", 3: "NÖ", 4: "OÖ", 5: "Salzburg", 6: "Steiermark", 7: "Tirol", 8: "Vorarlberg", 9: "Wien" }[g.region] : g.region;
    const stadt = g.city === "Vienna" ? "Wien" : g.city;
    return [land, bl !== stadt ? bl : "", stadt].filter(Boolean).join(" / ");
  } catch (e) {
    return undefined;
  }
}

// ------------------------------------------------------------------ IP & Zaehler
function ipVon(req) {
  const roh = req.socket.remoteAddress || "";
  const lokal = roh === "127.0.0.1" || roh === "::1" || roh === "::ffff:127.0.0.1";
  const h = req.headers;
  // Render steht hinter Cloudflare: cf-connecting-ip ist verlaesslich. Oracle: Caddy setzt X-Forwarded-For selbst.
  if (process.env.RENDER && typeof h["cf-connecting-ip"] === "string") return h["cf-connecting-ip"].trim();
  if ((lokal || process.env.RENDER) && typeof h["x-forwarded-for"] === "string") return h["x-forwarded-for"].split(",")[0].trim();
  return roh;
}

const ipDaten = new Map(); // ip -> { verb, versuche:[t], beitritte:[t], listen:[t], raeume:Set, gesperrtBis, auffaellig }
function ipEintrag(ip) {
  let e = ipDaten.get(ip);
  if (!e) {
    e = { verb: 0, versuche: [], beitritte: [], listen: [], raeume: new Set(), gesperrtBis: 0, auffaellig: false };
    ipDaten.set(ip, e);
  }
  return e;
}
function proMinute(liste) {
  const grenze = Date.now() - 60000;
  while (liste.length && liste[0] < grenze) liste.shift();
  return liste.length;
}

// Alle Header (fuer Auffaellige) – ohne Cookies/Autorisierung
function alleHeader(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "cookie" || k === "authorization") continue;
    out[k] = String(v).slice(0, 300);
  }
  return out;
}

function auffaellig(ws, grund, details) {
  const e = ipEintrag(ws.ip);
  const erstesMal = !ws.auffaellig;
  ws.auffaellig = true;
  e.auffaellig = true;
  logBegrenzt(ws.ip, "auffaellig", Object.assign({
    id: ws.id, sk: ws.sk, grund, spiel: ws.spiel, raum: ws.raum, name: ws.name,
    header: erstesMal ? ws.header : undefined,
    statistik: erstesMal ? { nachrichten: ws.msgs, bytes: ws.bytes, arten: ws.arten } : undefined,
  }, details || {}));
}

// ------------------------------------------------------------------ HTTP (nur "ok", alles andere 404) + Verbindungsaufbau
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NACHRICHT, perMessageDeflate: false });
const wssWd = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
const raeume = new Map(); // code -> { spiel, spieler: Map(id -> ws), ip, namenT }
let naechsteId = 1;

function* alleClients() {
  yield* wss.clients;
  yield* wssWd.clients;
}
function anzahlClients() {
  return wss.clients.size + wssWd.clients.size;
}

function ablehnen(socket, code, text) {
  try {
    socket.write("HTTP/1.1 " + code + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  } catch (e) {}
  socket.destroy();
}

function httpServer(wssX, okPfade, mitProtokoll) {
  const srv = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const ip = ipVon(req);
    if (mitProtokoll && String(req.url).split("?")[0].startsWith("/protokoll")) return protokollSeite(req, res, ip);
    if (mitProtokoll && req.method === "GET" && String(req.url).split("?")[0] === "/status") {
      webAufruf(ip, "web_aufruf", "/status", req);
      return statusSeite(res);
    }
    // GET und HEAD (Render prueft per HEAD /, ob der Dienst laeuft)
    if ((req.method === "GET" || req.method === "HEAD") && okPfade.indexOf(String(req.url).split("?")[0]) >= 0) {
      webAufruf(ip, "web_aufruf", (mitProtokoll ? "" : "WD ") + String(req.url).split("?")[0], req);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "ok");
      return;
    }
    // Scanner/Angreifer suchen hier nach Luecken (z. B. /wp-login.php, /.env, PHP-Uploads) – mitschreiben, Body nie lesen
    logBegrenzt(ip, "http_fremd", {
      methode: String(req.method).slice(0, 10), url: String(req.url).slice(0, 200),
      ua: String(req.headers["user-agent"] || "").slice(0, 200), geo: geo(ip),
    });
    res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
    res.end("not found");
    req.socket.destroy();
  });
  srv.headersTimeout = 10000;
  srv.requestTimeout = 15000;
  srv.keepAliveTimeout = 5000;
  srv.timeout = 30000;
  srv.on("upgrade", (req, socket, head) => {
    const ip = ipVon(req);
    const e = ipEintrag(ip);
    const jetzt = Date.now();
    e.versuche.push(jetzt);
    if (e.gesperrtBis > jetzt) {
      logBegrenzt(ip, "abgelehnt", { grund: "gesperrt (vorher auffaellig)" });
      return ablehnen(socket, 429, "Too Many Requests");
    }
    if (proMinute(e.versuche) > MAX_VERSUCHE_PRO_IP_MIN) {
      logBegrenzt(ip, "abgelehnt", { grund: "zu viele Verbindungsversuche/min", anzahl: e.versuche.length, header: alleHeader(req), geo: geo(ip) });
      e.auffaellig = true;
      return ablehnen(socket, 429, "Too Many Requests");
    }
    if (e.verb >= MAX_VERB_PRO_IP) {
      logBegrenzt(ip, "abgelehnt", { grund: "zu viele gleichzeitige Verbindungen", anzahl: e.verb, header: alleHeader(req), geo: geo(ip) });
      e.auffaellig = true;
      return ablehnen(socket, 429, "Too Many Requests");
    }
    if (anzahlClients() >= MAX_VERBINDUNGEN) {
      logBegrenzt(ip, "abgelehnt", { grund: "Server voll (Gesamtlimit)" });
      return ablehnen(socket, 503, "Service Unavailable");
    }
    wssX.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      ws.header = alleHeader(req);
      wssX.emit("connection", ws, req);
    });
  });
  return srv;
}

const server = httpServer(wss, ["/", "/health"], true);
const WD_PORT = process.env.WD_PORT || (process.env.RENDER ? "" : "3001");
const serverWd = WD_PORT ? httpServer(wssWd, ["/", "/wd", "/wd/", "/health"]) : null;

// ------------------------------------------------------------------ Oeffentlicher Kurzstatus  /status
// Nur Zahlen und Sicherheits-Pruefungen – KEINE IPs, Namen, Raeume, Chat. Fuer die woechentliche Pruefung.
// Ergebnis wird 10 min zwischengespeichert (Abruf kostet den Server praktisch nichts).
const os = require("os");
const START_ZEIT = Date.now();
let statusCache = null, statusZeit = 0;

function zaehle(u, z) {
  for (const s of u.sitz.values()) {
    const g = s.spiel || "ohne";
    const e = z.spiele[g] || (z.spiele[g] = { sitzungen: 0, raeume: new Set() });
    if (s.raum) { e.sitzungen++; e.raeume.add(s.raum); }
  }
  for (const a of u.auff.values()) {
    z.auffaellig_ips++;
    for (const [g, n] of Object.entries(a.gruende)) z.auffaellig_gruende[g] = (z.auffaellig_gruende[g] || 0) + n;
  }
  for (const a of u.abgel.values()) {
    z.abgelehnt_ips++;
    for (const [g, n] of Object.entries(a.gruende)) z.abgelehnt_gruende[g] = (z.abgelehnt_gruende[g] || 0) + n;
  }
  for (const h of u.http.values()) { z.web_scanner_ips++; z.web_scanner_anfragen += h.n; }
  z.server_starts += u.serverStarts.length;
}

function sicherheit() {
  const c = {};
  try { c.laeuft_als = os.userInfo().username; } catch (e) { c.laeuft_als = "?"; }
  c.als_root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  c.node = process.version;
  c.protokoll_auf_platte = logAufPlatte;
  if (logAufPlatte) {
    try { c.protokoll_ordner_rechte = (fs.statSync(LOG_DIR).mode & 0o777).toString(8); } catch (e) {}
  }
  c.protokoll_seite_aktiv = PW.length >= 12;
  try {
    const sshd = fs.readFileSync("/etc/ssh/sshd_config", "utf8");
    const m = sshd.match(/^\s*PasswordAuthentication\s+(\w+)/im);
    c.ssh_passwort_login = m ? m[1] : "standard";
  } catch (e) {}
  c.php_installiert = ["/usr/bin/php", "/usr/local/bin/php"].some((f) => fs.existsSync(f));
  try {
    const d = fs.statfsSync(logAufPlatte ? LOG_DIR : "/");
    c.platte_frei_gb = Math.round((d.bavail * d.bsize) / 1e8) / 10;
  } catch (e) {}
  c.ram_frei_mb = Math.round(os.freemem() / 1048576);
  c.ram_relay_mb = Math.round(process.memoryUsage().rss / 1048576);
  return c;
}

function statusSeite(res) {
  if (!statusCache || Date.now() - statusZeit > 10 * 60 * 1000) {
    const z = { spiele: {}, auffaellig_ips: 0, auffaellig_gruende: {}, abgelehnt_ips: 0, abgelehnt_gruende: {},
      web_scanner_ips: 0, web_scanner_anfragen: 0, server_starts: 0 };
    const tage = [];
    for (const tag of protokollTage()) {
      if (tag === heute() || !logAufPlatte) { zaehle(ueb, z); tage.push(tag); continue; }
      const u = new Uebersicht("status");
      try {
        for (const zl of fs.readFileSync(path.join(LOG_DIR, tag + ".log"), "utf8").split("\n")) {
          if (!zl) continue;
          try { u.ereignis(JSON.parse(zl)); } catch (e) {}
        }
        zaehle(u, z);
        tage.push(tag);
      } catch (e) {}
    }
    const spiele = {};
    for (const [g, e] of Object.entries(z.spiele)) spiele[g] = { sitzungen: e.sitzungen, raeume: e.raeume.size };
    statusCache = JSON.stringify({
      ok: true, server: process.env.RENDER ? "render" : "oracle", stand: new Date().toISOString(),
      laeuft_seit_h: Math.round((Date.now() - START_ZEIT) / 360000) / 10,
      zeitraum: tage.length ? tage[tage.length - 1] + " bis " + tage[0] : "",
      jetzt_online: anzahlClients(), raeume_offen: raeume.size + raeumeWd.size,
      wuestenduell_port: serverWd ? Number(WD_PORT) : null,
      spiele, auffaellig_ips: z.auffaellig_ips, auffaellig_gruende: z.auffaellig_gruende,
      abgelehnt_ips: z.abgelehnt_ips, abgelehnt_gruende: z.abgelehnt_gruende,
      web_scanner_ips: z.web_scanner_ips, web_scanner_anfragen: z.web_scanner_anfragen,
      server_starts: z.server_starts, sicherheit: sicherheit(),
    }, null, 2);
    statusZeit = Date.now();
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(statusCache);
}

// ------------------------------------------------------------------ Geschuetzte Protokoll-Seite  /protokoll
// Nur aktiv, wenn PROTOKOLL_PASSWORT gesetzt ist (Oracle: /etc/haus-relay/protokoll.env, Render: Environment).
// Anmeldung per Benutzername/Passwort (Browser-Abfrage), nur ueber https. Falsche Versuche: nach 5 in 10 min
// wird die IP 15 min gesperrt und als auffaellig protokolliert.
const PW = process.env.PROTOKOLL_PASSWORT || "";
const PW_USER = process.env.PROTOKOLL_BENUTZER || "emir";
const pwFehler = new Map(); // ip -> { n, t, bis }

function hash(x) {
  return crypto.createHash("sha256").update(String(x)).digest();
}
function htmlEsc(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function protokollSeite(req, res, ip) {
  const sicher = {
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  };
  if (!PW || PW.length < 12 || req.method !== "GET") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  const jetzt = Date.now();
  let f = pwFehler.get(ip);
  if (f && f.bis > jetzt) {
    webAufruf(ip, "protokoll_gesperrt", "/protokoll", req, 2 * 60000);
    res.writeHead(429, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, sicher));
    return res.end("Zu viele Fehlversuche – bitte spaeter nochmal.");
  }
  // Anmeldung pruefen (zeitkonstant)
  let ok = false;
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Basic ") && auth.length < 500) {
    const roh = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const i = roh.indexOf(":");
    if (i > 0) {
      const u = roh.slice(0, i), p = roh.slice(i + 1);
      ok = crypto.timingSafeEqual(hash(u), hash(PW_USER)) & crypto.timingSafeEqual(hash(p), hash(PW)) ? true : false;
      if (!ok) {
        if (!f || jetzt - f.t > 10 * 60000) f = { n: 0, t: jetzt, bis: 0 };
        f.n++;
        pwFehler.set(ip, f);
        logBegrenzt(ip, "abgelehnt", { grund: "falsches Protokoll-Passwort", benutzer: u.slice(0, 40), geo: geo(ip), ua: String(req.headers["user-agent"] || "").slice(0, 200) });
        if (f.n >= 5) {
          f.bis = jetzt + 15 * 60000;
          ipEintrag(ip).auffaellig = true;
          logBegrenzt(ip, "abgelehnt", { grund: "Protokoll-Seite: 5 Fehlversuche – 15 min gesperrt", geo: geo(ip), ua: String(req.headers["user-agent"] || "").slice(0, 200) });
        }
      }
    }
  }
  if (!ok && !auth) webAufruf(ip, "protokoll_ohne_login", "/protokoll", req, 2 * 60000);
  if (!ok) {
    res.writeHead(401, Object.assign({ "WWW-Authenticate": 'Basic realm="Relay-Protokoll", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" }, sicher));
    return res.end("Anmeldung noetig.");
  }
  pwFehler.delete(ip);
  const pfad = String(req.url).split("?")[0];
  // Tagesdatei herunterladen:  /protokoll/datei/JJJJ-MM-TT
  let m = pfad.match(/^\/protokoll\/datei\/(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    const text = protokollText(m[1]);
    res.writeHead(200, Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="relay-protokoll-' + m[1] + '.txt"' }, sicher));
    return res.end(text);
  }
  // Seite anzeigen:  /protokoll  oder  /protokoll/JJJJ-MM-TT
  m = pfad.match(/^\/protokoll(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
  if (!m) {
    res.writeHead(404, Object.assign({ "Content-Type": "text/plain" }, sicher));
    return res.end("not found");
  }
  const tag = m[1] || heute();
  webAufruf(ip, "protokoll_zugriff", "/protokoll", req, 2 * 60000, PW_USER);
  const tage = protokollTage();
  const knoepfe = tage.map((t) => '<a class="' + (t === tag ? "an" : "") + '" href="/protokoll/' + t + '">' + t.slice(8, 10) + "." + t.slice(5, 7) + ".</a>").join(" ");
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    (tag === heute() ? '<meta http-equiv="refresh" content="5">' : "") +
    "<title>Relay-Protokoll" + (process.env.RENDER ? " (Render)" : " (Oracle)") + "</title><style>" +
    "body{margin:0;background:#0d1117;color:#e6edf3;font:14px system-ui,sans-serif}" +
    "header{padding:10px 14px;background:#161b22;border-bottom:1px solid #30363d;display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
    "h1{font-size:16px;margin:0 12px 0 0}a{color:#58a6ff;text-decoration:none;padding:3px 8px;border:1px solid #30363d;border-radius:6px}" +
    "a.an{background:#1f6feb;color:#fff}pre{margin:0;padding:12px 14px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;overflow-x:auto}" +
    ".info{color:#8b949e;font-size:12px}</style></head><body><header><h1>Relay-Protokoll – " + (process.env.RENDER ? "Render" : "Oracle") + "</h1>" +
    knoepfe + ' <a href="/protokoll/datei/' + tag + '">⬇ Datei</a><span class="info">' +
    (tag === heute() ? "aktualisiert sich alle 5 s" : "") + "</span></header><pre>" + htmlEsc(protokollText(tag)) + "</pre></body></html>";
  res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, sicher));
  res.end(html);
}

function protokollTage() {
  const t = new Set([heute()]);
  if (logAufPlatte) {
    try {
      for (const f of fs.readdirSync(LOG_DIR)) if (/^\d{4}-\d{2}-\d{2}\.log$/.test(f)) t.add(f.slice(0, 10));
    } catch (e) {}
  }
  return [...t].sort().reverse().slice(0, LOG_TAGE + 1);
}

function protokollText(tag) {
  if (tag === heute() || !logAufPlatte) return ueb.text({ live: liveDaten() });
  const u = new Uebersicht("seite");
  try {
    for (const z of fs.readFileSync(path.join(LOG_DIR, tag + ".log"), "utf8").split("\n")) {
      if (!z) continue;
      try { u.ereignis(JSON.parse(z)); } catch (e) {}
    }
  } catch (e) {
    return "Kein Protokoll fuer " + tag;
  }
  return u.text({ titel: tag });
}

// ------------------------------------------------------------------ Hilfen
function neuerCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += ZEICHEN[Math.floor(Math.random() * ZEICHEN.length)];
    if (!raeume.has(c) && !raeumeWd.has(c)) return c;
  }
}

function senden(ws, obj) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_RUECKSTAU) {
    auffaellig(ws, "holt Daten nicht ab (Rueckstau)", { rueckstau: ws.bufferedAmount });
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify(obj));
}

function spielVon(m) {
  return typeof m.g === "string" && /^[A-Za-z0-9_-]{1,15}$/.test(m.g) ? m.g : STANDARD_SPIEL;
}

function textOk(s, max) {
  return typeof s === "string" && s.length <= max;
}

function setzeName(ws, name, figur, quelle) {
  if (!ws || typeof name !== "string") return;
  name = name.replace(/[\u0000-\u001f]/g, "").slice(0, 32);
  if (!name || ws.name === name) return;
  ws.name = name;
  if (typeof figur === "string") ws.figur = figur.slice(0, 60);
  log("name", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: ws.spiel, raum: ws.raum, name: ws.name, figur: ws.figur, quelle });
}

function verlassen(ws) {
  if (!ws.raum) return;
  const raum = raeume.get(ws.raum);
  if (raum) {
    raum.spieler.delete(ws.id);
    for (const [, andere] of raum.spieler) senden(andere, { t: "peer_leave", id: ws.id });
    if (raum.spieler.size === 0) {
      raeume.delete(ws.raum);
      const e = ipDaten.get(raum.ip);
      if (e) e.raeume.delete(ws.raum);
    }
  }
  log("raum_verlassen", { ip: ws.ip, id: ws.id, sk: ws.sk, raum: ws.raum, name: ws.name });
  ws.raum = null;
}

// Mengenbremse (Token-Bucket)
function bremse(ws, groesse) {
  const jetzt = Date.now();
  const dt = (jetzt - ws.bT) / 1000;
  ws.bT = jetzt;
  ws.tokM = Math.min(MSG_SPITZE * ws.faktor, ws.tokM + dt * MSG_PRO_S * ws.faktor);
  ws.tokB = Math.min(BYTES_SPITZE, ws.tokB + dt * BYTES_PRO_S);
  if (ws.tokM < 1 || ws.tokB < groesse) {
    ws.verstoesse++;
    if (ws.verstoesse === 1 || ws.verstoesse % 50 === 0) auffaellig(ws, "Flut: Mengenbremse", { verstoesse: ws.verstoesse });
    if (ws.verstoesse >= VERSTOESSE_BIS_TRENNUNG) {
      auffaellig(ws, "Flut: getrennt", { verstoesse: ws.verstoesse });
      ipEintrag(ws.ip).gesperrtBis = Date.now() + SPERRE_MS;
      ws.terminate();
    }
    return false;
  }
  ws.tokM -= 1;
  ws.tokB -= groesse;
  return true;
}

// Spielernamen mitlesen (nur Name + Figur, sonst NICHTS aus dem Spielinhalt)
function namenMitlesen(ws, d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return;
  // Mitspieler meldet sich beim Host: {"k":"hello","n":"Name","av":"figur.glb"}
  if (d.k === "hello" && typeof d.n === "string") return setzeName(ws, d.n, d.av, "hello");
  // Host schickt Spielerliste: "pl": [[id, name, figur, ...], ...] – alle 10 s auswerten, solange Namen fehlen
  if (Array.isArray(d.pl) && ws.raum) {
    const raum = raeume.get(ws.raum);
    if (!raum || Date.now() - (raum.namenT || 0) < 10000) return;
    raum.namenT = Date.now();
    for (const e of d.pl.slice(0, 16)) {
      if (Array.isArray(e) && typeof e[0] === "number" && typeof e[1] === "string") {
        const sp = raum.spieler.get(e[0]);
        if (sp && !sp.name) setzeName(sp, e[1], e[2], "spielerliste");
      }
    }
  }
}

// ------------------------------------------------------------------ Verbindungen
function verbindungEinrichten(ws, dienst) {
  ws.dienst = dienst;
  ws.faktor = dienst === "wd" ? 3 : 1; // Wuestenduell (Shooter, 10 Spieler): mehr Nachrichten pro Sekunde erlaubt
  ws.id = naechsteId++;
  ws.raum = null;
  ws.spiel = null;
  ws.name = null;
  ws.figur = null;
  ws.lebt = true;
  ws.start = Date.now();
  ws.letzteAktivitaet = Date.now();
  ws.msgs = 0;
  ws.bytes = 0;
  ws.arten = {};
  ws.verstoesse = 0;
  ws.kaputt = 0;
  ws.tokM = MSG_SPITZE * ws.faktor;
  ws.tokB = BYTES_SPITZE;
  ws.bT = Date.now();
  ws.auffaellig = false;
  ws.sk = LAUF + "-" + ws.id;
  const e = ipEintrag(ws.ip);
  e.verb++;
  log("verbunden", {
    ip: ws.ip, id: ws.id, sk: ws.sk, geo: geo(ws.ip),
    ua: ws.header["user-agent"], herkunft: ws.header["origin"], sprache: ws.header["accept-language"],
    // frueher schon auffaellig? dann gleich alles festhalten
    header: e.auffaellig ? ws.header : undefined,
  });
  ws.on("pong", () => (ws.lebt = true));

  ws.on("message", (daten, binaer) => {
    const groesse = daten.length || 0;
    ws.msgs++;
    ws.bytes += groesse;
    ws.letzteAktivitaet = Date.now();
    if (!bremse(ws, groesse)) return;
    if (ws.dienst === "wd") return wdNachricht(ws, daten, binaer);
    if (binaer) {
      ws.kaputt++;
      if (ws.kaputt <= 3) auffaellig(ws, "Binaerdaten statt Text", { groesse });
      return;
    }
    let m;
    try {
      m = JSON.parse(daten.toString());
    } catch (err) {
      ws.kaputt++;
      auffaellig(ws, "kein gueltiges JSON", { groesse, anfang: daten.toString("utf8", 0, 60).replace(/[^\x20-\x7e]/g, "?") });
      if (ws.kaputt > 20) ws.terminate();
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.t !== "string" || m.t.length > 10) {
      ws.kaputt++;
      auffaellig(ws, "falsches Nachrichtenformat", { groesse });
      if (ws.kaputt > 20) ws.terminate();
      return;
    }
    ws.arten[m.t] = (ws.arten[m.t] || 0) + 1;
    const ipE = ipEintrag(ws.ip);

    if (m.t === "create" && !ws.raum) {
      if (raeume.size >= MAX_RAEUME) return senden(ws, { t: "error", msg: "Server voll – bitte spaeter nochmal." });
      if (ipE.raeume.size >= MAX_RAEUME_PRO_IP) {
        auffaellig(ws, "zu viele Raeume von einer IP", { raeume: ipE.raeume.size });
        return senden(ws, { t: "error", msg: "Zu viele Raeume von deinem Anschluss." });
      }
      const code = neuerCode();
      const spiel = spielVon(m);
      ws.spiel = spiel;
      raeume.set(code, { spiel, spieler: new Map([[ws.id, ws]]), ip: ws.ip, namenT: 0 });
      ipE.raeume.add(code);
      ws.raum = code;
      log("raum_erstellt", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel, raum: code });
      senden(ws, { t: "created", code, id: ws.id, g: spiel });
    } else if (m.t === "join" && !ws.raum) {
      ipE.beitritte.push(Date.now());
      if (proMinute(ipE.beitritte) > MAX_BEITRITTE_PRO_IP_MIN) {
        auffaellig(ws, "zu viele Beitrittsversuche (Raumcode raten?)", { versuche: ipE.beitritte.length });
        return senden(ws, { t: "error", msg: "Zu viele Versuche – kurz warten." });
      }
      if (!textOk(m.code, 8)) return auffaellig(ws, "ungueltiger Raumcode", {});
      const code = m.code.toUpperCase().trim();
      const raum = raeume.get(code);
      ws.spiel = spielVon(m);
      if (!raum) {
        log("beitritt_fehlgeschlagen", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: ws.spiel, raum: code, grund: "nicht gefunden" });
        return senden(ws, { t: "error", msg: "Raum nicht gefunden." });
      }
      if (raum.spiel !== ws.spiel) return senden(ws, { t: "error", msg: "Dieser Raum gehoert zu einem anderen Spiel." });
      if (raum.spieler.size >= MAX_SPIELER) return senden(ws, { t: "error", msg: "Raum ist voll." });
      const peers = [...raum.spieler.keys()];
      for (const [, andere] of raum.spieler) senden(andere, { t: "peer_join", id: ws.id });
      raum.spieler.set(ws.id, ws);
      raum.namenT = 0;
      ws.raum = code;
      log("raum_beigetreten", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: ws.spiel, raum: code, spieler: raum.spieler.size });
      senden(ws, { t: "joined", code, id: ws.id, peers, host: peers[0], g: raum.spiel });
    } else if (m.t === "list" && !ws.raum) {
      ipE.listen.push(Date.now());
      if (proMinute(ipE.listen) > MAX_LISTEN_PRO_IP_MIN) return auffaellig(ws, "zu viele Raumlisten-Abfragen", { anzahl: ipE.listen.length });
      const spiel = spielVon(m);
      if (!ws.spiel) {
        ws.spiel = spiel;
        log("raumliste", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel });
      }
      const liste = [];
      for (const [code, raum] of raeume) if (raum.spiel === spiel) liste.push({ code, n: raum.spieler.size, g: raum.spiel });
      senden(ws, { t: "rooms", list: liste });
    } else if (m.t === "msg" && ws.raum) {
      const raum = raeume.get(ws.raum);
      if (!raum) return;
      if (m.d === undefined || m.d === null || typeof m.d !== "object") return;
      namenMitlesen(ws, m.d);
      if (m.to !== undefined && m.to !== null) {
        const ziel = raum.spieler.get(Number(m.to));
        if (ziel) senden(ziel, { t: "msg", from: ws.id, d: m.d });
        return;
      }
      for (const [id, andere] of raum.spieler) if (id !== ws.id) senden(andere, { t: "msg", from: ws.id, d: m.d });
    } else {
      ws.kaputt++;
      if (ws.kaputt <= 5) auffaellig(ws, "unbekannte/unerlaubte Aktion", { t: m.t, imRaum: !!ws.raum });
      if (ws.kaputt > 20) ws.terminate();
    }
  });

  let weg = false;
  const schliessen = () => {
    if (weg || ws.beendetProtokolliert) return;
    weg = true;
    if (ws.dienst === "wd") verlassenWd(ws);
    else verlassen(ws);
    const e2 = ipEintrag(ws.ip);
    e2.verb = Math.max(0, e2.verb - 1);
    log("getrennt", {
      ip: ws.ip, id: ws.id, sk: ws.sk, spiel: ws.spiel, name: ws.name, figur: ws.figur,
      dauer_s: Math.round((Date.now() - ws.start) / 1000), nachrichten: ws.msgs,
      kb: Math.round(ws.bytes / 1024), auffaellig: ws.auffaellig || undefined,
    });
  };
  ws.on("close", schliessen);
  ws.on("error", (err) => {
    if (err && err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") auffaellig(ws, "Nachricht zu gross", {});
    else if (err) auffaellig(ws, "Protokollfehler", { fehler: String(err.code || err.message).slice(0, 80) });
    schliessen();
  });
}
wss.on("connection", (ws) => verbindungEinrichten(ws, "haupt"));
wssWd.on("connection", (ws) => verbindungEinrichten(ws, "wd"));

// ------------------------------------------------------------------ WUESTENDUELL (eigenes Protokoll, Pfad /wd, Port 3001)
// Steuerung als JSON-Text, Spieldaten + Sprache als Binaerpakete (Inhalt wird NICHT gelesen/protokolliert).
// Binaer vom Client: [Ziel:1 Byte] (0 = alle anderen, 1 = nur Host, 2 = Liste) [bei 2: Anzahl:1 Byte, IDs je 4 Byte] [Nutzdaten]
// Binaer zum Client: [Absender-ID: 4 Byte] [Nutzdaten]
const WD_MAX_SPIELER = 10;
const raeumeWd = new Map(); // code -> { code, host, mitglieder: Map(id -> ws), ip }

function sendenRoh(ws, puffer) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_RUECKSTAU) {
    auffaellig(ws, "holt Daten nicht ab (Rueckstau)", { rueckstau: ws.bufferedAmount });
    ws.terminate();
    return;
  }
  ws.send(puffer, { binary: true });
}

function verlassenWd(ws) {
  if (!ws.raum) return;
  const code = ws.raum;
  const raum = raeumeWd.get(code);
  ws.raum = null;
  log("raum_verlassen", { ip: ws.ip, id: ws.id, sk: ws.sk, raum: code, name: ws.name });
  if (!raum) return;
  raum.mitglieder.delete(ws.id);
  const ende = () => {
    raeumeWd.delete(code);
    const e = ipDaten.get(raum.ip);
    if (e) e.raeume.delete(code);
  };
  if (raum.host === ws.id) {
    // Host weg = Spiel vorbei
    for (const [, andere] of raum.mitglieder) {
      senden(andere, { t: "closed" });
      andere.raum = null;
      log("raum_verlassen", { ip: andere.ip, id: andere.id, sk: andere.sk, raum: code, name: andere.name, grund: "Host weg" });
    }
    return ende();
  }
  for (const [, andere] of raum.mitglieder) senden(andere, { t: "peer_leave", id: ws.id });
  if (raum.mitglieder.size === 0) ende();
}

function wdNachricht(ws, daten, binaer) {
  if (binaer) {
    const raum = ws.raum ? raeumeWd.get(ws.raum) : null;
    if (!raum || daten.length < 1) return;
    const ziel = daten[0];
    let start = 1;
    const empfaenger = [];
    if (ziel === 0) {
      for (const [id, andere] of raum.mitglieder) if (id !== ws.id) empfaenger.push(andere);
    } else if (ziel === 1) {
      const h = raum.mitglieder.get(raum.host);
      if (h && h !== ws) empfaenger.push(h);
    } else if (ziel === 2) {
      if (daten.length < 2) return;
      const n = daten[1];
      start = 2 + n * 4;
      if (n > WD_MAX_SPIELER || start > daten.length) {
        ws.kaputt++;
        if (ws.kaputt <= 5) auffaellig(ws, "kaputtes Binaerpaket", { groesse: daten.length });
        return;
      }
      for (let i = 0; i < n; i++) {
        const a = raum.mitglieder.get(daten.readUInt32LE(2 + i * 4));
        if (a && a !== ws) empfaenger.push(a);
      }
    } else {
      ws.kaputt++;
      if (ws.kaputt <= 5) auffaellig(ws, "unbekanntes Binaerziel", { ziel, groesse: daten.length });
      if (ws.kaputt > 50) ws.terminate();
      return;
    }
    const raus = Buffer.allocUnsafe(4 + daten.length - start);
    raus.writeUInt32LE(ws.id, 0);
    daten.copy(raus, 4, start);
    for (const a of empfaenger) sendenRoh(a, raus);
    return;
  }
  let m;
  try {
    m = JSON.parse(daten.toString());
  } catch (err) {
    ws.kaputt++;
    auffaellig(ws, "kein gueltiges JSON", { groesse: daten.length, anfang: daten.toString("utf8", 0, 60).replace(/[^\x20-\x7e]/g, "?") });
    if (ws.kaputt > 20) ws.terminate();
    return;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    ws.kaputt++;
    auffaellig(ws, "falsches Nachrichtenformat", { groesse: daten.length });
    if (ws.kaputt > 20) ws.terminate();
    return;
  }
  if (!ws.spiel) ws.spiel = "wd";
  if (typeof m.t === "string") ws.arten[m.t.slice(0, 10)] = (ws.arten[m.t.slice(0, 10)] || 0) + 1;
  if (m.name !== undefined && m.name !== null) setzeName(ws, String(m.name).slice(0, 16), null, "wd");
  const ipE = ipEintrag(ws.ip);
  if (m.t === "create" && !ws.raum) {
    if (raeume.size + raeumeWd.size >= MAX_RAEUME) return senden(ws, { t: "error", msg: "Server voll – bitte spaeter nochmal." });
    if (ipE.raeume.size >= MAX_RAEUME_PRO_IP) {
      auffaellig(ws, "zu viele Raeume von einer IP", { raeume: ipE.raeume.size });
      return senden(ws, { t: "error", msg: "Zu viele Raeume von deinem Anschluss." });
    }
    const code = neuerCode();
    raeumeWd.set(code, { code, host: ws.id, mitglieder: new Map([[ws.id, ws]]), ip: ws.ip });
    ipE.raeume.add(code);
    ws.raum = code;
    log("raum_erstellt", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: "wd", raum: code });
    senden(ws, { t: "created", code, id: ws.id });
  } else if (m.t === "join" && !ws.raum) {
    ipE.beitritte.push(Date.now());
    if (proMinute(ipE.beitritte) > MAX_BEITRITTE_PRO_IP_MIN) {
      auffaellig(ws, "zu viele Beitrittsversuche (Raumcode raten?)", { versuche: ipE.beitritte.length });
      return senden(ws, { t: "error", msg: "Zu viele Versuche – kurz warten." });
    }
    if (!textOk(m.code, 8)) return auffaellig(ws, "ungueltiger Raumcode", {});
    const code = m.code.toUpperCase().trim();
    const raum = raeumeWd.get(code);
    if (!raum) {
      log("beitritt_fehlgeschlagen", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: "wd", raum: code, grund: "nicht gefunden" });
      return senden(ws, { t: "error", msg: "Raum nicht gefunden." });
    }
    if (raum.mitglieder.size >= WD_MAX_SPIELER) return senden(ws, { t: "error", msg: "Raum ist voll." });
    const peers = [];
    for (const [id, andere] of raum.mitglieder) {
      peers.push({ id, name: andere.name || "Spieler" });
      senden(andere, { t: "peer_join", id: ws.id, name: ws.name || "Spieler" });
    }
    raum.mitglieder.set(ws.id, ws);
    ws.raum = code;
    log("raum_beigetreten", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: "wd", raum: code, spieler: raum.mitglieder.size });
    senden(ws, { t: "joined", code, id: ws.id, host: raum.host, peers });
  } else if (m.t === "list" && !ws.raum) {
    ipE.listen.push(Date.now());
    if (proMinute(ipE.listen) > MAX_LISTEN_PRO_IP_MIN) return auffaellig(ws, "zu viele Raumlisten-Abfragen", { anzahl: ipE.listen.length });
    if (!ws.listeGeloggt) {
      ws.listeGeloggt = true;
      log("raumliste", { ip: ws.ip, id: ws.id, sk: ws.sk, spiel: "wd" });
    }
    const liste = [];
    for (const [code, raum] of raeumeWd) {
      const h = raum.mitglieder.get(raum.host);
      liste.push({ code, n: raum.mitglieder.size, host: h ? h.name || "Spieler" : "?" });
    }
    senden(ws, { t: "rooms", list: liste });
  } else if (m.t === "leave") {
    verlassenWd(ws);
  } else if (m.t !== undefined && !(m.t === "create" || m.t === "join" || m.t === "list")) {
    ws.kaputt++;
    if (ws.kaputt <= 5) auffaellig(ws, "unbekannte/unerlaubte Aktion", { t: String(m.t).slice(0, 20), imRaum: !!ws.raum });
    if (ws.kaputt > 20) ws.terminate();
  }
}

// Verbindungen am Leben halten (Hosting-Dienste trennen sonst nach Leerlauf), tote und lange untaetige aufraeumen
setInterval(() => {
  const jetzt = Date.now();
  for (const ws of alleClients()) {
    if (!ws.lebt) {
      ws.terminate();
      continue;
    }
    if (!ws.raum && jetzt - ws.letzteAktivitaet > LEERLAUF_OHNE_RAUM_MS) {
      ws.close(1000, "idle");
      continue;
    }
    ws.lebt = false;
    ws.ping();
  }
}, 25000);

// Zaehler aufraeumen (sonst wuerde die IP-Liste ewig wachsen)
setInterval(() => {
  const jetzt = Date.now();
  for (const [ip, e] of ipDaten) {
    proMinute(e.versuche);
    proMinute(e.beitritte);
    proMinute(e.listen);
    if (e.verb === 0 && e.raeume.size === 0 && !e.versuche.length && !e.beitritte.length && !e.listen.length && e.gesperrtBis < jetzt) {
      ipDaten.delete(ip);
    }
  }
  for (const [k, z] of logZaehler) if (jetzt - z.t > 120000) logZaehler.delete(k);
  alteLogsLoeschen();
}, 60000);

// ------------------------------------------------------------------ Live-Uebersicht
function liveDaten() {
  const m = new Map();
  const jetzt = Date.now();
  for (const ws of alleClients()) if (ws.sk) m.set(ws.sk, { dauer_s: Math.round((jetzt - ws.start) / 1000), kb: Math.round(ws.bytes / 1024) });
  m.web = new Map();
  for (const v of webBesuche.values()) m.web.set(v.b, { n: v.n, letzt: new Date(v.letzt).toISOString() });
  return m;
}

function uebersichtSchreiben() {
  if (!logAufPlatte) return;
  if (!uebGeaendert && anzahlClients() === 0) return;
  uebGeaendert = false;
  const datei = path.join(LOG_DIR, "uebersicht-" + (logTag || heute()) + ".txt");
  try {
    fs.writeFileSync(datei + ".tmp", ueb.text({ live: liveDaten() }), { mode: 0o600 });
    fs.renameSync(datei + ".tmp", datei);
  } catch (e) {}
}
setInterval(uebersichtSchreiben, 3000);

// Mitternacht: neue Uebersicht, laufende Sitzungen werden mitgenommen
function neuerTagUebersicht() {
  uebersichtSchreiben();
  const alt = ueb;
  ueb = new Uebersicht(LAUF);
  for (const [sk, s] of alt.sitz) if (!s.ende) ueb.sitz.set(sk, s);
  uebGeaendert = true;
}

// Beim Start: heutiges Protokoll einlesen (Uebersicht bleibt nach Neustart vollstaendig)
function heuteEinlesen() {
  if (!logAufPlatte) return;
  logTag = heute();
  try {
    const roh = fs.readFileSync(path.join(LOG_DIR, logTag + ".log"), "utf8");
    logBytes = roh.length;
    for (const z of roh.split("\n")) {
      if (!z) continue;
      try {
        ueb.ereignis(JSON.parse(z));
      } catch (e) {}
    }
  } catch (e) {}
}
heuteEinlesen();

// Beim Beenden des Servers: offene Eintraege sauber abschliessen
let beendet = false;
function beenden(signal) {
  if (beendet) return;
  beendet = true;
  for (const ws of alleClients()) {
    log("getrennt", {
      ip: ws.ip, id: ws.id, sk: ws.sk, spiel: ws.spiel, name: ws.name, figur: ws.figur,
      dauer_s: Math.round((Date.now() - ws.start) / 1000), nachrichten: ws.msgs, kb: Math.round(ws.bytes / 1024), grund: "Server beendet",
    });
    ws.beendetProtokolliert = true;
  }
  for (const v of [...webBesuche.values()]) webEnde(v);
  log("stopp", { signal });
  uebGeaendert = true;
  uebersichtSchreiben();
  process.exit(0);
}
process.on("SIGTERM", () => beenden("SIGTERM"));
process.on("SIGINT", () => beenden("SIGINT"));

server.listen(PORT, () => {
  log("start", { port: Number(PORT), protokoll: logAufPlatte ? LOG_DIR : "Konsole", geoip: !!geoip });
  console.log("Relay laeuft auf Port " + PORT + (logAufPlatte ? " – Protokoll: " + LOG_DIR : " – Protokoll: Konsole"));
});
if (serverWd) {
  serverWd.on("error", (e) => {
    // Port belegt (z. B. alter wd-relay-Dienst laeuft noch): Haupt-Relay laeuft trotzdem weiter
    log("fehler", { info: "Wuestenduell-Port " + WD_PORT + " nicht verfuegbar: " + (e.code || e.message) });
    console.log("Wuestenduell-Port " + WD_PORT + " nicht verfuegbar (" + (e.code || e.message) + ")");
  });
  serverWd.listen(WD_PORT, () => console.log("Wuestenduell-Relay laeuft auf Port " + WD_PORT));
}
