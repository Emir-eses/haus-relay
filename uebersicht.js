// Uebersichtliche Darstellung des Relay-Protokolls (wird vom Server live geschrieben und von bericht.js benutzt).
// Baut aus den Protokoll-Ereignissen eine Tabelle: SPIELER / ANDERE VERBINDUNGEN / AUFFAELLIG / ABGELEHNT / WEB-ANFRAGEN.
"use strict";

const KEINE = "~keine Info~";

function zeit(iso) {
  if (!iso) return KEINE;
  const d = new Date(iso);
  return d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Europe/Vienna" });
}
function datum(iso) {
  return new Date(iso).toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" });
}
function dauer(s) {
  if (s === undefined || s === null || isNaN(s)) return KEINE;
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
  return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
}
function menge(kb) {
  if (kb === undefined || kb === null) return KEINE;
  return kb < 1024 ? kb + " KB" : (kb / 1024).toFixed(1) + " MB";
}
function figur(f) {
  if (!f) return KEINE;
  const b = String(f).split("/").pop().replace(/\.(glb|fbx|tscn)$/i, "");
  const teile = b.split("_");
  return teile[teile.length - 1].replace(/^\w/, (c) => c.toUpperCase());
}
function sp(s, n) {
  if (s === KEINE && n < 14) s = "~k. A.~";
  s = s === undefined || s === null || s === "" ? (n < 14 ? "~k. A.~" : KEINE) : String(s);
  if (s.length > n - 1) s = s.slice(0, n - 2) + "…";
  return s + " ".repeat(Math.max(0, n - s.length));
}
const SPIELNAMEN = { haus: "THE HOUSE", hm: "Horrormarkt", dk: "Döner der Toten", cs: "CS-Spiel", wd: "Wüstenduell" };
function spiel(g) {
  return g ? SPIELNAMEN[g] || g : KEINE;
}

class Uebersicht {
  constructor(laufKennung) {
    this.lauf = laufKennung || ""; // Kennung des aktuellen Server-Laufs (offene Sitzungen anderer Laeufe = unterbrochen)
    this.sitz = new Map(); // sk -> Sitzung
    this.auff = new Map(); // ip -> { geo, gruende:{grund:n}, erst, letzt, namen:Set, ua }
    this.abgel = new Map(); // ip -> { gruende:{}, erst, letzt, n }
    this.http = new Map(); // ip -> { geo, anfragen:[], n, ua, letzt }
    this.serverStarts = [];
  }

  ereignis(e) {
    if (!e || !e.art) return;
    if (e.art === "start") {
      this.serverStarts.push(e.z);
      return;
    }
    const s = e.sk ? this._sitzung(e) : null;
    switch (e.art) {
      case "verbunden":
        s.start = e.z; s.ip = e.ip; s.geo = e.geo; s.ua = e.ua;
        break;
      case "raumliste":
        s.spiel = s.spiel || e.spiel; s.liste = true;
        break;
      case "raum_erstellt":
        s.spiel = e.spiel; s.raum = e.raum; s.rolle = "Host";
        break;
      case "raum_beigetreten":
        s.spiel = e.spiel; s.raum = e.raum; s.rolle = "Mitspieler";
        break;
      case "beitritt_fehlgeschlagen":
        s.spiel = e.spiel; s.fehlversuche = (s.fehlversuche || 0) + 1;
        break;
      case "name":
        if (s) { s.name = e.name; if (e.figur) s.figur = e.figur; if (e.raum) s.raum = e.raum; }
        break;
      case "getrennt":
        s.ende = e.z; s.dauer = e.dauer_s; s.kb = e.kb; s.nachrichten = e.nachrichten;
        if (e.name) s.name = e.name;
        if (e.figur) s.figur = e.figur;
        break;
      case "auffaellig": {
        if (s) s.auffaellig = true;
        const a = this._auff(e.ip, e.z);
        a.gruende[e.grund] = (a.gruende[e.grund] || 0) + 1;
        if (e.name) a.namen.add(e.name);
        if (e.header && e.header["user-agent"]) a.ua = e.header["user-agent"];
        if (s && s.geo) a.geo = s.geo;
        break;
      }
      case "zusammenfassung": {
        const a = this._auff(e.ip, e.z);
        const g = (e.grund || e.ueber) + " (weitere)";
        a.gruende[g] = (a.gruende[g] || 0) + (e.unterdrueckt || 0);
        break;
      }
      case "abgelehnt": {
        let a = this.abgel.get(e.ip);
        if (!a) { a = { gruende: {}, erst: e.z, n: 0, geo: e.geo }; this.abgel.set(e.ip, a); }
        a.gruende[e.grund] = (a.gruende[e.grund] || 0) + 1;
        a.letzt = e.z; a.n++;
        if (e.geo) a.geo = e.geo;
        break;
      }
      case "http_fremd": {
        let h = this.http.get(e.ip);
        if (!h) { h = { anfragen: [], n: 0, geo: e.geo, ua: e.ua, erst: e.z }; this.http.set(e.ip, h); }
        h.n++; h.letzt = e.z;
        if (h.anfragen.length < 6) h.anfragen.push(e.methode + " " + e.url);
        break;
      }
    }
  }

