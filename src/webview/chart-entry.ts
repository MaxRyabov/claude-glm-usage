// WebView entry point: bundles Chart.js locally (H-2) so the dashboard no longer
// loads it from an external CDN. webpack builds this with target: 'web' into
// dist/chart-bundle.js, which the panel loads via asWebviewUri under a strict CSP.
import Chart from 'chart.js/auto';

(window as unknown as { Chart: typeof Chart }).Chart = Chart;
