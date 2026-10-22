// End-to-end test: runs the worker locally with `wrangler dev` against a fake Instagram API.
// Usage: npm test
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const WORKER = "http://127.0.0.1:8799";
const MOCK_PORT = 8798;
const PASS = "test-passcode-123";
const ORIGIN = "https://linkplayt.github.io";

/* ---------- Fake Instagram ---------- */
const calls = [];
const containers = {}; // id -> { params, polls, status }
let nextId = 1000;
let flakyOnce = true;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);
  let body = "";
  for await (const c of req) body += c;
  const p = Object.fromEntries(req.method === "POST" ? new URLSearchParams(body) : url.searchParams);
  calls.push({ method: req.method, path: url.pathname, p });
  const path = url.pathname.replace(/^\/v26\.0/, "");

  if (path === "/oauth/access_token") return send(res, 200, { data: [{ access_token: "short-tok", user_id: "1789", permissions: "instagram_business_basic,instagram_business_content_publish" }] });
  if (path === "/access_token") return send(res, 200, { access_token: "long-tok", token_type: "bearer", expires_in: 5184000 });
  if (path === "/me") return p.access_token === "long-tok" ? send(res, 200, { user_id: "1789", username: "testshop", id: "app-scoped" }) : send(res, 400, { error: { message: "bad token", code: 190 } });

  const mm = path.match(/^\/1789\/(media|media_publish)$/);
  if (mm && req.method === "POST") {
    if (p.access_token !== "long-tok") return send(res, 400, { error: { message: "bad token", code: 190 } });
    if (mm[1] === "media") {
      if (p.caption?.includes("FAILME")) return send(res, 400, { error: { message: "Invalid parameter", error_user_msg: "The image is not a supported format", code: 100 } });
      if (p.caption?.includes("FLAKY") && flakyOnce) { flakyOnce = false; return send(res, 500, { error: { message: "Temporary error", code: 2, is_transient: true } }); }
      // Instagram downloads the media from our server
      const src = p.image_url || p.video_url;
      if (src) {
        const r = await fetch(src);
        if (!r.ok) return send(res, 400, { error: { message: `Media download failed ${r.status}`, code: 9004 } });
        await r.arrayBuffer();
      }
      if (p.children) for (const c of p.children.split(",")) assert.equal(containers[c]?.status, "FINISHED", "carousel built before children finished");
      const id = String(nextId++);
      containers[id] = { params: p, polls: 0, status: p.video_url ? "IN_PROGRESS" : "FINISHED" };
      return send(res, 200, { id });
    }
    const c = containers[p.creation_id];
    if (!c || c.status !== "FINISHED") return send(res, 400, { error: { message: "Media not ready", code: 9007 } });
    c.status = "PUBLISHED";
    const id = String(nextId++);
    containers[id] = { media: true };
    return send(res, 200, { id });
  }
  const cm = path.match(/^\/(\d+)$/);
  if (cm && req.method === "GET") {
    const c = containers[cm[1]];
    if (!c) return send(res, 404, { error: { message: "not found", code: 100 } });
    if (c.media) return send(res, 200, { permalink: `https://www.instagram.com/p/${cm[1]}/` });
    // Videos finish on the second status check
    if (c.status === "IN_PROGRESS" && ++c.polls >= 2) c.status = "FINISHED";
    return send(res, 200, { status_code: c.status, id: cm[1] });
  }
  send(res, 404, { error: { message: `mock: no route ${req.method} ${path}`, code: 1 } });
});

/* ---------- Helpers ---------- */
const auth = { Authorization: `Bearer ${PASS}` };
async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...auth, Origin: ORIGIN, ...headers } };
  if (body instanceof Uint8Array) init.body = body;
  else if (body) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const r = await fetch(WORKER + path, init);
  const j = await r.json().catch(() => null);
  return { status: r.status, j, headers: r.headers };
}
const tick = async () => { const r = await fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`); assert.equal(r.status, 200); await new Promise((r) => setTimeout(r, 300)); };
const job = async (id) => (await api("GET", `/api/jobs?ids=${id}`)).j.jobs[0];
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(500).fill(7), 0xff, 0xd9]);
const mp4 = new Uint8Array(2000).fill(3);
async function upload(bytes, type) {
  const r = await api("POST", "/api/media", bytes, { "Content-Type": type });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  return r.j;
}

let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log("  ✓", name); }

/* ---------- Run ---------- */
try { await fetch(WORKER + "/"); console.error(`Port 8799 is already in use (an old wrangler dev?). Stop it and try again.`); process.exit(1); } catch (e) { /* free */ }
const persist = mkdtempSync(join(tmpdir(), "shs-"));
await new Promise((r) => mock.listen(MOCK_PORT, r));
const vars = {
  IG_GRAPH_URL: `http://127.0.0.1:${MOCK_PORT}`, IG_API_URL: `http://127.0.0.1:${MOCK_PORT}`, IG_AUTH_URL: `http://127.0.0.1:${MOCK_PORT}/oauth/authorize`,
  IG_APP_ID: "app123", IG_APP_SECRET: "secret456", ADMIN_PASSCODE: PASS, ALLOWED_ORIGIN: ORIGIN,
};
// Values in wrangler.toml beat --var, so pass test settings as an env file
const envFile = join(mkdtempSync(join(tmpdir(), "shs-env-")), "test.env");
writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n"));
const wr = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", "--test-scheduled", "--persist-to", persist,
  "--env-file", envFile], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
