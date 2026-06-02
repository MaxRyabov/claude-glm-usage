## ADDED Requirements

### Requirement: No external script sources in WebView
The dashboard WebView CSP `script-src` SHALL allow only nonce-tagged scripts and SHALL NOT
reference any external CDN.

#### Scenario: CSP forbids CDN scripts
- **WHEN** the dashboard HTML is generated
- **THEN** the CSP `script-src` contains the nonce and does NOT contain `cdn.jsdelivr.net`

### Requirement: Chart.js bundled as a local resource
Chart.js SHALL be served from a bundled local WebView resource, not a remote URL.

#### Scenario: Chart.js loaded from extension bundle
- **WHEN** the dashboard loads the chart library
- **THEN** it loads `dist/chart-bundle.js` via `asWebviewUri`, not an `https://` CDN URL
