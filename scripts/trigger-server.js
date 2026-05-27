const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");

const port = Number(process.env.PORT || 8080);
const triggerToken = process.env.TRIGGER_TOKEN || "";
const reportRoot = path.join(__dirname, "..", "newman", "reports");
const logsRoot = path.join(__dirname, "..", "newman", "logs");
const historyRoot = path.join(__dirname, "..", "newman", "history");
const historyDbFile = path.join(historyRoot, "runs-history.db");
const openApiFile = path.join(__dirname, "..", "openapi-trigger-service.yaml");
const uiIndexFile = path.join(__dirname, "..", "ui", "index.html");

/** @type {Map<string, {status: string, mode: string, startedAt: string, finishedAt?: string, exitCode?: number, artifacts: Record<string,string>, logFile: string, error?: string, summary?: Record<string, unknown>, failureSummary?: string[]}>} */
const runs = new Map();
let activeRunId = null;
let db;

function buildArtifactPaths(runId) {
  return {
    junit: path.join(reportRoot, `${runId}-junit.xml`),
    json: path.join(reportRoot, `${runId}.json`),
    html: path.join(reportRoot, `${runId}.html`)
  };
}

function buildArtifactUrls(runId, mode) {
  return {
    log: `/runs/${runId}/log`,
    junit: `/runs/${runId}/artifacts/junit`,
    json: mode === "full" ? `/runs/${runId}/artifacts/json` : null,
    html: mode === "full" ? `/runs/${runId}/artifacts/html` : null
  };
}

function parseCount(logText, label) {
  const pattern = new RegExp(String.raw`\│\s+${label}\s+\│\s+(\d+)\s+\│\s+(\d+)\s+\│`);
  const match = logText.match(pattern);
  if (!match) {
    return null;
  }

  return {
    executed: Number(match[1]),
    failed: Number(match[2])
  };
}

function parseDuration(logText) {
  const match = logText.match(/total run duration:\s+([^\n│]+)/);
  return match ? match[1].trim() : null;
}

function parseAverageResponseTime(logText) {
  const match = logText.match(/average response time:\s+([^\n│]+)/);
  return match ? match[1].trim() : null;
}

function parseFailures(logText) {
  const marker = /#\s+failure\s+detail/i;
  const markerMatch = logText.search(marker);
  if (markerMatch === -1) {
    return [];
  }

  const tail = logText.slice(markerMatch);
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failures = [];
  let current = "";

  for (const line of lines.slice(1)) {
    if (/^\d+\./.test(line)) {
      if (current) {
        failures.push(current.trim());
      }
      current = line.replace(/^\d+\.\s*/, "");
      continue;
    }

    if (current) {
      current = `${current} ${line}`;
    }
  }

  if (current) {
    failures.push(current.trim());
  }

  return failures;
}

function parseLogSummary(logFile) {
  if (!fs.existsSync(logFile)) {
    return { summary: null, failureSummary: [] };
  }

  const logText = fs.readFileSync(logFile, "utf8");
  const summary = {
    iterations: parseCount(logText, "iterations"),
    requests: parseCount(logText, "requests"),
    testScripts: parseCount(logText, "test-scripts"),
    prerequestScripts: parseCount(logText, "prerequest-scripts"),
    assertions: parseCount(logText, "assertions"),
    totalRunDuration: parseDuration(logText),
    averageResponseTime: parseAverageResponseTime(logText)
  };

  return {
    summary,
    failureSummary: parseFailures(logText)
  };
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size
  });

  fs.createReadStream(filePath).pipe(res);
}

function getRunOrSend404(res, runId) {
  const run = runs.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found" });
    return null;
  }

  return run;
}

function getArtifactAvailability(run) {
  return {
    junit: fs.existsSync(run.artifacts.junit),
    json: run.mode === "full" ? fs.existsSync(run.artifacts.json) : false,
    html: run.mode === "full" ? fs.existsSync(run.artifacts.html) : false,
    log: fs.existsSync(run.logFile)
  };
}

function buildRunResponse(runId, run) {
  return {
    runId,
    ...run,
    artifactsAvailable: getArtifactAvailability(run)
  };
}