let log = "";
wr.stdout.on("data", (d) => (log += d)); wr.stderr.on("data", (d) => (log += d));

let failed = false;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(WORKER + "/")).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  await step("health and auth", async () => {
    assert.equal((await fetch(WORKER + "/")).status, 200);
    assert.equal((await api("GET", "/api/status", null, { Authorization: "Bearer nope" })).status, 401);
    const s = await api("GET", "/api/status");
    assert.equal(s.status, 200);
    assert.equal(s.headers.get("access-control-allow-origin"), ORIGIN);
    assert.deepEqual(s.j.accounts, []);
    assert.equal(s.j.appConfigured, true);
    const pre = await fetch(WORKER + "/api/status", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
  });

  await step("connect Instagram account", async () => {
    assert.equal((await api("POST", "/api/connect", { returnTo: "https://evil.example/x" })).status, 400);
    const c = await api("POST", "/api/connect", { returnTo: `${ORIGIN}/ByteLife/social/` });
    const u = new URL(c.j.url);
    assert.equal(u.searchParams.get("client_id"), "app123");
    assert.match(u.searchParams.get("scope"), /instagram_business_content_publish/);
    const cb = await fetch(`${WORKER}/auth/callback?code=abc&state=${u.searchParams.get("state")}`, { redirect: "manual" });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location"), /^https:\/\/linkplayt\.github\.io\/ByteLife\/social\/#ig-connected=testshop&ig-id=1789$/);
    const again = await fetch(`${WORKER}/auth/callback?code=abc&state=${u.searchParams.get("state")}`, { redirect: "manual" });
    assert.equal(again.status, 400, "state is single use");
    const s = await api("GET", "/api/status");
    assert.equal(s.j.accounts[0].username, "testshop");
    assert.ok(!JSON.stringify(s.j).includes("long-tok"), "token never leaves the server");
  });

  await step("media upload and public serving", async () => {
    assert.equal((await api("POST", "/api/media", new Uint8Array([1]), { "Content-Type": "text/plain" })).status, 415);
    const m = await upload(jpeg, "image/jpeg");
    const r = await fetch(m.url.replace(/^https?:\/\/[^/]+/, WORKER));
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), jpeg);
  });

  await step("rejects bad captions", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const r = await api("POST", "/api/jobs", { igId: "1789", caption: tags, media: [m], runAt: Date.now() });
    assert.equal(r.status, 400);
    assert.match(r.j.error, /30 hashtags/);
    assert.equal((await api("POST", "/api/jobs", { igId: "1789", caption: "x", media: [], runAt: Date.now() })).status, 400);
    assert.equal((await api("POST", "/api/jobs", { igId: "nope", caption: "x", media: [m], runAt: Date.now() })).status, 400);
  });

  await step("publishes a single photo when due", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "Hello world #test", altText: "A cat", media: [m], runAt: Date.now() - 1000 });
    assert.equal(j.job.state, "scheduled");
    await tick();
    const done = await job(j.job.id);
    assert.equal(done.state, "published", JSON.stringify(done));
    assert.match(done.permalink, /instagram\.com\/p\//);
    const create = calls.find((c) => c.path.endsWith("/1789/media") && c.p.caption === "Hello world #test");
    assert.equal(create.p.alt_text, "A cat");
    assert.equal((await fetch(m.url.replace(/^https?:\/\/[^/]+/, WORKER))).status, 404, "media deleted after publishing");
  });

  await step("carousel with a video waits for processing", async () => {
    const a = await upload(jpeg, "image/jpeg"), b = await upload(mp4, "video/mp4");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "Carousel!", media: [a, b], runAt: Date.now() - 1000 });
    await tick();
    assert.equal((await job(j.job.id)).state, "working");
    for (let i = 0; i < 4 && (await job(j.job.id)).state === "working"; i++) await tick();
    const done = await job(j.job.id);
    assert.equal(done.state, "published", JSON.stringify(done));
    const parent = calls.find((c) => c.p.media_type === "CAROUSEL");
    assert.equal(parent.p.children.split(",").length, 2);
    assert.equal(parent.p.caption, "Carousel!");
    assert.ok(calls.some((c) => c.p.media_type === "VIDEO" && c.p.is_carousel_item === "true"));
  });

  await step("single video posts as a Reel", async () => {
    const v = await upload(mp4, "video/quicktime");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "Reel time", media: [v], runAt: Date.now() - 1000 });
    for (let i = 0; i < 4 && (await job(j.job.id)).state !== "published"; i++) await tick();
    assert.equal((await job(j.job.id)).state, "published");
    assert.ok(calls.some((c) => c.p.media_type === "REELS" && c.p.caption === "Reel time" && c.p.share_to_feed === "true"));
  });

  await step("future posts wait; edit and cancel", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "Later", media: [m], runAt: Date.now() + 3600e3 });
    await tick();
    assert.equal((await job(j.job.id)).state, "scheduled");
    const p = await api("PATCH", `/api/jobs/${j.job.id}`, { caption: "Later, edited", runAt: Date.now() + 7200e3 });
    assert.equal(p.status, 200);
    assert.equal((await api("DELETE", `/api/jobs/${j.job.id}`)).status, 200);
    assert.equal((await job(j.job.id)).state, "canceled");
    assert.equal((await fetch(m.url.replace(/^https?:\/\/[^/]+/, WORKER))).status, 404, "media deleted after cancel");
  });

  await step("shared media survives until every job using it is done", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const now = await api("POST", "/api/jobs", { igId: "1789", caption: "First", media: [m], runAt: Date.now() - 1000 });
    const later = await api("POST", "/api/jobs", { igId: "1789", caption: "Second", media: [m], runAt: Date.now() + 3600e3 });
    await tick();
    assert.equal((await job(now.j.job.id)).state, "published");
    assert.equal((await fetch(m.url.replace(/^https?:\/\/[^/]+/, WORKER))).status, 200);
    await api("DELETE", `/api/jobs/${later.j.job.id}`);
  });

  await step("permanent errors fail with Instagram's message; retry works", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "FAILME", media: [m], runAt: Date.now() - 1000 });
    await tick();
    const f = await job(j.job.id);
    assert.equal(f.state, "failed");
    assert.match(f.error, /not a supported format/);
    assert.equal((await api("PATCH", `/api/jobs/${j.job.id}`, { caption: "x" })).status, 409);
    const r = await api("POST", `/api/jobs/${j.job.id}/retry`);
    assert.equal(r.j.job.state, "scheduled");
    await api("DELETE", `/api/jobs/${j.job.id}`);
  });

  await step("temporary errors are retried automatically", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "FLAKY", media: [m], runAt: Date.now() - 1000 });
    await tick();
    const mid = await job(j.job.id);
    assert.notEqual(mid.state, "failed", JSON.stringify(mid));
    assert.match(mid.error, /Retrying/);
    await tick();
    assert.equal((await job(j.job.id)).state, "published");
  });

  await step("disconnecting cancels scheduled posts", async () => {
    const m = await upload(jpeg, "image/jpeg");
    const { j } = await api("POST", "/api/jobs", { igId: "1789", caption: "Never", media: [m], runAt: Date.now() + 3600e3 });
    const d = await api("DELETE", "/api/accounts/1789");
    assert.equal(d.j.canceled, 1);
    assert.equal((await job(j.job.id)).state, "canceled");
    assert.deepEqual((await api("GET", "/api/status")).j.accounts, []);
  });
} catch (e) {
  failed = true;
  console.error("\n✗", e.message, "\n");
  console.error(log.split("\n").slice(-40).join("\n"));
} finally {
  try { process.kill(-wr.pid, "SIGTERM"); } catch (e) { /* already gone */ }
  mock.close();
  rmSync(persist, { recursive: true, force: true });
}
console.log(failed ? `\nFAILED after ${passed} passing steps` : `\nAll ${passed} steps passed`);
process.exit(failed ? 1 : 0);
