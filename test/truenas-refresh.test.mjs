import assert from 'node:assert/strict';
import test from 'node:test';
import { setupNas } from '../app/web/truenas.js';

test('TrueNAS keeps the last readings during a slow or failed refresh and clears them on a target change', async t => {
  class Element {
    addEventListener() {}
    append() {}
    replaceChildren() {}
  }
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = { createElement: () => new Element() };
  t.after(() => { delete globalThis.document; });
  let pending;
  const view = setupNas({ $, request: () => new Promise((resolve, reject) => { pending = { resolve, reject }; }) });
  const state = { nasRevision: 'a', nas: { url: 'https://storage.example', user: 'reader' } };
  const data = { updatedAt: 1000, pools: [], alerts: [], sample: { cpu: 12, ramAvailable: 1024 } };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  view.update(state);
  pending.resolve(data);
  await flush();
  view.update(state);
  assert.equal($('nas-data').hidden, false);
  pending.reject(new Error('Connection timed out.'));
  await flush();
  assert.match($('nas-status').textContent, /Last updated.*Connection timed out/);
  assert.equal($('nas-cpu-card').hidden, false);
  assert.equal($('nas-data').hidden, false);
  view.update(state);
  pending.resolve({ ...data, updatedAt: 2000, sample: null });
  await flush();
  assert.equal($('nas-cpu').textContent, 12);
  assert.equal($('nas-memory-card').hidden, false);
  assert.match($('nas-status').textContent, /Performance readings delayed/);
  view.update({ ...state, nasRevision: 'b' });
  assert.equal($('nas-data').hidden, false);
  view.update({ nasRevision: 'c', nas: { ...state.nas, url: 'https://other.example' } });
  assert.equal($('nas-data').hidden, true);
  assert.equal($('nas-cpu-card').hidden, true);
});