function waitForRunCompletion(runId, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const run = runs.get(runId);
      if (!run) {
        clearInterval(interval);
        resolve(null);
        return;
      }

      if (run.status !== "running") {
        clearInterval(interval);
        resolve(run);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 500);
  });
}

function ensureDirs() {
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.mkdirSync(historyRoot, { recursive: true });
}

function initHistoryStore() {
  return initSqlJs({
    locateFile: (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file)
  }).then((SQL) => {
    if (fs.existsSync(historyDbFile)) {
      const fileBuffer = fs.readFileSync(historyDbFile);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        error TEXT,
        artifacts_json TEXT NOT NULL,
        artifact_urls_json TEXT NOT NULL,
        log_file TEXT NOT NULL,
        summary_json TEXT,
        failure_summary_json TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    persistHistoryStore();
  });
}

function persistHistoryStore() {
  const data = db.export();
  fs.writeFileSync(historyDbFile, Buffer.from(data));
}

function parseJsonSafe(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapRowToRun(row) {
  return {
    runId: row.run_id,
    status: row.status,
    mode: row.mode,
    startedAt: row.started_at,
    finishedAt: row.finished_at || undefined,
    exitCode: row.exit_code === null ? undefined : row.exit_code,
    error: row.error || undefined,
    artifacts: parseJsonSafe(row.artifacts_json, {}),
    artifactUrls: parseJsonSafe(row.artifact_urls_json, {}),
    logFile: row.log_file,
    summary: parseJsonSafe(row.summary_json, null),
    failureSummary: parseJsonSafe(row.failure_summary_json, [])
  };
}

function readHistory(options = {}) {
  const query = db.exec("SELECT * FROM runs");
  const rows = [];

  if (query.length > 0) {
    const { columns, values } = query[0];
    for (const valueRow of values) {
      const row = {};
      for (let i = 0; i < columns.length; i += 1) {
        row[columns[i]] = valueRow[i];
      }
      rows.push(row);
    }
  }

  const mapped = rows.map(mapRowToRun);
  const statusFilter = options.status;
  const modeFilter = options.mode;
  const startedFrom = options.startedFrom;
  const startedTo = options.startedTo;
  const sort = options.sort || "desc";

  const filtered = mapped.filter((item) => {
    if (statusFilter && item.status !== statusFilter) {
      return false;
    }
    if (modeFilter && item.mode !== modeFilter) {
      return false;
    }
    if (startedFrom && item.startedAt < startedFrom) {
      return false;
    }
    if (startedTo && item.startedAt > startedTo) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sort === "asc") {
      return a.startedAt.localeCompare(b.startedAt);
    }
    return b.startedAt.localeCompare(a.startedAt);
  });

  return filtered;
}

function upsertHistory(runId, runData) {
  db.run(
    `
      INSERT OR REPLACE INTO runs (
        run_id, status, mode, started_at, finished_at, exit_code, error,
        artifacts_json, artifact_urls_json, log_file, summary_json, failure_summary_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      runId,
      runData.status,
      runData.mode,
      runData.startedAt,
      runData.finishedAt || null,
      typeof runData.exitCode === "number" ? runData.exitCode : null,
      runData.error || null,
      JSON.stringify(runData.artifacts || {}),
      JSON.stringify(runData.artifactUrls || {}),
      runData.logFile,
      runData.summary ? JSON.stringify(runData.summary) : null,
      runData.failureSummary ? JSON.stringify(runData.failureSummary) : JSON.stringify([]),
      new Date().toISOString()
    ]
  );
  persistHistoryStore();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (parseError) {
        const error = new Error("Invalid JSON body", { cause: parseError });
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function makeRunId() {
  return `run-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function startRun(mode) {
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(logsRoot, `${runId}.log`);
  const artifacts = buildArtifactPaths(runId);
  const artifactUrls = buildArtifactUrls(runId, mode);

  const runData = {
    status: "running",
    mode,
    startedAt,
    artifacts,
    artifactUrls,
    logFile,
    summary: null,
    failureSummary: []
  };
  runs.set(runId, runData);
  upsertHistory(runId, runData);
  activeRunId = runId;

  const collectionPath = "postman/collections/Restful Booker - Full CRUD + Auth.postman_collection.json";
  const environmentPath = "postman/environments/RestfulBooker - DEV.postman_environment.json";
  const reporters = mode === "full" ? "cli,json,junit,htmlextra" : "cli,junit";
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "newman",
    "run",
    collectionPath,
    "-e",
    environmentPath,
    "--timeout-request",
    "20000",
    "-r",
    reporters,
    "--reporter-junit-export",
    artifacts.junit
  ];

  if (mode === "full") {
    args.push(
      "--bail",
      "--delay-request",
      "100",
      "--reporter-json-export",
      artifacts.json,
      "--reporter-htmlextra-export",
      artifacts.html
    );
  }

  const child = spawn(command, args, {
    cwd: path.join(__dirname, ".."),
    env: process.env
  });

  const stream = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.on("data", (chunk) => stream.write(chunk));
  child.stderr.on("data", (chunk) => stream.write(chunk));

  child.on("close", (code) => {
    stream.end();
    const latest = runs.get(runId);
    if (!latest) {
      return;
    }
    const parsed = parseLogSummary(logFile);
    latest.status = code === 0 ? "passed" : "failed";
    latest.exitCode = code;
    latest.finishedAt = new Date().toISOString();
    latest.summary = parsed.summary;
    latest.failureSummary = parsed.failureSummary;
    runs.set(runId, latest);
    upsertHistory(runId, latest);
    activeRunId = null;
  });

  child.on("error", (error) => {
    stream.end();
    const latest = runs.get(runId);
    if (!latest) {
      return;
    }
    latest.status = "failed";
    latest.error = error.message;
    latest.exitCode = 1;
    latest.finishedAt = new Date().toISOString();
    latest.summary = null;
    latest.failureSummary = [error.message];
    runs.set(runId, latest);
    upsertHistory(runId, latest);
    activeRunId = null;
  });

  return runId;
}

function isAuthorized(req) {
  if (!triggerToken) {
    return true;
  }
  return req.headers["x-trigger-token"] === triggerToken;
}

function getUrl(req) {
  const host = req.headers.host || `localhost:${port}`;
  return new URL(req.url, `http://${host}`);
}

function handleOpenApiFile(res) {
  if (!fs.existsSync(openApiFile)) {
    sendJson(res, 404, { error: "OpenAPI file not found" });
    return;
  }

  const content = fs.readFileSync(openApiFile, "utf8");
  sendText(res, 200, content, "application/yaml; charset=utf-8");
}

function handleSwaggerUi(res) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Newman Trigger Service - Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    html, body { margin: 0; padding: 0; }
    body { background: #fafafa; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi-trigger-service.yaml',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>`;

  sendText(res, 200, html, "text/html; charset=utf-8");
}

function handleUiPage(res) {
  if (!fs.existsSync(uiIndexFile)) {
    sendJson(res, 404, { error: "UI file not found" });
    return;
  }

  const content = fs.readFileSync(uiIndexFile, "utf8");
  sendText(res, 200, content, "text/html; charset=utf-8");
}

function handleHealth(res) {
  sendJson(res, 200, { status: "ok", activeRunId });
}

async function handleRunTests(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (activeRunId) {
    sendJson(res, 409, {
      error: "Another run is active",
      activeRunId
    });
    return;
  }

  const body = await parseBody(req);
  const mode = body.mode === "full" ? "full" : "ci";
  const waitForCompletion = body.waitForCompletion === true;
  const waitTimeoutSec = Number(body.waitTimeoutSec || 120);
  const waitTimeoutMs = Number.isFinite(waitTimeoutSec) && waitTimeoutSec > 0 ? waitTimeoutSec * 1000 : 120000;
  const runId = startRun(mode);

  if (waitForCompletion) {
    const completedRun = await waitForRunCompletion(runId, waitTimeoutMs);
    if (completedRun) {
      sendJson(res, 200, buildRunResponse(runId, completedRun));
      return;
    }

    sendJson(res, 202, {
      runId,
      status: "running",
      mode,
      message: "Run is still in progress. Check statusUrl for updates.",
      statusUrl: `/runs/${runId}`,
      artifactUrls: buildArtifactUrls(runId, mode)
    });
    return;
  }

  sendJson(res, 202, {
    runId,
    status: "accepted",
    mode,
    statusUrl: `/runs/${runId}`,
    artifactUrls: buildArtifactUrls(runId, mode)
  });
}

function handleGetRun(req, res, pathname) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  const runId = pathname.split("/").pop();
  const run = getRunOrSend404(res, runId);
  if (!run) {
    return;
  }

  sendJson(res, 200, buildRunResponse(runId, run));
}

function handleListRuns(req, res, url) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const limitRaw = Number(url.searchParams.get("limit") || 25);
  const offsetRaw = Number(url.searchParams.get("offset") || 0);
  const statusFilter = url.searchParams.get("status") || null;
  const modeFilter = url.searchParams.get("mode") || null;
  const startedFrom = url.searchParams.get("startedFrom") || null;
  const startedTo = url.searchParams.get("startedTo") || null;
  const sort = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const history = readHistory({
    status: statusFilter,
    mode: modeFilter,
    startedFrom,
    startedTo,
    sort
  });
  const items = history.slice(offset, offset + limit);

  sendJson(res, 200, {
    total: history.length,
    count: items.length,
    limit,
    offset,
    filters: {
      status: statusFilter,
      mode: modeFilter,
      startedFrom,
      startedTo,
      sort
    },
    items
  });
}

