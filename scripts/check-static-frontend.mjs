import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, configText] = await Promise.all([
  readFile(new URL('../pi/tauri/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../pi/tauri/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
]);
const config = JSON.parse(configText);

assert.match(html, /<script\s+type="module"\s+src="\.\/app\.js"><\/script>/);
assert.equal(config.build.frontendDist, '../pi/tauri');
assert.equal(config.app?.withGlobalTauri, true);
assert.match(app, /window\.__TAURI__\?\.core\?\.invoke/);
assert.doesNotMatch(app, /^\s*import\s+.*from\s+['"][^./][^'"]*['"]/m,
  'static frontend must not contain unresolved bare module imports');

console.log('Unbundled Tauri frontend configuration check passed');
