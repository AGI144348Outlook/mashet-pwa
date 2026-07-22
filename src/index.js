// mashet-dev Worker
// Serves the PWA (from KV, so the AI can rewrite its own frontend) and
// exposes the API the in-app AI uses to chat, propose changes, and commit
// those changes to GitHub. Every write endpoint requires DEPLOY_SECRET.

const DEFAULT_INDEX_KEY = "public/index.html";
const DEFAULT_MANIFEST_KEY = "public/manifest.json";
const DEFAULT_SW_KEY = "public/sw.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return await serveFromKV(env, DEFAULT_INDEX_KEY, "text/html;charset=UTF-8", FALLBACK_HTML);
      }
      if (url.pathname === "/manifest.json") {
        return await serveFromKV(env, DEFAULT_MANIFEST_KEY, "application/manifest+json", FALLBACK_MANIFEST);
      }
      if (url.pathname === "/sw.js") {
        return await serveFromKV(env, DEFAULT_SW_KEY, "application/javascript", FALLBACK_SW);
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        return await handleHistory(env);
      }
      if (url.pathname === "/api/files" && request.method === "GET") {
        return await requireAuth(request, env, () => handleListFiles(env));
      }
      if (url.pathname === "/api/files" && request.method === "POST") {
        return await requireAuth(request, env, () => handleWriteFile(request, env));
      }
      if (url.pathname === "/api/commit" && request.method === "POST") {
        return await requireAuth(request, env, () => handleCommitToGitHub(request, env));
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

// ── Auth guard for write endpoints ──────────────────────────────────────
async function requireAuth(request, env, handler) {
  const provided = request.headers.get("x-deploy-secret");
  if (!env.DEPLOY_SECRET || provided !== env.DEPLOY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return handler();
}

// ── Serve static PWA assets from KV, falling back to embedded defaults ──
async function serveFromKV(env, key, contentType, fallback) {
  const stored = await env.SOURCE_KV.get(key);
  return new Response(stored ?? fallback, {
    headers: { "Content-Type": contentType },
  });
}

// ── Chat: talk to the dev-AI via OpenRouter, log to D1 ──────────────────
async function handleChat(request, env) {
  const { message } = await request.json();
  if (!message) {
    return new Response(JSON.stringify({ error: "message required" }), { status: 400 });
  }

  await logMessage(env, "user", message);

  const history = await env.DB
    .prepare("SELECT role, content FROM dev_messages ORDER BY created_at DESC LIMIT 20")
    .all();
  const messages = [
    {
      role: "system",
      content:
        "You are the in-app development assistant for the Mashet PWA. You help Timothy " +
        "extend and fix this app's own source code. When proposing a file change, respond " +
        "with a clear explanation plus a fenced code block labeled with the file path, " +
        "e.g. ```file:public/index.html ... ```. Never invent API keys or secrets.",
    },
    ...history.results.reverse().map((m) => ({ role: m.role, content: m.content })),
  ];

  const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages,
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return new Response(JSON.stringify({ error: "AI call failed", detail: errText }), { status: 502 });
  }

  const data = await aiRes.json();
  const reply = data.choices?.[0]?.message?.content ?? "(no response)";
  await logMessage(env, "assistant", reply);

  return new Response(JSON.stringify({ reply }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function logMessage(env, role, content) {
  await env.DB
    .prepare("INSERT INTO dev_messages (id, role, content) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), role, content)
    .run();
}

async function handleHistory(env) {
  const rows = await env.DB
    .prepare("SELECT role, content, created_at FROM dev_messages ORDER BY created_at ASC LIMIT 200")
    .all();
  return new Response(JSON.stringify(rows.results), {
    headers: { "Content-Type": "application/json" },
  });
}

// ── File management (KV is the live "filesystem" the running app reads) ─
async function handleListFiles(env) {
  const list = await env.SOURCE_KV.list();
  return new Response(JSON.stringify(list.keys.map((k) => k.name)), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleWriteFile(request, env) {
  const { path, content } = await request.json();
  if (!path || content === undefined) {
    return new Response(JSON.stringify({ error: "path and content required" }), { status: 400 });
  }
  await env.SOURCE_KV.put(path, content);
  await env.DB
    .prepare("INSERT INTO mod_log (id, file_path, action, diff_summary) VALUES (?, ?, 'propose', ?)")
    .bind(crypto.randomUUID(), path, `Wrote ${content.length} chars to KV`)
    .run();
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}

// ── Commit an accepted change to GitHub (the real source of truth) ──────
async function handleCommitToGitHub(request, env) {
  const { path, content, message } = await request.json();
  if (!path || content === undefined) {
    return new Response(JSON.stringify({ error: "path and content required" }), { status: 400 });
  }

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Get current file SHA if it exists (needed to update rather than create)
  let sha;
  const existing = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "mashet-dev-worker" },
  });
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const commitRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "mashet-dev-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: message || `Update ${path} via mashet-dev`,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    }),
  });

  if (!commitRes.ok) {
    const errText = await commitRes.text();
    return new Response(JSON.stringify({ error: "GitHub commit failed", detail: errText }), { status: 502 });
  }

  const commitData = await commitRes.json();
  await env.DB
    .prepare(
      "INSERT INTO mod_log (id, file_path, action, diff_summary, github_commit_sha) VALUES (?, ?, 'commit', ?, ?)"
    )
    .bind(crypto.randomUUID(), path, message || "commit", commitData.commit?.sha ?? null)
    .run();

  return new Response(JSON.stringify({ ok: true, sha: commitData.commit?.sha }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Fallback assets (used only if KV hasn't been seeded yet) ────────────
const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mashet Dev</title>
<link rel="manifest" href="/manifest.json">
</head><body>
<h1>Mashet PWA — bootstrapping</h1>
<p>This is the fallback shell. Seed public/index.html into KV to replace it.</p>
<script>
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
</script>
</body></html>`;

const FALLBACK_MANIFEST = JSON.stringify({
  name: "Mashet Dev",
  short_name: "Mashet",
  start_url: "/",
  display: "standalone",
  background_color: "#050505",
  theme_color: "#c8922a",
  icons: [],
});

const FALLBACK_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());`;
