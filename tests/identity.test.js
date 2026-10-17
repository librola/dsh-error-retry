import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { name } from '../index.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('包名、客户端模块、插件页与配置命名空间保持一致', () => {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const client = read('client.js');
  const patch = read('cordis.patch.yml');
  assert.equal(manifest.name, '@local/dsh-error-retry');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.ok(client.includes(`id: '${manifest.name}'`));
  assert.ok(client.includes(`key: '${manifest.name}'`));
  assert.ok(patch.includes(`name: '${manifest.name}'`));
  assert.equal(name, 'error-retry');
  assert.ok(patch.includes(`id: ${name}`));
  assert.ok(patch.includes('rules: []'));
  assert.equal(manifest.repository.url, 'git+https://github.com/librola/dsh-error-retry.git');
  assert.ok(client.includes(`configForms.get('${name}')`));
  assert.equal(JSON.parse(read('locale/zh.json')).meta.title, '规则重试');
  assert.equal(JSON.parse(read('locale/en.json')).meta.title, 'Retry Rules');
});