  _sitzung(e) {
    let s = this.sitz.get(e.sk);
    if (!s) {
      s = { sk: e.sk, start: e.z, ip: e.ip };
      this.sitz.set(e.sk, s);
    }
    return s;
  }
  _auff(ip, z) {
    let a = this.auff.get(ip);
    if (!a) { a = { gruende: {}, erst: z, namen: new Set() }; this.auff.set(ip, a); }
    a.letzt = z;
    return a;
  }

  // live: Map sk -> { dauer_s, kb } fuer gerade verbundene Sitzungen (nur im Server vorhanden)
  text(opts) {
    opts = opts || {};
    const live = opts.live || new Map();
    const jetzt = new Date().toISOString();
    const L = [];
    const offen = [...this.sitz.values()].filter((s) => !s.ende);
    const liveN = offen.filter((s) => live.has(s.sk)).length;
    const raeumeOffen = new Set(offen.filter((s) => live.has(s.sk) && s.raum).map((s) => s.raum)).size;

    L.push("════════════════════════════════════════════════════════════════════════════════════════════════════════════");
    L.push(" RELAY-ÜBERSICHT  " + (opts.titel || datum(jetzt)) + "      Stand: " + zeit(jetzt) +
      "      Jetzt online: " + liveN + "      Räume offen: " + raeumeOffen);
    if (this.serverStarts.length) L.push(" Server gestartet: " + this.serverStarts.map(zeit).join(", "));
    L.push(" ● = läuft gerade   ✓ = beendet   ✗ = unterbrochen (Server-Neustart)   ⚠ = auffällig     " + KEINE + " / ~k. A.~ = (noch) keine Info");
    L.push("════════════════════════════════════════════════════════════════════════════════════════════════════════════");

    const zeile = (s) => {
      const lebt = !s.ende && live.has(s.sk);
      const lv = live.get(s.sk) || {};
      const status = s.ende ? "✓ ENDE " : lebt ? "● LIVE " : "✗ WEG  ";
      return (s.auffaellig ? "⚠" : " ") + status + " " + sp(zeit(s.start), 9) + sp(s.ende ? zeit(s.ende) : lebt ? "~läuft~" : "~unterbr.~", 11) +
        sp(s.ende ? dauer(s.dauer) : lebt ? dauer(lv.dauer_s) : KEINE, 13) + sp(s.name, 16) + sp(s.figur ? figur(s.figur) : null, 10) +
        sp(spiel(s.spiel), 12) + sp(s.raum, 8) + sp(s.rolle, 11) + sp(s.ip, 17) + sp(s.geo, 24) +
        sp(s.ende ? menge(s.kb) : lebt ? menge(lv.kb) + "…" : KEINE, 11);
    };
    const kopf = "  Status   Start    Ende       Dauer        Name            Figur     Spiel       Raum    Rolle      IP               Ort                     Daten";

    const alle = [...this.sitz.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
    const spieler = alle.filter((s) => s.raum);
    const andere = alle.filter((s) => !s.raum);

    L.push("");
    L.push("▶ SPIELER  (Raum erstellt oder beigetreten)   – " + spieler.length + " Sitzungen");
    L.push(kopf);
    if (!spieler.length) L.push("  keine");
    // nach Spiel unterteilt: Spiele mit laufenden Partien zuerst; innerhalb: LIVE oben, dann neueste
    const gruppen = new Map();
    for (const s of spieler) {
      const g = spiel(s.spiel);
      if (!gruppen.has(g)) gruppen.set(g, []);
      gruppen.get(g).push(s);
    }
    const lebtS = (s) => !s.ende && live.has(s.sk);
    const sortiert = [...gruppen.entries()].sort((x, y) =>
      y[1].filter(lebtS).length - x[1].filter(lebtS).length || (x[0] < y[0] ? -1 : 1));
    let gezeigt = 0;
    for (const [g, liste] of sortiert) {
      liste.sort((x, y) => (lebtS(y) - lebtS(x)) || (x.start < y.start ? 1 : -1));
      const nLive = liste.filter(lebtS).length;
      const raeumeG = new Set(liste.filter(lebtS).map((s) => s.raum)).size;
      L.push("  ── " + g + "   (" + nLive + " live in " + raeumeG + " Räumen, " + liste.length + " Sitzungen heute) " + "─".repeat(30));
      for (const s of liste) {
        if (gezeigt++ >= 300) break;
        L.push(zeile(s));
      }
    }
    if (spieler.length > 300) L.push("  … " + (spieler.length - 300) + " ältere ausgeblendet");

    L.push("");
    L.push("▶ ANDERE VERBINDUNGEN  (nur Raumliste angesehen / ohne Raum)   – " + andere.length);
    L.push(kopf);
    if (!andere.length) L.push("  keine");
    for (const s of andere.slice(0, 150)) L.push(zeile(s));
    if (andere.length > 150) L.push("  … " + (andere.length - 150) + " ältere ausgeblendet");

    L.push("");
    L.push("▶ ⚠ AUFFÄLLIG  (Grenzen verletzt, kaputte/präparierte Daten, Flut)   – " + this.auff.size + " IPs");
    if (!this.auff.size) L.push("  keine");
    for (const [ip, a] of this.auff) {
      L.push("  ⚠ " + sp(ip, 17) + sp(a.geo, 20) + "erstes: " + zeit(a.erst) + "  letztes: " + zeit(a.letzt) +
        "   Namen: " + ([...a.namen].join(", ") || KEINE) + "   Programm: " + (a.ua || KEINE));
      for (const [g, n] of Object.entries(a.gruende)) L.push("        – " + g + "  ×" + n);
    }

    L.push("");
    L.push("▶ ✖ ABGELEHNT  (gar nicht reingelassen)   – " + this.abgel.size + " IPs");
    if (!this.abgel.size) L.push("  keine");
    for (const [ip, a] of this.abgel) {
      L.push("  ✖ " + sp(ip, 17) + sp(a.geo, 20) + "×" + a.n + "   " + zeit(a.erst) + " – " + zeit(a.letzt) + "   " +
        Object.entries(a.gruende).map(([g, n]) => g + " ×" + n).join(", "));
    }

    L.push("");
    L.push("▶ ? FREMDE WEB-ANFRAGEN  (Scanner / Lücken-Suche, z. B. nach PHP)   – " + this.http.size + " IPs");
    if (!this.http.size) L.push("  keine");
    for (const [ip, h] of this.http) {
      L.push("  ? " + sp(ip, 17) + sp(h.geo, 20) + "×" + h.n + "   " + zeit(h.erst) + " – " + zeit(h.letzt) + "   Programm: " + (h.ua || KEINE));
      L.push("        " + h.anfragen.join("   |   "));
    }
    L.push("");
    return L.join("\n");
  }
}

module.exports = { Uebersicht, KEINE };
