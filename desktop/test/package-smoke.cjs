const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = process.argv[4];
assert.ok(profile, 'Supply an isolated temporary userData directory');
assert.ok(['write', 'restart', 'deleted'].includes(process.argv[2]), 'Use write, restart or deleted');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const phase = process.argv[2];
const archive = process.argv[3];
assert.ok(archive?.endsWith('app.asar'));
const entry = path.join(archive, '.vite/build/main.js');
const nativeModule = require.resolve('better-sqlite3', { paths: [path.dirname(entry)] });
assert.ok(nativeModule.startsWith(archive + '/'), 'Native dependency must resolve inside the copied package');
console.log('PACKAGED_NATIVE_MODULE', nativeModule);
let rendererError;
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (event) => { if (event.level === 'error') rendererError = event.message; });
  win.webContents.on('preload-error', (_event, location, error) => { rendererError = error.message; });
  win.webContents.on('did-fail-load', (_event, code, description) => { console.error('LOAD_FAIL', code, description); app.exit(1); });
  win.webContents.on('did-finish-load', () => setTimeout(async () => {
    try {
      assert.equal(rendererError, undefined, rendererError);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const status = await window.diagnostics.status();
        const base = { heading: document.querySelector('h1')?.textContent, status, node: typeof window.require, phase: ${JSON.stringify(phase)} };
        if (${JSON.stringify(phase)} === 'write') return { ...base, write: await window.diagnostics.writeFixture('packaged-mac-restart-fixture'), canary: await window.diagnostics.credentialRoundTrip() };
        if (${JSON.stringify(phase)} === 'restart') return { ...base, read: await window.diagnostics.readFixture(), canary: await window.diagnostics.credentialRoundTrip(), replace: await window.diagnostics.replaceCredentialCanary(), clear: await window.diagnostics.deleteFixtures() };
        return { ...base, read: await window.diagnostics.readFixture() };
      })()`);
      assert.equal(result.heading, 'Desktop foundation check');
      assert.equal(result.node, 'undefined');
      assert.equal(result.status.ok, true);
      assert.equal(result.status.value.database, 'ready');
      assert.equal(result.status.value.foreignKeysEnabled, true);
      assert.equal(result.status.value.rollbackVerified, true);
      if (phase === 'write') { assert.equal(result.write.ok, true); assert.equal(result.canary.ok, true); }
      if (phase === 'restart') { assert.equal(result.read.value.value, 'packaged-mac-restart-fixture'); assert.equal(result.canary.value.retrievedExisting, true); assert.equal(result.replace.value.replaced, true); assert.equal(result.clear.ok, true); }
      if (phase === 'deleted') { assert.equal(result.read.value.value, null); assert.equal(result.status.value.credentialFilePresent, false); }
      console.log('PACKAGE_SMOKE_PASS', JSON.stringify(result));
      app.quit();
    } catch (error) { console.error('PACKAGE_SMOKE_FAIL', error); app.exit(1); }
  }, 1500));
});
setTimeout(() => { console.error('PACKAGE_SMOKE_TIMEOUT'); app.exit(1); }, 30000);
require(entry);
