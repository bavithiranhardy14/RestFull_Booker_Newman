# RestFull_Booker_Newman

## Newman Setup

Install dependencies:

```bash
npm install
```

## Run Commands

Basic run:

```bash
npm run test:api
```

Best-practice report run (CLI + JSON + JUnit + HTML):

```bash
npm run report
```

CI-friendly run (CLI + JUnit):

```bash
npm run report:ci
```

## Reports Output

Generated report files:

- `newman/reports/newman-report.json`
- `newman/reports/newman-junit.xml`
- `newman/reports/newman-report.html`

## Containerized Newman Runner

## Multi-Project SDET Product Model

This solution now supports multiple API automation projects inside one trigger service.

Recommended model:

- one project per API/product area
- one shared collection for that project when test flow is the same
- multiple environment files for DEV, QA, UAT, STAGE, PROD-like validation
- one or more named presets that bind a collection plus environment for trigger/release use

Each project gets its own isolated structure under `projects/<projectId>`:

- `postman/collections`
- `postman/environments`
- `newman/reports`
- `newman/logs`
- `newman/history`

This makes the service usable as a productized SDET platform instead of a single hardcoded Postman collection runner.

Default legacy project support is still available from the root-level `postman` and `newman` folders.

Run the trigger API locally:

```bash
npm run trigger:start
```

Health check:

```bash
curl http://localhost:8080/health
```

Trigger a CI mode run (returns `runId`):

```bash
curl -X POST http://localhost:8080/run-tests \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"mode":"ci"}'
```

Trigger a full run and wait for completion in the same call:

```bash
curl -X POST http://localhost:8080/run-tests \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"mode":"full","waitForCompletion":true,"waitTimeoutSec":180}'
```

When `waitForCompletion` is true, the response returns final `status`, `summary`,
`failureSummary`, and `artifactUrls` if completed before timeout.

Create a new project scaffold:

```bash
curl -X POST http://localhost:8080/projects \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"projectId":"booking-stage","name":"Booking Stage","collectionFile":"booking-stage.postman_collection.json","environmentFile":"booking-stage.postman_environment.json"}'
```

Upload a shared collection into SQLite and sync it into the project folder:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/collections \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"assetId":"restful-booker-core","name":"Restful Booker Core","fileName":"restful-booker-core.postman_collection.json","content":"{...json content...}"}'
```

Upload an environment separately:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/environments \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"assetId":"dev","name":"Development","fileName":"dev.postman_environment.json","content":"{...json content...}"}'
```

Upload another environment using the same collection:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/environments \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"assetId":"qa","name":"QA","fileName":"qa.postman_environment.json","content":"{...json content...}"}'
```

Create a preset that binds collection + environment for release triggering:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/presets \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"presetId":"dev-smoke","name":"DEV Smoke","collectionAssetId":"restful-booker-core","environmentAssetId":"dev","isDefault":true}'
```

Create another preset for the same collection with a different environment:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/presets \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"presetId":"qa-smoke","name":"QA Smoke","collectionAssetId":"restful-booker-core","environmentAssetId":"qa"}'
```

List available projects:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/projects
```

Get one project definition:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/projects/booking-stage
```

List uploaded collections, environments, and presets:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/projects/booking-stage/collections
curl -H "x-trigger-token: <your-token>" http://localhost:8080/projects/booking-stage/environments
curl -H "x-trigger-token: <your-token>" http://localhost:8080/projects/booking-stage/presets
```

Trigger a project-specific run:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/run-tests \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"presetId":"dev-smoke","mode":"full","waitForCompletion":true,"waitTimeoutSec":180}'
```

You can also trigger by directly choosing uploaded assets without a saved preset:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/run-tests \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"collectionAssetId":"restful-booker-core","environmentAssetId":"qa","mode":"ci"}'
```

Release-style trigger endpoint for pipelines:

```bash
curl -X POST http://localhost:8080/projects/booking-stage/release/trigger \
	-H "Content-Type: application/json" \
	-H "x-trigger-token: <your-token>" \
	-d '{"presetId":"qa-smoke","mode":"ci"}'
```

Check run status:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>
```

List run history for UI (latest first):

```bash
curl -H "x-trigger-token: <your-token>" "http://localhost:8080/runs?limit=25&offset=0"
```

List run history for a single project:

```bash
curl -H "x-trigger-token: <your-token>" "http://localhost:8080/runs?projectId=booking-stage&limit=25&offset=0"
```

Run history filters for UI:

```bash
curl -H "x-trigger-token: <your-token>" "http://localhost:8080/runs?status=failed&mode=full&sort=desc&startedFrom=2026-05-27T00:00:00.000Z&startedTo=2026-05-27T23:59:59.999Z&limit=50&offset=0"
```

History is stored in SQLite database:

- `/app/newman/history/runs-history.db`

Run history rows are now project-aware through `projectId`, so one SQLite database can track multiple SDET projects.

Uploaded collection/environment JSON and preset definitions are also stored in SQLite, while synchronized copies are written into the project folder for Newman execution.

Fetch run log and reports:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>/log
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>/artifacts/junit
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>/artifacts/json
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>/artifacts/html
```

Modes:

- `ci`: CLI + JUnit reports
- `full`: CLI + JSON + JUnit + HTML reports

Environment variables:

- `PORT` (default: `8080`)
- `TRIGGER_TOKEN` (recommended in non-local environments)

## Docker Build and Run

Build image:

```bash
docker build -t newman-runner:local .
```

Run container:

```bash
docker run --rm -p 8080:8080 -e TRIGGER_TOKEN=my-secret newman-runner:local
```

Persist reports and run history across container restarts:

```bash
docker run --rm -p 8080:8080 -e TRIGGER_TOKEN=my-secret -v newman_data:/app/newman newman-runner:local
```

Important persistence note:

- Rebuilding the Docker image does not remove stored run history if you continue using the same named volume.
- Project scaffolds stored inside the repo workspace are part of your mounted/container filesystem state, while SQLite history persists under the mounted `/app/newman` path.
- If you delete the Docker volume, the stored run history database is removed.

## GitHub Container Image Workflow

Workflow file: `.github/workflows/newman-runner-image.yml`

This workflow builds and pushes image tags to GHCR:

- `ghcr.io/<owner>/newman-runner:latest`
- `ghcr.io/<owner>/newman-runner:sha-<commit>`
- `ghcr.io/<owner>/newman-runner:<branch>`

## OpenAPI Contract

UI/backend integration contract file:

- `openapi-trigger-service.yaml`

Use this file in Swagger Editor or any OpenAPI code generator to build typed API clients.

Hosted Swagger UI in local service:

- `http://localhost:8080/swagger/index.html`
- OpenAPI YAML endpoint: `http://localhost:8080/openapi-trigger-service.yaml`

Hosted Run Dashboard UI:

- `http://localhost:8080/ui`

## Release Pipeline Trigger Example

PowerShell example script is available at:

- `scripts/trigger-release-example.ps1`

Required release pipeline variables:

- `NEWMAN_TRIGGER_URL` (example: `https://<service-url>/run-tests`)
- `NEWMAN_TRIGGER_TOKEN`

For multi-project product usage, prefer a project-specific release URL:

- `https://<service-url>/projects/<projectId>/release/trigger`