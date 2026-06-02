import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// __dirname at runtime: <root>/out/test/suite → repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

suite('package.json manifest hardening', () => {
  test('credentials.path setting is machine-scoped (M-4)', () => {
    const setting =
      pkg.contributes.configuration.properties['claudeStatus.credentials.path'];
    assert.strictEqual(setting.scope, 'machine');
  });

  test('chart.js is a bundled dependency, not a CDN load (H-2)', () => {
    assert.ok(
      pkg.dependencies && pkg.dependencies['chart.js'],
      'chart.js must be listed in dependencies',
    );
  });
});
