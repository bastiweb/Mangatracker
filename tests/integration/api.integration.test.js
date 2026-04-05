const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT_DIR = path.join(__dirname, "..", "..");
const SERVER_ENTRY = path.join(ROOT_DIR, "src", "server.js");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(baseUrl, getServerLog, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore while server is booting.
    }

    await sleep(250);
  }

  throw new Error(`Server did not become ready in ${timeoutMs}ms.\n${getServerLog()}`);
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }
      resolve();
    }, 5000);

    serverProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.kill("SIGTERM");
  });
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  updateCookies(response) {
    const cookieHeaders = [];
    if (typeof response.headers.getSetCookie === "function") {
      cookieHeaders.push(...response.headers.getSetCookie());
    } else {
      const fallback = response.headers.get("set-cookie");
      if (fallback) {
        cookieHeaders.push(fallback);
      }
    }

    cookieHeaders.forEach((headerValue) => {
      const firstPart = String(headerValue || "").split(";")[0];
      const equalIndex = firstPart.indexOf("=");
      if (equalIndex <= 0) {
        return;
      }
      const key = firstPart.slice(0, equalIndex).trim();
      const value = firstPart.slice(equalIndex + 1).trim();
      if (!key) {
        return;
      }
      if (!value) {
        this.cookies.delete(key);
        return;
      }
      this.cookies.set(key, value);
    });
  }

  getCookieHeader() {
    if (this.cookies.size === 0) {
      return "";
    }
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  async request(method, route, options = {}) {
    const upperMethod = String(method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    const cookieHeader = this.getCookieHeader();

    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
    if (upperMethod !== "GET" && upperMethod !== "HEAD" && !headers.origin) {
      // Match server-side CSRF same-origin checks.
      headers.origin = this.baseUrl;
    }

    let body = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = headers["content-type"] || "application/json";
      body = JSON.stringify(options.json);
    }

    const response = await fetch(`${this.baseUrl}${route}`, {
      method: upperMethod,
      headers,
      body
    });
    this.updateCookies(response);

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: response.headers
    };
  }
}

