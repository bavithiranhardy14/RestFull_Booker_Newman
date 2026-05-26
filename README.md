# RestFull_Booker_Newman :

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
