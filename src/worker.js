// Serves the static site and a tiny visit counter for the admin page.
//
//   POST /Interactive/api/hit    – a page was opened          (sent by /Interactive/track.js)
//   POST /Interactive/api/leave  – time spent + interactions  (sent by /Interactive/track.js)
//   GET  /Interactive/api/stats  – numbers for /Interactive/Admin/ (needs the admin password)
//
// Visits are stored in one SQLite-backed Durable Object, so there is nothing to set up
// in the Cloudflare dashboard: `npx wrangler deploy` creates it.

import { DurableObject } from "cloudflare:workers";

// SHA-256 of the admin password. To change it, run:
//   echo -n "newpassword" | shasum -a 256
// and paste the hex here.
const ADMIN_PASSWORD_SHA256 = "5d9cf088e5139c926c5af1f4da663bf337f2fb7ce8602df7b32b28509fe3cb57";

const DAY = 86400000;
const TZ_OFFSET = 2 * 3600000; // days are counted in South African time (UTC+2, no DST)
const dayOf = ts => new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/Interactive/api/hit" && request.method === "POST") return hit(request, env);
    if (p === "/Interactive/api/leave" && request.method === "POST") return leave(request, env);
    if (p === "/Interactive/api/stats" && request.method === "GET") return stats(request, env, url);
    if (p.startsWith("/Interactive/api/")) return json({ error: "not found" }, 404);

    return env.ASSETS.fetch(request);
  },
};

const db = env => env.STATS.get(env.STATS.idFromName("global"));

