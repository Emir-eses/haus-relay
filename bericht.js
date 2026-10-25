// Relay-Protokoll ansehen:
//   node bericht.js              heutige Übersicht (Spieler / andere / auffällig / abgelehnt / Web-Anfragen)
//   node bericht.js live         wie oben, aktualisiert sich alle 3 Sekunden (beenden mit Strg+C)
//   node bericht.js 2026-10-24   Übersicht eines bestimmten Tages (letzte 7 Tage)
//   node bericht.js alle         alle vorhandenen Tage nacheinander
"use strict";
const fs = require("fs");
const path = require("path");
const { Uebersicht } = require("./uebersicht");

const LOG_DIR = process.env.LOG_DIR || "/var/log/relay";
const heute = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
const arg = process.argv[2] || "";

function tage() {
  try {
    return fs.readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch (e) {
    return [];
  }
}

// Vom Server live geschriebene Übersicht (enthält auch laufende Sitzungen mit Dauer/Datenmenge)
function liveDatei(tag) {
  try {
    return fs.readFileSync(path.join(LOG_DIR, "uebersicht-" + tag + ".txt"), "utf8");
  } catch (e) {
    return null;
  }
}

// Aus dem Ereignis-Protokoll neu aufbauen
function ausProtokoll(tag) {
  const u = new Uebersicht("bericht");
  try {
    for (const z of fs.readFileSync(path.join(LOG_DIR, tag + ".log"), "utf8").split("\n")) {
      if (!z) continue;
      try {
        u.ereignis(JSON.parse(z));
      } catch (e) {}
    }
  } catch (e) {
    return "Kein Protokoll für " + tag + " in " + LOG_DIR;
  }
  return u.text({ titel: tag });
}

function zeige(tag) {
  return (tag === heute() && liveDatei(tag)) || ausProtokoll(tag);
}

if (arg === "live") {
  const zeichnen = () => {
    process.stdout.write("\x1b[2J\x1b[H" + zeige(heute()) + "\n(aktualisiert alle 3 s – beenden mit Strg+C)\n");
  };
  zeichnen();
  setInterval(zeichnen, 3000);
} else if (arg === "alle") {
  const t = tage();
  if (!t.length) console.log("Kein Protokoll in " + LOG_DIR);
  for (const tag of t) console.log(zeige(tag));
} else {
  console.log(zeige(arg || heute()));
}
