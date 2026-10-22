// Social Hub server: posts to Instagram on schedule.
// Runs on Cloudflare Workers. D1 holds accounts and jobs, KV holds uploaded photos/videos
// until Instagram has fetched them. A cron trigger runs tick() every minute.

const DEFAULT_GRAPH_VERSION = "v26.0";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // KV's per-value limit
const MAX_CAPTION = 2200, MAX_HASHTAGS = 30, MAX_MENTIONS = 20, MAX_ITEMS = 20;
const PROCESSING_TIMEOUT = 30 * 60 * 1000;
const MAX_TRANSIENT_ATTEMPTS = 5;
const REFRESH_WHEN_LEFT = 15 * 86400 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  ig_id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL,
  token_expires INTEGER NOT NULL, token_refreshed INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, ig_id TEXT NOT NULL, caption TEXT NOT NULL, alt_text TEXT,
  media TEXT NOT NULL, run_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, media_id TEXT, permalink TEXT,
  lease_until INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (state, run_at);
CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, return_to TEXT NOT NULL, expires INTEGER NOT NULL);
`;

let schemaReady;
function ensureSchema(env) {
  const stmts = SCHEMA.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  schemaReady ||= env.DB.batch(stmts.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---------- Small helpers ---------- */
const now = () => Date.now();
const randomId = (bytes = 16) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const graphBase = (env) => `${env.IG_GRAPH_URL || "https://graph.instagram.com"}/${env.GRAPH_VERSION || DEFAULT_GRAPH_VERSION}`;
const allowedOrigins = (env) => String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(env, req) {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function authorized(env, req) {
  const want = env.ADMIN_PASSCODE;
  if (!want) return false;
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [a, b] = await Promise.all([sha256(got), sha256(want)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function captionProblems(caption) {
  const out = [];
  if ([...caption].length > MAX_CAPTION) out.push(`Caption is longer than ${MAX_CAPTION} characters`);
  if ((caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length > MAX_HASHTAGS) out.push(`Instagram allows at most ${MAX_HASHTAGS} hashtags`);
  if ((caption.match(/(^|\s)@[\w.]+/g) || []).length > MAX_MENTIONS) out.push(`Instagram allows at most ${MAX_MENTIONS} @mentions`);
  return out;
}

/* ---------- Instagram Graph API ---------- */
class GraphError extends Error {
  constructor(message, { status = 0, code = 0, subcode = 0, transient = false } = {}) {
    super(message);
    Object.assign(this, { status, code, subcode, transient });
  }
}

async function graphCall(env, method, url, params) {
  let res;
  try {
    if (method === "GET") {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      res = await fetch(u, { method });
    } else {
      res = await fetch(url, { method, body: new URLSearchParams(params) });
    }
  } catch (e) {
    throw new GraphError(`Couldn't reach Instagram (${e.message})`, { transient: true });
  }
  let body = {};
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  const err = body.error;
  if (!res.ok || err) {
    const code = err?.code || 0;
    const msg = err?.error_user_msg || err?.message || body.error_message || `Instagram returned HTTP ${res.status}`;
    // 1/2: temporary, 4/17/32/613: rate limits that clear on their own
    const transient = res.status >= 500 || !!err?.is_transient || [1, 2, 4, 17, 32, 613].includes(code);
    throw new GraphError(msg, { status: res.status, code, subcode: err?.error_subcode || 0, transient });
  }
  return body;
}
const graph = (env, method, path, params, token) =>
  graphCall(env, method, `${graphBase(env)}/${path}`, { ...params, access_token: token });

/* ---------- Media ---------- */
const MEDIA_TYPES = { "image/jpeg": "jpg", "video/mp4": "mp4", "video/quicktime": "mov" };

async function uploadMedia(env, req, origin) {
  const type = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!MEDIA_TYPES[type]) return json({ error: "Upload a JPEG photo or an MP4/MOV video" }, 415);
  const len = +req.headers.get("Content-Length") || 0;
  if (len > MAX_MEDIA_BYTES) return json({ error: "File is larger than 25 MB" }, 413);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: "Empty file" }, 400);
  if (buf.byteLength > MAX_MEDIA_BYTES) return json({ error: "File is larger than 25 MB" }, 413);
  const id = randomId();
  // Orphans (posts deleted in the app while offline) expire on their own after 180 days
  await env.MEDIA.put(id, buf, { metadata: { type }, expirationTtl: 180 * 86400 });
  const kind = type.startsWith("video/") ? "video" : "image";
  return json({ id, type: kind, url: `${origin}/media/${id}.${MEDIA_TYPES[type]}` }, 201);
}

