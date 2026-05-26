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

Check run status:

```bash
curl -H "x-trigger-token: <your-token>" http://localhost:8080/runs/<runId>
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

## GitHub Container Image Workflow

Workflow file: `.github/workflows/newman-runner-image.yml`

This workflow builds and pushes image tags to GHCR:

- `ghcr.io/<owner>/newman-runner:latest`
- `ghcr.io/<owner>/newman-runner:sha-<commit>`
- `ghcr.io/<owner>/newman-runner:<branch>`

## Release Pipeline Trigger Example

PowerShell example script is available at:

- `scripts/trigger-release-example.ps1`

Required release pipeline variables:

- `NEWMAN_TRIGGER_URL` (example: `https://<service-url>/run-tests`)
- `NEWMAN_TRIGGER_TOKEN`