function handleGetRunLog(req, res, runId) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  const run = getRunOrSend404(res, runId);
  if (!run) {
    return;
  }

  sendFile(res, run.logFile, "text/plain; charset=utf-8");
}

function handleGetRunArtifact(req, res, runId, artifactType) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  const run = getRunOrSend404(res, runId);
  if (!run) {
    return;
  }

  const artifactPath = run.artifacts[artifactType];
  if (!artifactPath) {
    sendJson(res, 404, { error: "Artifact not configured" });
    return;
  }

  const contentTypes = {
    junit: "application/xml; charset=utf-8",
    json: "application/json; charset=utf-8",
    html: "text/html; charset=utf-8"
  };

  sendFile(res, artifactPath, contentTypes[artifactType] || "application/octet-stream");
}

function handleGetRequest(req, res, url, pathname) {
  if (pathname === "/health") {
    handleHealth(res);
    return true;
  }

  if (pathname === "/openapi-trigger-service.yaml") {
    handleOpenApiFile(res);
    return true;
  }

  if (pathname === "/swagger" || pathname === "/swagger/index.html") {
    handleSwaggerUi(res);
    return true;
  }

  if (pathname === "/ui" || pathname === "/ui/index.html") {
    handleUiPage(res);
    return true;
  }

  if (pathname === "/runs") {
    handleListRuns(req, res, url);
    return true;
  }

  if (pathname.startsWith("/runs/")) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 3 && parts[2] === "log") {
      handleGetRunLog(req, res, parts[1]);
      return true;
    }

    if (parts.length === 4 && parts[2] === "artifacts") {
      handleGetRunArtifact(req, res, parts[1], parts[3]);
      return true;
    }

    handleGetRun(req, res, pathname);
    return true;
  }

  return false;
}

async function handlePostRequest(req, res, pathname) {
  if (pathname === "/run-tests") {
    await handleRunTests(req, res);
    return true;
  }

  return false;
}

ensureDirs();
const startupPromise = initHistoryStore().then(() => {
  for (const entry of readHistory()) {
    if (entry?.runId) {
      const { runId, ...runData } = entry;
      runs.set(runId, runData);
    }
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const url = getUrl(req);
    const { pathname } = url;

    if (req.method === "GET" && handleGetRequest(req, res, url, pathname)) {
      return;
    }

    if (req.method === "POST" && await handlePostRequest(req, res, pathname)) {
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

startupPromise.then(() => {
  server.listen(port, () => {
    console.log(`Newman trigger service listening on port ${port}`);
  });
}).catch((error) => {
  console.error("Failed to initialize SQLite history store:", error);
  process.exit(1);
});
