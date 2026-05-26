const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 8080);
const triggerToken = process.env.TRIGGER_TOKEN || "";
const reportRoot = path.join(__dirname, "..", "newman", "reports");
const logsRoot = path.join(__dirname, "..", "newman", "logs");

/** @type {Map<string, {status: string, mode: string, startedAt: string, finishedAt?: string, exitCode?: number, artifacts: Record<string,string>, logFile: string, error?: string}>} */
const runs = new Map();
let activeRunId = null;

function ensureDirs() {
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
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
  const artifacts = {
    junit: path.join(reportRoot, `${runId}-junit.xml`),
    json: path.join(reportRoot, `${runId}.json`),
    html: path.join(reportRoot, `${runId}.html`)
  };

  const runData = {
    status: "running",
    mode,
    startedAt,
    artifacts,
    logFile
  };
  runs.set(runId, runData);
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
    latest.status = code === 0 ? "passed" : "failed";
    latest.exitCode = code;
    latest.finishedAt = new Date().toISOString();
    runs.set(runId, latest);
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
    runs.set(runId, latest);
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
  const runId = startRun(mode);
  sendJson(res, 202, {
    runId,
    status: "accepted",
    mode,
    statusUrl: `/runs/${runId}`
  });
}

function handleGetRun(req, res, pathname) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  const runId = pathname.split("/").pop();
  const run = runs.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found" });
    return;
  }

  sendJson(res, 200, {
    runId,
    ...run
  });
}

ensureDirs();

const server = http.createServer(async (req, res) => {
  try {
    const url = getUrl(req);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/health") {
      handleHealth(res);
      return;
    }

    if (req.method === "POST" && pathname === "/run-tests") {
      await handleRunTests(req, res);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/runs/")) {
      handleGetRun(req, res, pathname);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Newman trigger service listening on port ${port}`);
});