async function body(request) {
  try {
    const text = await request.text();
    return text.length > 4000 ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

const ID_RE = /^[A-Za-z0-9-]{8,40}$/;
const knownProjects = new Map();

// "/Interactive/" -> "Home", "/Interactive/RowEchelon/" -> "RowEchelon", anything else -> null.
// Only folders that really exist on the site are counted, so junk paths can't add projects.
async function projectFor(path, request, env) {
  if (typeof path !== "string") return null;
  path = path.replace(/index\.html$/, "");
  if (!path.endsWith("/")) path += "/";
  if (path === "/Interactive/") return "Home";
  const m = /^\/Interactive\/([A-Za-z0-9_-]{1,60})\/$/.exec(path);
  if (!m || m[1] === "Admin" || m[1] === "api") return null;
  const name = m[1];
  if (!knownProjects.has(name)) {
    const res = await env.ASSETS.fetch(new URL(`/Interactive/${name}/`, request.url));
    knownProjects.set(name, res.ok);
  }
  return knownProjects.get(name) ? name : null;
}

function referrerHost(ref, selfHost) {
  try {
    const h = new URL(ref).hostname.replace(/^www\./, "");
    return !h || h === selfHost.replace(/^www\./, "") ? "" : h.slice(0, 100);
  } catch {
    return "";
  }
}

async function hit(request, env) {
  const b = await body(request);
  if (!b || !ID_RE.test(b.id) || !ID_RE.test(b.vid)) return json({ error: "bad request" }, 400);
  const project = await projectFor(b.path, request, env);
  if (!project) return json({ error: "unknown page" }, 400);
  const w = Number(b.w) || 0;
  await db(env).hit({
    id: b.id,
    ts: Date.now(),
    project,
    visitor: b.vid,
    referrer: referrerHost(b.ref, new URL(request.url).hostname),
    country: (request.cf && request.cf.country) || "",
    device: w && w < 640 ? "Phone" : w && w < 1024 ? "Tablet" : "Desktop",
  });
  return new Response(null, { status: 204 });
}

async function leave(request, env) {
  const b = await body(request);
  if (!b || !ID_RE.test(b.id)) return json({ error: "bad request" }, 400);
  const dur = Math.min(Math.max(Math.round(Number(b.dur) || 0), 0), 7200);
  const act = Math.min(Math.max(Math.round(Number(b.act) || 0), 0), 100000);
  await db(env).leave(b.id, dur, act);
  return new Response(null, { status: 204 });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function stats(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = await sha256Hex(given), b = ADMIN_PASSWORD_SHA256;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (diff) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return json({ error: "wrong password" }, 401);
  }
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days"), 10) || 0, 0), 3650);
  const project = url.searchParams.get("project") || "";
  return json(await db(env).stats(days, project));
}

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS views (
        id           TEXT PRIMARY KEY,
        ts           INTEGER NOT NULL,
        day          TEXT NOT NULL,
        project      TEXT NOT NULL,
        visitor      TEXT NOT NULL,
        referrer     TEXT NOT NULL DEFAULT '',
        country      TEXT NOT NULL DEFAULT '',
        device       TEXT NOT NULL DEFAULT '',
        duration     INTEGER NOT NULL DEFAULT 0,
        interactions INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS views_ts ON views (ts);
      CREATE INDEX IF NOT EXISTS views_project_ts ON views (project, ts);
    `);
  }

  hit(v) {
    this.sql.exec(
      `INSERT OR IGNORE INTO views (id, ts, day, project, visitor, referrer, country, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      v.id, v.ts, dayOf(v.ts), v.project, v.visitor, v.referrer, v.country, v.device
    );
  }

  // the page reports running totals, so keep the largest; ignore reports for old views
  leave(id, dur, act) {
    this.sql.exec(
      `UPDATE views SET duration = MAX(duration, ?), interactions = MAX(interactions, ?)
       WHERE id = ? AND ts > ?`,
      dur, act, id, Date.now() - 3 * 3600000
    );
  }

  stats(days, project) {
    const now = Date.now();
    const since = days ? now - days * DAY : 0;
    const q = (sql, ...args) => this.sql.exec(sql, ...args).toArray();
    // optional project filter, applied to everything except the per-project list
    const pf = project ? " AND project = ?" : "";
    const pa = project ? [project] : [];

    const totalsBetween = (from, to) =>
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors,
                COALESCE(AVG(NULLIF(duration, 0)), 0) AS avgDuration,
                COALESCE(AVG(interactions), 0) AS avgInteractions
         FROM views WHERE ts >= ? AND ts < ?${pf}`,
        from, to, ...pa
      )[0];

    const first = q(`SELECT MIN(ts) AS ts FROM views WHERE 1=1${pf}`, ...pa)[0].ts;

    return {
      now,
      days,
      project,
      firstDay: first ? dayOf(first) : null,
      today: dayOf(now),
      totals: totalsBetween(since, now + 1),
      previous: days ? totalsBetween(since - days * DAY, since) : null,
      activeNow: q(
        `SELECT COUNT(DISTINCT visitor) AS n FROM views WHERE ts >= ?${pf}`,
        now - 5 * 60000, ...pa
      )[0].n,
      daily: q(
        `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM views WHERE ts >= ?${pf} GROUP BY day ORDER BY day`,
        since, ...pa
      ),
      projects: q(
        `SELECT project, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors,
                COALESCE(AVG(NULLIF(duration, 0)), 0) AS avgDuration,
                COALESCE(AVG(interactions), 0) AS avgInteractions,
                MAX(ts) AS lastVisit
         FROM views WHERE ts >= ? GROUP BY project ORDER BY views DESC`,
        since
      ),
      projectDaily: q(
        `SELECT project, day, COUNT(*) AS views FROM views WHERE ts >= ?
         GROUP BY project, day ORDER BY day`,
        since
      ),
      allProjects: q(`SELECT DISTINCT project FROM views`).map(r => r.project),
      referrers: q(
        `SELECT referrer AS name, COUNT(*) AS views FROM views WHERE ts >= ?${pf}
         GROUP BY referrer ORDER BY views DESC LIMIT 8`,
        since, ...pa
      ),
      countries: q(
        `SELECT country AS name, COUNT(*) AS views FROM views WHERE ts >= ?${pf}
         GROUP BY country ORDER BY views DESC LIMIT 8`,
        since, ...pa
      ),
      devices: q(
        `SELECT device AS name, COUNT(*) AS views FROM views WHERE ts >= ?${pf}
         GROUP BY device ORDER BY views DESC`,
        since, ...pa
      ),
      hours: q(
        `SELECT CAST(((ts + ?) % ${DAY}) / 3600000 AS INTEGER) AS hour, COUNT(*) AS views
         FROM views WHERE ts >= ?${pf} GROUP BY hour ORDER BY hour`,
        TZ_OFFSET, since, ...pa
      ),
      recent: q(
        `SELECT ts, project, referrer, country, device, duration, interactions
         FROM views WHERE 1=1${pf} ORDER BY ts DESC LIMIT 25`,
        ...pa
      ),
    };
  }
}
