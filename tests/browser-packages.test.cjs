const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const root = resolve(__dirname, '..');

function manifest(folder) {
  return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
}

test('all four browser packages share the YouTube-only implementation and exact published bridge identities', () => {
  const output = mkdtempSync(join(tmpdir(), 'online-subtitle-browser-tests-'));
  try {
    execFileSync('python3', [join(root, 'scripts/build-browser-companions.py'), '--output', output]);
    const version = JSON.parse(readFileSync(join(root, 'MacHelperExtension/extension.json'), 'utf8')).version;
    const chrome = manifest(join(output, 'chrome'));
    assert.deepEqual(manifest(join(output, 'edge')), chrome);
    assert.deepEqual(chrome.background, { service_worker: 'managed-background.js' });
    const extensionID = createHash('sha256').update(Buffer.from(chrome.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCodePoint(97 + Number.parseInt(digit, 16)));
    assert.equal(extensionID, 'ndmbmmhddeibbojclldpaabmkcielfmj');

    const firefox = manifest(join(output, 'firefox'));
    const safari = manifest(join(output, 'safari'));
    assert.equal(firefox.browser_specific_settings.gecko.id, 'online-subtitle@nelson007.com');
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ['websiteContent']);
    assert.deepEqual(firefox.background.scripts, ['managed-transport.js', 'background.js']);
    assert.equal(safari.browser_specific_settings.safari.strict_min_version, '18.0');
    assert.deepEqual(safari.background.scripts, ['browser-flags.js', 'managed-transport.js', 'background.js']);
    for (const browser of ['chrome', 'edge', 'firefox', 'safari']) {
      const folder = join(output, browser);
      const entry = manifest(folder);
      assert.equal(entry.version, version);
      assert.deepEqual(entry.permissions, ['nativeMessaging']);
      for (const block of entry.content_scripts) {
        assert.deepEqual(block.matches, ['https://www.youtube.com/*']);
        for (const asset of [...block.js, ...(block.css || [])]) {
          assert.deepEqual(readFileSync(join(folder, asset)), readFileSync(join(root, 'Chrome', asset)));
        }
      }
      assert.equal(entry.content_scripts[0].world, 'MAIN');
    }
    for (const [browser, filename] of [['chrome', 'chromium-companion.json'], ['firefox', 'firefox-companion.json']]) {
      const inventory = JSON.parse(readFileSync(join(output, filename)));
      assert.equal(inventory.schemaVersion, 1);
      for (const [file, base64] of Object.entries(inventory.files)) {
        assert.deepEqual(Buffer.from(base64, 'base64'), readFileSync(join(output, browser, file)));
      }
    }
  } finally {
    rmSync(output, { recursive: true });
  }
});
