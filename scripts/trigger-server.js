const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");
const JSZip = require("jszip");

const port = Number(process.env.PORT || 8080);
const triggerToken = process.env.TRIGGER_TOKEN || "";
const workspaceRoot = path.join(__dirname, "..");
const historyRoot = path.join(workspaceRoot, "newman", "history");
const historyDbFile = path.join(historyRoot, "runs-history.db");
const configRoot = path.join(workspaceRoot, "newman", "config");
const projectsConfigFile = path.join(configRoot, "projects.json");
const projectsRoot = path.join(workspaceRoot, "projects");
const openApiFile = path.join(workspaceRoot, "openapi-trigger-service.yaml");
const uiIndexFile = path.join(workspaceRoot, "ui", "index.html");

const defaultProject = {
  projectId: "default",
  name: "Default Project",
  baseDir: workspaceRoot,
  collectionPath: "postman/collections/Restful Booker - Full CRUD + Auth.postman_collection.json",
  environmentPath: "postman/environments/RestfulBooker - DEV.postman_environment.json",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  isDefault: true
};

/** @type {Map<string, {projectId: string, name: string, baseDir: string, collectionPath: string, environmentPath: string, createdAt: string, updatedAt: string, isDefault?: boolean}>} */
const projects = new Map();
/** @type {Map<string, {projectId: string, status: string, mode: string, startedAt: string, finishedAt?: string, exitCode?: number, artifacts: Record<string,string>, artifactUrls: Record<string,string|null>, logFile: string, error?: string, summary?: Record<string, unknown>, failureSummary?: string[]}>} */
const runs = new Map();
let activeRunId = null;
let activeProjectId = null;
let db;

function makeEntityId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function normalizeProjectId(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidProjectId(projectId) {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(projectId);
}

function isValidEntityId(value) {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(value || "").trim().toLowerCase());
}

function projectExists(projectId) {
  return projects.has(normalizeProjectId(projectId));
}

function getProject(projectId) {
  return projects.get(normalizeProjectId(projectId)) || null;
}

