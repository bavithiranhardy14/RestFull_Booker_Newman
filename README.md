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

Check run status:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>
```

List run history for UI (latest first):

```bash
curl -H "x-trigger-token: <your-token>" "http://localhost:8080/runs?limit=25&offset=0"
```

Run history filters for UI:

```bash
curl -H "x-trigger-token: <your-token>" "http://localhost:8080/runs?status=failed&mode=full&sort=desc&startedFrom=2026-05-27T00:00:00.000Z&startedTo=2026-05-27T23:59:59.999Z&limit=50&offset=0"
```

History is stored in SQLite database:

- `/app/newman/history/runs-history.db`

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