test(
  "integration: auth, roles, reviews, import/export and multi-user isolation",
  { timeout: 120000 },
  async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-tracker-it-"));
    const dbFile = path.join(tempDir, "integration.db");
    const port = 43000 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    let serverLog = "";

    const serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DB_FILE: dbFile,
        DB_ENCRYPTION_KEY: "integration-test-key-1234567890",
        BACKUP_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    serverProcess.stdout.on("data", (chunk) => {
      serverLog += chunk.toString();
    });
    serverProcess.stderr.on("data", (chunk) => {
      serverLog += chunk.toString();
    });

    t.after(async () => {
      await stopServer(serverProcess);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await waitForServer(baseUrl, () => serverLog);

    const guest = new ApiClient(baseUrl);
    const admin = new ApiClient(baseUrl);
    const reader = new ApiClient(baseUrl);
    const readerAdmin = new ApiClient(baseUrl);

    let response = await guest.request("GET", "/api/auth/me");
    assert.equal(response.status, 401);

    response = await guest.request("GET", "/api/auth/bootstrap");
    assert.equal(response.status, 200);
    assert.equal(response.data.hasUsers, false);
    assert.equal(response.data.allowRegistration, true);

    response = await admin.request("POST", "/api/auth/register", {
      json: {
        email: "admin@example.com",
        username: "admin",
        password: "StrongPass123!"
      }
    });
    assert.equal(response.status, 201);
    assert.equal(response.data.user.role, "admin");

    response = await admin.request("GET", "/api/auth/me");
    assert.equal(response.status, 200);
    assert.equal(response.data.user.username, "admin");

    response = await admin.request("POST", "/api/manga", {
      json: {
        title: "One Piece",
        mediaType: "manga",
        ownedVolumes: 3,
        totalVolumes: 10,
        status: "Sammle",
        notes: "Strawhat crew",
        genres: ["Adventure"],
        moods: ["funny"]
      }
    });
    assert.equal(response.status, 201);
    const onePieceId = response.data.id;

    response = await admin.request("PATCH", `/api/manga/${onePieceId}/review`, {
      json: {
        userRating: 5,
        userReview: "Great start."
      }
    });
    if (response.status !== 200) {
      throw new Error(
        `Review endpoint failed with status ${response.status}: ${JSON.stringify(response.data)}\n${serverLog}`
      );
    }
    assert.equal(response.data.user_rating, 5);

    response = await admin.request("GET", "/api/manga?q=piece&sort=title_asc&genre=Adventure");
    if (response.status !== 200) {
      throw new Error(
        `Search endpoint failed with status ${response.status}: ${JSON.stringify(response.data)}\n${serverLog}`
      );
    }
    assert.equal(Array.isArray(response.data), true);
    assert.equal(response.data.length, 1);
    assert.equal(response.data[0].title, "One Piece");

    response = await admin.request("GET", "/api/manga/genres");
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.data.genres), true);
    assert.ok(response.data.genres.includes("Adventure"));

    response = await admin.request("GET", "/api/export/csv");
    assert.equal(response.status, 200);
    assert.equal(typeof response.data, "string");
    assert.ok(response.data.includes("One Piece"));

    response = await admin.request("PUT", "/api/admin/registration", {
      json: { allowRegistration: false }
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.allowRegistration, false);

    response = await guest.request("POST", "/api/auth/register", {
      json: {
        email: "blocked@example.com",
        username: "blocked-user",
        password: "StrongPass123!"
      }
    });
    assert.equal(response.status, 403);

    response = await admin.request("POST", "/api/auth/register", {
      json: {
        email: "reader@example.com",
        username: "reader",
        password: "ReaderPass123!",
        role: "user"
      }
    });
    assert.equal(response.status, 201);
    assert.equal(response.data.user.role, "user");
    const readerUserId = response.data.user.id;

    response = await admin.request("GET", "/api/admin/users");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data.users));
    assert.ok(response.data.users.length >= 2);
    assert.ok(response.headers.get("x-request-id"));

    response = await admin.request(
      "GET",
      "/api/admin/users?q=reader&role=user&sort=email_asc"
    );
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data.users));
    assert.equal(response.data.users.length, 1);
    assert.equal(response.data.users[0].email, "reader@example.com");

    response = await reader.request("POST", "/api/auth/login", {
      json: {
        identifier: "reader",
        password: "ReaderPass123!"
      }
    });
    assert.equal(response.status, 200);

    response = await reader.request("GET", "/api/admin/users");
    assert.equal(response.status, 403);

    response = await reader.request("POST", "/api/manga", {
      json: {
        title: "Dune",
        mediaType: "book",
        status: "Abgeschlossen"
      }
    });
    assert.equal(response.status, 201);

    response = await reader.request("GET", "/api/manga");
    assert.equal(response.status, 200);
    assert.equal(response.data.length, 1);
    assert.equal(response.data[0].title, "Dune");

    response = await reader.request("GET", "/api/export/csv");
    assert.equal(response.status, 200);
    assert.ok(typeof response.data === "string");
    assert.ok(response.data.includes("Dune"));
    assert.equal(response.data.includes("One Piece"), false);

    const importCsv = [
      "title,media_type,status,owned_volumes,total_volumes",
      "Dune,book,Abgeschlossen,1,1",
      "Bleach,manga,Sammle,2,10"
    ].join("\n");

    response = await reader.request("POST", "/api/import/csv/preview", {
      headers: { "content-type": "text/csv" },
      body: importCsv
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.total, 2);
    assert.equal(response.data.newCount, 1);
    assert.equal(response.data.duplicateCount, 1);

    response = await reader.request("POST", "/api/import/csv", {
      headers: { "content-type": "text/csv" },
      body: importCsv
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.imported, 1);
    assert.equal(response.data.skipped, 1);

    response = await reader.request("GET", "/api/manga?sort=title_asc");
    assert.equal(response.status, 200);
    assert.equal(response.data.length, 2);
    assert.deepEqual(
      response.data.map((entry) => entry.title),
      ["Bleach", "Dune"]
    );

    response = await reader.request("GET", `/api/manga/${onePieceId}`);
    assert.equal(response.status, 404);

    response = await admin.request("PUT", `/api/admin/users/${readerUserId}/role`, {
      json: { role: "admin" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.user.role, "admin");

    response = await readerAdmin.request("POST", "/api/auth/login", {
      json: {
        identifier: "reader@example.com",
        password: "ReaderPass123!"
      }
    });
    assert.equal(response.status, 200);

    response = await readerAdmin.request("GET", "/api/admin/users");
    assert.equal(response.status, 200);

    const adminUserId = response.data.users.find((user) => user.email === "admin@example.com")?.id;
    assert.ok(Number.isInteger(adminUserId));

    response = await admin.request("PUT", `/api/admin/users/${adminUserId}/role`, {
      json: { role: "user" }
    });
    assert.equal(response.status, 400);

    response = await admin.request("GET", "/api/admin/audit?limit=20");
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.data.entries), true);
    assert.ok(response.data.entries.length > 0);
  }
);