async function serveMedia(env, id, method) {
  const { value, metadata } = await env.MEDIA.getWithMetadata(id, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": metadata?.type || "application/octet-stream", "Content-Length": String(value.byteLength), "Cache-Control": "public, max-age=3600" };
  return new Response(method === "HEAD" ? null : value, { headers });
}

// Delete uploads once no unfinished job still needs them
async function releaseMedia(env, mediaJson) {
  let items = [];
  try { items = JSON.parse(mediaJson); } catch (e) { return; }
  for (const m of items) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('scheduled','working') AND media LIKE ?")
      .bind(`%${m.id}%`).first();
    if (!n) await env.MEDIA.delete(m.id);
  }
}

/* ---------- Accounts and login ---------- */
async function startConnect(env, req) {
  if (!env.IG_APP_ID || !env.IG_APP_SECRET) return json({ error: "IG_APP_ID and IG_APP_SECRET aren't set on the server yet" }, 500);
  const { returnTo } = await req.json().catch(() => ({}));
  let ret;
  try { ret = new URL(returnTo); } catch (e) { return json({ error: "Missing returnTo" }, 400); }
  if (!allowedOrigins(env).includes(ret.origin)) return json({ error: "returnTo must be on ALLOWED_ORIGIN" }, 400);
  const state = randomId();
  await env.DB.prepare("INSERT INTO oauth_states (state, return_to, expires) VALUES (?, ?, ?)").bind(state, ret.href, now() + 15 * 60000).run();
  const u = new URL(env.IG_AUTH_URL || "https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", env.IG_APP_ID);
  u.searchParams.set("redirect_uri", `${new URL(req.url).origin}/auth/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish");
  u.searchParams.set("state", state);
  return json({ url: u.href });
}

async function finishConnect(env, req) {
  const q = new URL(req.url).searchParams;
  const row = await env.DB.prepare("SELECT return_to, expires FROM oauth_states WHERE state = ?").bind(q.get("state") || "").first();
  if (!row || row.expires < now()) return new Response("This sign-in link has expired. Go back to Social Hub and press Connect again.", { status: 400 });
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(q.get("state")).run();
  const back = (frag) => Response.redirect(`${row.return_to.split("#")[0]}#${frag}`, 302);

  if (q.get("error")) return back(`ig-error=${encodeURIComponent(q.get("error_description") || "Instagram sign-in was cancelled")}`);
  const code = (q.get("code") || "").replace(/#_$/, "");
  if (!code) return back("ig-error=" + encodeURIComponent("Instagram didn't send a sign-in code"));
  try {
    const short = await graphCall(env, "POST", `${env.IG_API_URL || "https://api.instagram.com"}/oauth/access_token`, {
      client_id: env.IG_APP_ID, client_secret: env.IG_APP_SECRET, grant_type: "authorization_code",
      redirect_uri: `${new URL(req.url).origin}/auth/callback`, code,
    });
    const s = short.data?.[0] || short;
    const long = await graphCall(env, "GET", `${env.IG_GRAPH_URL || "https://graph.instagram.com"}/access_token`, {
      grant_type: "ig_exchange_token", client_secret: env.IG_APP_SECRET, access_token: s.access_token,
    });
    const me = await graph(env, "GET", "me", { fields: "user_id,username" }, long.access_token);
    const igId = String(me.user_id || s.user_id);
    const t = now();
    await env.DB.prepare(`INSERT INTO accounts (ig_id, username, token, token_expires, token_refreshed, created) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT (ig_id) DO UPDATE SET username = ?2, token = ?3, token_expires = ?4, token_refreshed = ?5`)
      .bind(igId, me.username, long.access_token, t + (long.expires_in || 5184000) * 1000, t).run();
    return back(`ig-connected=${encodeURIComponent(me.username)}&ig-id=${encodeURIComponent(igId)}`);
  } catch (e) {
    return back(`ig-error=${encodeURIComponent(e.message)}`);
  }
}

async function refreshTokens(env) {
  const t = now();
  const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE token_expires < ? AND token_expires > ? AND token_refreshed < ?")
    .bind(t + REFRESH_WHEN_LEFT, t, t - 86400000).all();
  for (const a of results) {
    try {
      const r = await graphCall(env, "GET", `${env.IG_GRAPH_URL || "https://graph.instagram.com"}/refresh_access_token`, { grant_type: "ig_refresh_token", access_token: a.token });
      await env.DB.prepare("UPDATE accounts SET token = ?, token_expires = ?, token_refreshed = ? WHERE ig_id = ?")
        .bind(r.access_token, t + (r.expires_in || 5184000) * 1000, t, a.ig_id).run();
    } catch (e) {
      console.log(`token refresh failed for ${a.username}: ${e.message}`);
    }
  }
}

/* ---------- Jobs ---------- */
const publicJob = (j) => ({
  id: j.id, igId: j.ig_id, state: j.state, runAt: j.run_at, error: j.error || null,
  permalink: j.permalink || null, mediaId: j.media_id || null, updated: j.updated,
});

function parseJobInput(body, partial, origin) {
  const out = {};
  if (!partial || body.caption !== undefined) {
    if (typeof body.caption !== "string") throw new Error("caption must be text");
    const p = captionProblems(body.caption);
    if (p.length) throw new Error(p.join(". "));
    out.caption = body.caption;
  }
  if (!partial || body.media !== undefined) {
    const m = body.media;
    if (!Array.isArray(m) || !m.length) throw new Error("Instagram posts need at least one photo or video");
    if (m.length > MAX_ITEMS) throw new Error(`A carousel can have at most ${MAX_ITEMS} items`);
    for (const it of m) {
      // Only publish files uploaded to this server
      if (!/^[0-9a-f]{32}$/.test(it?.id || "") || !["image", "video"].includes(it.type) || !String(it.url).startsWith(`${origin}/media/${it.id}.`))
        throw new Error("Invalid media item");
    }
    out.media = JSON.stringify(m.map(({ id, type, url }) => ({ id, type, url })));
  }
  if (!partial || body.runAt !== undefined) {
    const r = Number(body.runAt);
    if (!Number.isFinite(r) || r <= 0) throw new Error("runAt must be a timestamp");
    out.run_at = Math.round(r);
  }
  if (body.altText !== undefined) out.alt_text = String(body.altText || "").slice(0, 1000) || null;
  return out;
}

async function getJob(env, id) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
}

async function api(env, req, path, origin) {
  const m = req.method;
  if (path === "/api/status" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT ig_id, username, token_expires FROM accounts ORDER BY created").all();
    return json({
      ok: true, appConfigured: !!(env.IG_APP_ID && env.IG_APP_SECRET), redirectUri: `${origin}/auth/callback`,
      accounts: results.map((a) => ({ igId: a.ig_id, username: a.username, tokenExpires: a.token_expires })),
    });
  }
  if (path === "/api/connect" && m === "POST") return startConnect(env, req);
  if (path === "/api/media" && m === "POST") return uploadMedia(env, req, origin);

  let mm;
  if ((mm = path.match(/^\/api\/accounts\/([^/]+)$/)) && m === "DELETE") {
    const igId = decodeURIComponent(mm[1]);
    const { results } = await env.DB.prepare("SELECT * FROM jobs WHERE ig_id = ? AND state = 'scheduled'").bind(igId).all();
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET state = 'canceled', updated = ? WHERE ig_id = ? AND state = 'scheduled'").bind(now(), igId),
      env.DB.prepare("DELETE FROM accounts WHERE ig_id = ?").bind(igId),
    ]);
    for (const j of results) await releaseMedia(env, j.media);
    return json({ ok: true, canceled: results.length });
  }

  if (path === "/api/jobs" && m === "GET") {
    const ids = (new URL(req.url).searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
    if (!ids.length) return json({ jobs: [] });
    const { results } = await env.DB.prepare(`SELECT * FROM jobs WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    return json({ jobs: results.map(publicJob) });
  }
  if (path === "/api/jobs" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    let input;
    try { input = parseJobInput(body, false, origin); } catch (e) { return json({ error: e.message }, 400); }
    const acct = await env.DB.prepare("SELECT ig_id FROM accounts WHERE ig_id = ?").bind(String(body.igId || "")).first();
    if (!acct) return json({ error: "That Instagram account isn't connected to the server" }, 400);
    const t = now(), id = randomId();
    await env.DB.prepare(`INSERT INTO jobs (id, ig_id, caption, alt_text, media, run_at, state, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
      .bind(id, acct.ig_id, input.caption, input.alt_text ?? null, input.media, input.run_at, t, t).run();
    return json({ job: publicJob(await getJob(env, id)) }, 201);
  }

  if ((mm = path.match(/^\/api\/jobs\/([0-9a-f]{32})(\/retry)?$/))) {
    const job = await getJob(env, mm[1]);
    if (!job) return json({ error: "Job not found" }, 404);
    if (mm[2] && m === "POST") {
      if (job.state !== "failed") return json({ error: "Only failed posts can be retried" }, 409);
      await env.DB.prepare("UPDATE jobs SET state = 'scheduled', run_at = ?, data = '{}', attempts = 0, error = NULL, lease_until = NULL, updated = ? WHERE id = ?")
        .bind(now(), now(), job.id).run();
      return json({ job: publicJob(await getJob(env, job.id)) });
    }
    if (mm[2]) return json({ error: "Not found" }, 404);
    if (m === "PATCH") {
      if (job.state !== "scheduled") return json({ error: job.state === "published" ? "This post is already on Instagram" : "Instagram is already working on this post" }, 409);
      let input;
      try { input = parseJobInput(await req.json().catch(() => ({})), true, origin); } catch (e) { return json({ error: e.message }, 400); }
      const keys = Object.keys(input);
      if (keys.length) {
        // Only update while still scheduled so an edit can't race the cron picking it up
        const r = await env.DB.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE id = ? AND state = 'scheduled'`)
          .bind(...keys.map((k) => input[k]), now(), job.id).run();
        if (!r.meta.changes) return json({ error: "Instagram is already working on this post" }, 409);
        if (input.media) await releaseMedia(env, job.media);
      }
      return json({ job: publicJob(await getJob(env, job.id)) });
    }
    if (m === "DELETE") {
      if (job.state === "working") return json({ error: "Instagram is already working on this post" }, 409);
      if (job.state === "scheduled") {
        const r = await env.DB.prepare("UPDATE jobs SET state = 'canceled', updated = ? WHERE id = ? AND state = 'scheduled'").bind(now(), job.id).run();
        if (!r.meta.changes) return json({ error: "Instagram is already working on this post" }, 409);
      } else {
        await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
      }
      await releaseMedia(env, job.media);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

/* ---------- Publishing (runs from the cron) ---------- */
async function saveJob(env, job, fields) {
  Object.assign(job, fields, { updated: now() });
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), job.updated, job.id).run();
}
const saveData = (env, job, data) => saveJob(env, job, { data: JSON.stringify(data) });

async function fail(env, job, message) {
  await saveJob(env, job, { state: "failed", error: message, lease_until: null });
  console.log(`job ${job.id} failed: ${message}`);
}

async function containerStatus(env, id, token) {
  const r = await graph(env, "GET", id, { fields: "status_code,status" }, token);
  return { code: r.status_code, detail: r.status };
}

// Moves one job forward as far as it can go right now. Every Instagram call is saved
// before the next one so a crash or timeout picks up where it left off.
async function advance(env, job) {
  const acct = await env.DB.prepare("SELECT * FROM accounts WHERE ig_id = ?").bind(job.ig_id).first();
  if (!acct) return fail(env, job, "This Instagram account was disconnected. Reconnect it in Social Hub settings, then retry.");
  if (acct.token_expires < now()) return fail(env, job, "Instagram sign-in expired. Reconnect the account in Social Hub settings, then retry.");
  const token = acct.token;
  const media = JSON.parse(job.media);
  const data = JSON.parse(job.data || "{}");

  if (job.state === "scheduled") {
    data.startedAt = now();
    await saveJob(env, job, { state: "working", data: JSON.stringify(data) });
  }
  if (now() - data.startedAt > PROCESSING_TIMEOUT) return fail(env, job, "Instagram took too long to process the media. Try again, or use a smaller video.");

  // A previous run may have died mid-publish: check before publishing twice
  if (data.publishing && data.parent) {
    const st = await containerStatus(env, data.parent, token);
    if (st.code === "PUBLISHED") return finish(env, job, data, null, token);
  }

  const single = media.length === 1;
  if (!single) {
    data.children ||= [];
    for (let i = data.children.length; i < media.length; i++) {
      const it = media[i];
      const params = it.type === "video"
        ? { media_type: "VIDEO", video_url: it.url, is_carousel_item: "true" }
        : { image_url: it.url, is_carousel_item: "true" };
      const r = await graph(env, "POST", `${job.ig_id}/media`, params, token);
      data.children.push(r.id);
      await saveData(env, job, data);
    }
    if (!data.childrenReady) {
      for (const c of data.children) {
        const st = await containerStatus(env, c, token);
        if (st.code === "ERROR" || st.code === "EXPIRED") return fail(env, job, `Instagram couldn't process one of the carousel items${st.detail ? ` (${st.detail})` : ""}.`);
        if (st.code !== "FINISHED") return; // still processing; check again next minute
      }
      data.childrenReady = true;
      await saveData(env, job, data);
    }
  }

  if (!data.parent) {
    let params;
    if (!single) params = { media_type: "CAROUSEL", children: data.children.join(","), caption: job.caption };
    else if (media[0].type === "video") params = { media_type: "REELS", video_url: media[0].url, caption: job.caption, share_to_feed: "true" };
    else params = { image_url: media[0].url, caption: job.caption, ...(job.alt_text ? { alt_text: job.alt_text } : {}) };
    const r = await graph(env, "POST", `${job.ig_id}/media`, params, token);
    data.parent = r.id;
    await saveData(env, job, data);
  }

  const st = await containerStatus(env, data.parent, token);
  if (st.code === "ERROR" || st.code === "EXPIRED") return fail(env, job, `Instagram couldn't process this post${st.detail ? ` (${st.detail})` : ""}.`);
  if (st.code === "PUBLISHED") return finish(env, job, data, null, token);
  if (st.code !== "FINISHED") return;

  data.publishing = true;
  await saveData(env, job, data);
  const pub = await graph(env, "POST", `${job.ig_id}/media_publish`, { creation_id: data.parent }, token);
  return finish(env, job, data, pub.id, token);
}

async function finish(env, job, data, mediaId, token) {
  let permalink = null;
  if (mediaId) {
    try { permalink = (await graph(env, "GET", mediaId, { fields: "permalink" }, token)).permalink || null; }
    catch (e) { /* the post is up; the link is a nice-to-have */ }
  }
  await saveJob(env, job, { state: "published", media_id: mediaId, permalink, error: null, lease_until: null, data: JSON.stringify(data) });
  await releaseMedia(env, job.media);
}

export async function tick(env) {
  await ensureSchema(env);
  const t = now();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires < ?").bind(t).run();
  await refreshTokens(env);

  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE ((state = 'scheduled' AND run_at <= ?) OR state = 'working') AND (lease_until IS NULL OR lease_until < ?) ORDER BY run_at LIMIT 10"
  ).bind(t, t).all();

  for (const job of results) {
    // Claim the job so an overlapping run can't work on it at the same time
    const claim = await env.DB.prepare("UPDATE jobs SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?) AND state IN ('scheduled','working')")
      .bind(now() + 55000, job.id, now()).run();
    if (!claim.meta.changes) continue;
    try {
      await advance(env, job);
    } catch (e) {
      if (e instanceof GraphError && e.transient && job.attempts + 1 < MAX_TRANSIENT_ATTEMPTS) {
        await saveJob(env, job, { attempts: job.attempts + 1, error: `Retrying: ${e.message}` });
      } else if (e instanceof GraphError && e.code === 9 && e.subcode === 2207042) {
        await fail(env, job, "Instagram's daily posting limit for this account has been reached. Retry later.");
      } else {
        await fail(env, job, e.message || "Something went wrong");
      }
    } finally {
      if (job.state === "scheduled" || job.state === "working") await saveJob(env, job, { lease_until: null });
    }
  }
}

/* ---------- Entry points ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const headers = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    try {
      await ensureSchema(env);
      let mm;
      if ((mm = path.match(/^\/media\/([0-9a-f]{32})(\.\w+)?$/)) && (req.method === "GET" || req.method === "HEAD")) return serveMedia(env, mm[1], req.method);
      if (path === "/auth/callback") return finishConnect(env, req);
      if (path === "/") return new Response("Social Hub server is running.", { headers: { "Content-Type": "text/plain" } });
      if (path.startsWith("/api/")) {
        if (!(await authorized(env, req))) return json({ error: env.ADMIN_PASSCODE ? "Wrong passcode" : "ADMIN_PASSCODE isn't set on the server yet" }, 401, headers);
        const res = await api(env, req, path, url.origin);
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
        return res;
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.log(e.stack || e.message);
      return json({ error: "Server error: " + e.message }, 500, headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