function makeProjectBaseDir(projectId) {
  return path.join(projectsRoot, projectId);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureDirs() {
  ensureDir(historyRoot);
  ensureDir(configRoot);
  ensureDir(projectsRoot);
}

function ensureProjectStructure(baseDir) {
  const paths = [
    path.join(baseDir, "postman", "collections"),
    path.join(baseDir, "postman", "environments"),
    path.join(baseDir, "newman", "reports"),
    path.join(baseDir, "newman", "logs"),
    path.join(baseDir, "newman", "history")
  ];

  for (const p of paths) {
    ensureDir(p);
  }
}

function ensureProjectRunDirs(project) {
  ensureDir(path.join(project.baseDir, "newman", "reports"));
  ensureDir(path.join(project.baseDir, "newman", "logs"));
}

function queryRows(sql, params = []) {
  const statement = db.prepare(sql, params);
  const rows = [];

  try {
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function getOneRow(sql, params = []) {
  return queryRows(sql, params)[0] || null;
}

function persistProjects() {
  const data = [];
  for (const project of projects.values()) {
    if (project.isDefault) {
      continue;
    }

    data.push({
      projectId: project.projectId,
      name: project.name,
      collectionPath: project.collectionPath,
      environmentPath: project.environmentPath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    });
  }

  fs.writeFileSync(projectsConfigFile, JSON.stringify({ projects: data }, null, 2), "utf8");
}

function loadProjects() {
  projects.clear();
  projects.set(defaultProject.projectId, defaultProject);

  if (!fs.existsSync(projectsConfigFile)) {
    persistProjects();
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(projectsConfigFile, "utf8"));
  } catch {
    parsed = { projects: [] };
  }

  const entries = Array.isArray(parsed.projects) ? parsed.projects : [];
  for (const entry of entries) {
    const projectId = normalizeProjectId(entry.projectId);
    if (!isValidProjectId(projectId) || projectId === defaultProject.projectId) {
      continue;
    }

    const baseDir = makeProjectBaseDir(projectId);
    const project = {
      projectId,
      name: String(entry.name || projectId),
      baseDir,
      collectionPath: String(entry.collectionPath || `postman/collections/${projectId}.postman_collection.json`),
      environmentPath: String(entry.environmentPath || `postman/environments/${projectId}.postman_environment.json`),
      createdAt: String(entry.createdAt || new Date().toISOString()),
      updatedAt: String(entry.updatedAt || new Date().toISOString())
    };

    ensureProjectStructure(baseDir);
    projects.set(projectId, project);
  }

  persistProjects();
}

function projectToResponse(project) {
  const collectionFile = path.join(project.baseDir, project.collectionPath);
  const environmentFile = path.join(project.baseDir, project.environmentPath);
  const presets = listProjectPresets(project.projectId);
  const collections = listProjectAssets(project.projectId, "collection");
  const environments = listProjectAssets(project.projectId, "environment");
  const defaultPreset = presets.find((item) => item.isDefault) || null;
  return {
    projectId: project.projectId,
    name: project.name,
    isDefault: Boolean(project.isDefault),
    baseDir: path.relative(workspaceRoot, project.baseDir) || ".",
    collectionPath: project.collectionPath,
    environmentPath: project.environmentPath,
    collectionExists: fs.existsSync(collectionFile),
    environmentExists: fs.existsSync(environmentFile),
    collectionsCount: collections.length,
    environmentsCount: environments.length,
    presetsCount: presets.length,
    defaultPresetId: defaultPreset?.presetId || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    releaseTriggerUrl: `/projects/${project.projectId}/release/trigger`
  };
}

function createProject(payload) {
  const projectId = normalizeProjectId(payload.projectId);
  if (!isValidProjectId(projectId)) {
    throw new Error("projectId must match /^[a-z0-9][a-z0-9_-]{1,63}$/");
  }
  if (projectExists(projectId)) {
    throw new Error("Project already exists");
  }

  const createdAt = new Date().toISOString();
  const baseDir = makeProjectBaseDir(projectId);
  ensureProjectStructure(baseDir);

  const collectionFileName = String(payload.collectionFile || `${projectId}.postman_collection.json`).trim();
  const environmentFileName = String(payload.environmentFile || `${projectId}.postman_environment.json`).trim();

  const project = {
    projectId,
    name: String(payload.name || projectId),
    baseDir,
    collectionPath: path.join("postman", "collections", collectionFileName),
    environmentPath: path.join("postman", "environments", environmentFileName),
    createdAt,
    updatedAt: createdAt
  };

  projects.set(projectId, project);
  persistProjects();

  const readmePath = path.join(baseDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    const content = [
      `# ${project.name}`,
      "",
      "This project contains its own Postman and Newman assets.",
      "",
      "## Folder Structure",
      "",
      "- postman/collections",
      "- postman/environments",
      "- newman/reports",
      "- newman/logs",
      "- newman/history",
      "",
      "Update the collection and environment files before triggering runs."
    ].join("\n");
    fs.writeFileSync(readmePath, content, "utf8");
  }

  return project;
}

function buildArtifactPaths(project, runId) {
  const reportRoot = path.join(project.baseDir, "newman", "reports");
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
    html: mode === "full" ? `/runs/${runId}/artifacts/html` : null,
    zip: `/runs/${runId}/artifacts/all.zip`
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

function initHistoryStore() {
  return initSqlJs({
    locateFile: (file) => path.join(workspaceRoot, "node_modules", "sql.js", "dist", file)
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
        project_id TEXT,
        preset_id TEXT,
        collection_asset_id TEXT,
        environment_asset_id TEXT,
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

    try {
      db.run("ALTER TABLE runs ADD COLUMN project_id TEXT");
    } catch {}

    try {
      db.run("ALTER TABLE runs ADD COLUMN preset_id TEXT");
    } catch {}

    try {
      db.run("ALTER TABLE runs ADD COLUMN collection_asset_id TEXT");
    } catch {}

    try {
      db.run("ALTER TABLE runs ADD COLUMN environment_asset_id TEXT");
    } catch {}

    db.run(`
      CREATE TABLE IF NOT EXISTS project_assets (
        project_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, asset_type, asset_id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS project_presets (
        project_id TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        collection_asset_id TEXT NOT NULL,
        environment_asset_id TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, preset_id)
      )
    `);

    db.run("UPDATE runs SET project_id = 'default' WHERE project_id IS NULL OR project_id = ''");

    persistHistoryStore();
  });
}

function persistHistoryStore() {
  const data = db.export();
  fs.writeFileSync(historyDbFile, Buffer.from(data));
}

function assetTypeFolderName(assetType) {
  return assetType === "collection" ? "collections" : "environments";
}

function assetTypeDefaultFileName(assetType, assetId) {
  return `${assetId}.${assetType === "collection" ? "postman_collection" : "postman_environment"}.json`;
}

function normalizeAssetType(assetType) {
  return assetType === "collection" ? "collection" : "environment";
}

function normalizeEntityValue(value, fallbackPrefix) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return makeEntityId(fallbackPrefix);
  }
  if (!isValidEntityId(normalized)) {
    throw new Error("Identifier must match /^[a-z0-9][a-z0-9_-]{1,63}$/");
  }
  return normalized;
}

function stringifyJsonContent(payload) {
  if (typeof payload.content === "string" && payload.content.trim()) {
    JSON.parse(payload.content);
    return payload.content;
  }

  if (payload.document && typeof payload.document === "object") {
    return JSON.stringify(payload.document, null, 2);
  }

  throw new Error("content or document is required");
}

function listProjectAssets(projectId, assetType) {
  return queryRows(
    `
      SELECT project_id, asset_type, asset_id, name, file_name, file_path, created_at, updated_at
      FROM project_assets
      WHERE project_id = ? AND asset_type = ?
      ORDER BY updated_at DESC
    `,
    [normalizeProjectId(projectId), normalizeAssetType(assetType)]
  ).map((row) => ({
    projectId: row.project_id,
    assetType: row.asset_type,
    assetId: row.asset_id,
    name: row.name,
    fileName: row.file_name,
    filePath: row.file_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function getProjectAsset(projectId, assetType, assetId) {
  const row = getOneRow(
    `
      SELECT project_id, asset_type, asset_id, name, file_name, file_path, content_text, created_at, updated_at
      FROM project_assets
      WHERE project_id = ? AND asset_type = ? AND asset_id = ?
    `,
    [normalizeProjectId(projectId), normalizeAssetType(assetType), normalizeEntityValue(assetId, assetType)]
  );

  if (!row) {
    return null;
  }

  return {
    projectId: row.project_id,
    assetType: row.asset_type,
    assetId: row.asset_id,
    name: row.name,
    fileName: row.file_name,
    filePath: row.file_path,
    content: row.content_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function saveProjectAsset(projectId, assetType, payload) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const normalizedType = normalizeAssetType(assetType);
  const assetId = normalizeEntityValue(payload.assetId || payload.id, normalizedType);
  const content = stringifyJsonContent(payload);
  const fileName = String(payload.fileName || assetTypeDefaultFileName(normalizedType, assetId)).trim();
  const relativeFilePath = path.join("postman", assetTypeFolderName(normalizedType), fileName);
  const absoluteFilePath = path.join(project.baseDir, relativeFilePath);
  const now = new Date().toISOString();
  const existing = getProjectAsset(project.projectId, normalizedType, assetId);

  ensureProjectStructure(project.baseDir);
  fs.writeFileSync(absoluteFilePath, content, "utf8");

  db.run(
    `
      INSERT OR REPLACE INTO project_assets (
        project_id, asset_type, asset_id, name, file_name, file_path, content_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      project.projectId,
      normalizedType,
      assetId,
      String(payload.name || assetId),
      fileName,
      relativeFilePath,
      content,
      existing?.createdAt || now,
      now
    ]
  );
  persistHistoryStore();

  return getProjectAsset(project.projectId, normalizedType, assetId);
}

function listProjectPresets(projectId) {
  return queryRows(
    `
      SELECT project_id, preset_id, name, collection_asset_id, environment_asset_id, is_default, created_at, updated_at
      FROM project_presets
      WHERE project_id = ?
      ORDER BY is_default DESC, updated_at DESC
    `,
    [normalizeProjectId(projectId)]
  ).map((row) => ({
    projectId: row.project_id,
    presetId: row.preset_id,
    name: row.name,
    collectionAssetId: row.collection_asset_id,
    environmentAssetId: row.environment_asset_id,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function getProjectPreset(projectId, presetId) {
  const row = getOneRow(
    `
      SELECT project_id, preset_id, name, collection_asset_id, environment_asset_id, is_default, created_at, updated_at
      FROM project_presets
      WHERE project_id = ? AND preset_id = ?
    `,
    [normalizeProjectId(projectId), normalizeEntityValue(presetId, "preset")]
  );

  if (!row) {
    return null;
  }

  return {
    projectId: row.project_id,
    presetId: row.preset_id,
    name: row.name,
    collectionAssetId: row.collection_asset_id,
    environmentAssetId: row.environment_asset_id,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getDefaultPreset(projectId) {
  const presets = listProjectPresets(projectId);
  return presets.find((item) => item.isDefault) || presets[0] || null;
}

function saveProjectPreset(projectId, payload) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const presetId = normalizeEntityValue(payload.presetId || payload.id, "preset");
  const collectionAssetId = normalizeEntityValue(payload.collectionAssetId, "collection");
  const environmentAssetId = normalizeEntityValue(payload.environmentAssetId, "environment");
  const collectionAsset = getProjectAsset(project.projectId, "collection", collectionAssetId);
  const environmentAsset = getProjectAsset(project.projectId, "environment", environmentAssetId);

  if (!collectionAsset) {
    throw new Error("Collection asset not found");
  }
  if (!environmentAsset) {
    throw new Error("Environment asset not found");
  }

  const now = new Date().toISOString();
  const existing = getProjectPreset(project.projectId, presetId);
  const shouldBeDefault = payload.isDefault === true || (!existing && listProjectPresets(project.projectId).length === 0);

  if (shouldBeDefault) {
    db.run("UPDATE project_presets SET is_default = 0 WHERE project_id = ?", [project.projectId]);
  }

  db.run(
    `
      INSERT OR REPLACE INTO project_presets (
        project_id, preset_id, name, collection_asset_id, environment_asset_id, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      project.projectId,
      presetId,
      String(payload.name || presetId),
      collectionAssetId,
      environmentAssetId,
      shouldBeDefault ? 1 : 0,
      existing?.createdAt || now,
      now
    ]
  );
  persistHistoryStore();

  return getProjectPreset(project.projectId, presetId);
}

function resolveRunConfiguration(projectId, body) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  if (body.presetId) {
    const preset = getProjectPreset(project.projectId, body.presetId);
    if (!preset) {
      throw new Error("Preset not found");
    }

    const collectionAsset = getProjectAsset(project.projectId, "collection", preset.collectionAssetId);
    const environmentAsset = getProjectAsset(project.projectId, "environment", preset.environmentAssetId);
    if (!collectionAsset || !environmentAsset) {
      throw new Error("Preset assets are missing");
    }

    return {
      presetId: preset.presetId,
      collectionAssetId: collectionAsset.assetId,
      environmentAssetId: environmentAsset.assetId,
      collectionAbsolutePath: path.join(project.baseDir, collectionAsset.filePath),
      environmentAbsolutePath: path.join(project.baseDir, environmentAsset.filePath)
    };
  }

  if (body.collectionAssetId || body.environmentAssetId) {
    const collectionAsset = getProjectAsset(project.projectId, "collection", body.collectionAssetId);
    const environmentAsset = getProjectAsset(project.projectId, "environment", body.environmentAssetId);
    if (!collectionAsset) {
      throw new Error("Collection asset not found");
    }
    if (!environmentAsset) {
      throw new Error("Environment asset not found");
    }

    return {
      presetId: null,
      collectionAssetId: collectionAsset.assetId,
      environmentAssetId: environmentAsset.assetId,
      collectionAbsolutePath: path.join(project.baseDir, collectionAsset.filePath),
      environmentAbsolutePath: path.join(project.baseDir, environmentAsset.filePath)
    };
  }

  const defaultPreset = getDefaultPreset(project.projectId);
  if (defaultPreset) {
    return resolveRunConfiguration(project.projectId, { presetId: defaultPreset.presetId });
  }

  return {
    presetId: null,
    collectionAssetId: null,
    environmentAssetId: null,
    collectionAbsolutePath: path.join(project.baseDir, project.collectionPath),
    environmentAbsolutePath: path.join(project.baseDir, project.environmentPath)
  };
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
    projectId: row.project_id || "default",
    presetId: row.preset_id || undefined,
    collectionAssetId: row.collection_asset_id || undefined,
    environmentAssetId: row.environment_asset_id || undefined,
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
  const projectFilter = options.projectId ? normalizeProjectId(options.projectId) : null;
  const statusFilter = options.status;
  const modeFilter = options.mode;
  const startedFrom = options.startedFrom;
  const startedTo = options.startedTo;
  const sort = options.sort || "desc";

  const filtered = mapped.filter((item) => {
    if (projectFilter && item.projectId !== projectFilter) {
      return false;
    }
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
        run_id, project_id, preset_id, collection_asset_id, environment_asset_id, status, mode, started_at, finished_at, exit_code, error,
        artifacts_json, artifact_urls_json, log_file, summary_json, failure_summary_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      runId,
      runData.projectId || "default",
      runData.presetId || null,
      runData.collectionAssetId || null,
      runData.environmentAssetId || null,
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

function startRun(mode, projectId, selection) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  ensureProjectRunDirs(project);
  const collectionAbsolutePath = selection.collectionAbsolutePath;
  const environmentAbsolutePath = selection.environmentAbsolutePath;

  if (!fs.existsSync(collectionAbsolutePath)) {
    throw new Error(`Collection file not found: ${project.collectionPath}`);
  }
  if (!fs.existsSync(environmentAbsolutePath)) {
    throw new Error(`Environment file not found: ${project.environmentPath}`);
  }

  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(project.baseDir, "newman", "logs", `${runId}.log`);
  const artifacts = buildArtifactPaths(project, runId);
  const artifactUrls = buildArtifactUrls(runId, mode);

  const runData = {
    projectId: project.projectId,
    presetId: selection.presetId || null,
    collectionAssetId: selection.collectionAssetId || null,
    environmentAssetId: selection.environmentAssetId || null,
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
  activeProjectId = project.projectId;

  const reporters = mode === "full" ? "cli,json,junit,htmlextra" : "cli,junit";
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "newman",
    "run",
    collectionAbsolutePath,
    "-e",
    environmentAbsolutePath,
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
    cwd: workspaceRoot,
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

    if (activeRunId === runId) {
      activeRunId = null;
      activeProjectId = null;
    }
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

    if (activeRunId === runId) {
      activeRunId = null;
      activeProjectId = null;
    }
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
  sendJson(res, 200, { status: "ok", activeRunId, activeProjectId });
}

async function handleRunTests(req, res, projectIdOverride) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (activeRunId) {
    sendJson(res, 409, {
      error: "Another run is active",
      activeRunId,
      activeProjectId
    });
    return;
  }

  const body = await parseBody(req);
  const projectId = normalizeProjectId(projectIdOverride || body.projectId || "default");
  if (!projectExists(projectId)) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }

  const mode = body.mode === "full" ? "full" : "ci";
  const waitForCompletion = body.waitForCompletion === true;
  const waitTimeoutSec = Number(body.waitTimeoutSec || 120);
  const waitTimeoutMs = Number.isFinite(waitTimeoutSec) && waitTimeoutSec > 0 ? waitTimeoutSec * 1000 : 120000;
  const selection = resolveRunConfiguration(projectId, body);
  const runId = startRun(mode, projectId, selection);

  if (waitForCompletion) {
    const completedRun = await waitForRunCompletion(runId, waitTimeoutMs);
    if (completedRun) {
      sendJson(res, 200, buildRunResponse(runId, completedRun));
      return;
    }

    sendJson(res, 202, {
      runId,
      projectId,
      presetId: selection.presetId,
      collectionAssetId: selection.collectionAssetId,
      environmentAssetId: selection.environmentAssetId,
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
    projectId,
    presetId: selection.presetId,
    collectionAssetId: selection.collectionAssetId,
    environmentAssetId: selection.environmentAssetId,
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
  const projectFilter = url.searchParams.get("projectId") || null;
  const statusFilter = url.searchParams.get("status") || null;
  const modeFilter = url.searchParams.get("mode") || null;
  const startedFrom = url.searchParams.get("startedFrom") || null;
  const startedTo = url.searchParams.get("startedTo") || null;
  const sort = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const history = readHistory({
    projectId: projectFilter,
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
      projectId: projectFilter,
      status: statusFilter,
      mode: modeFilter,
      startedFrom,
      startedTo,
      sort
    },
    items
  });
}

function handleListProjects(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const items = Array.from(projects.values())
    .map(projectToResponse)
    .sort((a, b) => a.projectId.localeCompare(b.projectId));

  sendJson(res, 200, {
    total: items.length,
    items
  });
}

function handleGetProject(req, res, projectId) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const project = getProject(projectId);
  if (!project) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }

  sendJson(res, 200, projectToResponse(project));
}

async function handleCreateProject(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await parseBody(req);
  if (!body.projectId) {
    sendJson(res, 400, { error: "projectId is required" });
    return;
  }

  const project = createProject(body);
  sendJson(res, 201, {
    message: "Project created",
    project: projectToResponse(project)
  });
}

function handleListProjectAssets(req, res, projectId, assetType) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (!projectExists(projectId)) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }

  sendJson(res, 200, {
    projectId: normalizeProjectId(projectId),
    assetType: normalizeAssetType(assetType),
    items: listProjectAssets(projectId, assetType)
  });
}

async function handleCreateProjectAsset(req, res, projectId, assetType) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await parseBody(req);
  const asset = saveProjectAsset(projectId, assetType, body);
  sendJson(res, 201, {
    message: `${normalizeAssetType(assetType)} saved`,
    asset
  });
}

function handleListProjectPresets(req, res, projectId) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (!projectExists(projectId)) {
    sendJson(res, 404, { error: "Project not found" });
    return;
  }

  sendJson(res, 200, {
    projectId: normalizeProjectId(projectId),
    items: listProjectPresets(projectId),
    defaultPresetId: getDefaultPreset(projectId)?.presetId || null
  });
}

async function handleCreateProjectPreset(req, res, projectId) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await parseBody(req);
  const preset = saveProjectPreset(projectId, body);
  sendJson(res, 201, {
    message: "Preset saved",
    preset
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

async function handleGetRunArtifactZip(req, res, runId) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const run = getRunOrSend404(res, runId);
  if (!run) {
    return;
  }

  const zip = new JSZip();
  const candidates = [
    ["log.txt", run.logFile],
    ["junit.xml", run.artifacts.junit],
    ["report.json", run.artifacts.json],
    ["report.html", run.artifacts.html]
  ];

  let added = 0;
  for (const [fileName, filePath] of candidates) {
    if (filePath && fs.existsSync(filePath)) {
      zip.file(fileName, fs.readFileSync(filePath));
      added += 1;
    }
  }

  if (added === 0) {
    sendJson(res, 404, { error: "No artifacts found for run" });
    return;
  }

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${runId}-artifacts.zip"`,
    "Content-Length": content.length
  });
  res.end(content);
}

function handleProjectGetRequest(req, res, pathname) {
  if (!pathname.startsWith("/projects/")) {
    return false;
  }

  const parts = pathname.split("/").filter(Boolean);
  const projectId = parts[1];

  if (parts.length === 2) {
    handleGetProject(req, res, projectId);
    return true;
  }

  if (parts.length === 3 && parts[2] === "collections") {
    handleListProjectAssets(req, res, projectId, "collection");
    return true;
  }

  if (parts.length === 3 && parts[2] === "environments") {
    handleListProjectAssets(req, res, projectId, "environment");
    return true;
  }

  if (parts.length === 3 && parts[2] === "presets") {
    handleListProjectPresets(req, res, projectId);
    return true;
  }

  return false;
}

async function handleRunGetRequest(req, res, pathname) {
  if (pathname === "/runs") {
    return false;
  }

  if (!pathname.startsWith("/runs/")) {
    return false;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 3 && parts[2] === "log") {
    handleGetRunLog(req, res, parts[1]);
    return true;
  }

  if (parts.length === 4 && parts[2] === "artifacts") {
    if (parts[3] === "all.zip") {
      await handleGetRunArtifactZip(req, res, parts[1]);
      return true;
    }

    handleGetRunArtifact(req, res, parts[1], parts[3]);
    return true;
  }

  handleGetRun(req, res, pathname);
  return true;
}

async function handleGetRequest(req, res, url, pathname) {
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

  if (pathname === "/projects") {
    handleListProjects(req, res);
    return true;
  }

  if (handleProjectGetRequest(req, res, pathname)) {
    return true;
  }

  if (pathname === "/runs") {
    handleListRuns(req, res, url);
    return true;
  }

  if (await handleRunGetRequest(req, res, pathname)) {
    return true;
  }

  return false;
}

async function handleProjectPostRequest(req, res, pathname) {
  if (!pathname.startsWith("/projects/")) {
    return false;
  }

  const parts = pathname.split("/").filter(Boolean);
  const projectId = parts[1];

  if (parts.length === 3 && parts[2] === "collections") {
    await handleCreateProjectAsset(req, res, projectId, "collection");
    return true;
  }

  if (parts.length === 3 && parts[2] === "environments") {
    await handleCreateProjectAsset(req, res, projectId, "environment");
    return true;
  }

  if (parts.length === 3 && parts[2] === "presets") {
    await handleCreateProjectPreset(req, res, projectId);
    return true;
  }

  if (parts.length === 3 && parts[2] === "run-tests") {
    await handleRunTests(req, res, projectId);
    return true;
  }

  if (parts.length === 4 && parts[2] === "release" && parts[3] === "trigger") {
    await handleRunTests(req, res, projectId);
    return true;
  }

  return false;
}

async function handlePostRequest(req, res, pathname) {
  if (pathname === "/run-tests") {
    await handleRunTests(req, res);
    return true;
  }

  if (pathname === "/projects") {
    await handleCreateProject(req, res);
    return true;
  }

  return handleProjectPostRequest(req, res, pathname);
}

ensureDirs();
loadProjects();
const startupPromise = initHistoryStore().then(() => {
  for (const entry of readHistory()) {
    if (!entry?.runId) {
      continue;
    }

    const { runId, ...runData } = entry;
    runs.set(runId, runData);
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const url = getUrl(req);
    const { pathname } = url;

    if (req.method === "GET" && await handleGetRequest(req, res, url, pathname)) {
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
