import { bytes } from './truenas.js';

export function sortApps(apps, metric) {
  const value = app => Number.isFinite(app[metric]) ? app[metric] : -1;
  return [...apps].sort((a, b) =>
    Number(b.state === 'CRASHED') - Number(a.state === 'CRASHED') ||
    value(b) - value(a) || a.name.localeCompare(b.name));
}

function usage(label, value, maximum, format) {
  const cell = document.createElement('div');
  cell.className = 'app-usage';
  const caption = document.createElement('span');
  const reading = document.createElement('strong');
  caption.textContent = label;
  reading.textContent = Number.isFinite(value) ? format(value) : '—';
  cell.append(caption, reading);
  if (Number.isFinite(value)) {
    const bar = document.createElement('progress');
    bar.max = maximum || 1;
    bar.value = value;
    bar.setAttribute('aria-hidden', 'true');
    cell.append(bar);
  }
  return cell;
}

function appRow(app, maxCpu, maxMemory, detailed) {
  const row = document.createElement('li');
  const title = document.createElement('div');
  title.className = 'app-name';
  const name = document.createElement('strong');
  name.textContent = app.name;
  const badge = document.createElement('span');
  badge.className = 'sensor-status';
  if (app.state === 'CRASHED') badge.classList.add('crashed');
  if (app.state === 'RUNNING') badge.classList.add('good');
  const state = app.state || 'Unknown';
  badge.textContent = state[0] + state.slice(1).toLowerCase();
  title.append(name, badge);
  if (detailed) {
    const version = document.createElement('small');
    version.textContent = [app.version, app.update && 'Update available'].filter(Boolean).join(' · ');
    title.append(version);
  }
  row.append(title, usage('CPU', app.cpu, maxCpu, v => v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'),
    usage('Memory', app.memory, maxMemory, bytes));
  return row;
}

export function setupApps({ $, request }) {
  const selectors = [$('apps-sort'), $('overview-apps-sort')];
  let metric = localStorage.getItem('rackview.apps.sort') === 'memory' ? 'memory' : 'cpu';
  let snapshot;
  let revision;
  let pending;
  let target;
  function status(text) {
    $('apps-status').textContent = $('overview-apps-status').textContent = text;
  }
  function render() {
    const sorted = sortApps(snapshot?.apps ?? [], metric);
    const maxCpu = sorted.reduce((max, app) => Math.max(max, app.cpu ?? 0), 0);
    const maxMemory = sorted.reduce((max, app) => Math.max(max, app.memory ?? 0), 0);
    $('apps-list').replaceChildren(...sorted.map(app => appRow(app, maxCpu, maxMemory, true)));
    $('overview-apps-list').replaceChildren(...sorted.slice(0, 3).map(app => appRow(app, maxCpu, maxMemory, false)));
    for (const select of selectors) {
      select.value = metric;
      select.disabled = sorted.length < 2;
    }
  }
  for (const select of selectors) select.addEventListener('change', () => {
    metric = select.value;
    localStorage.setItem('rackview.apps.sort', metric);
    render();
  });
  function update(state) {
    const nextTarget = state.nas && JSON.stringify([state.nas.url, state.nas.user, state.nas.fingerprint]);
    if (revision !== state.nasRevision) {
      revision = state.nasRevision;
      if (!state.nas || nextTarget !== target) {
        target = nextTarget;
        snapshot = null;
        render();
        $('overview-apps-card').hidden = !state.nas;
        $('apps-setup').hidden = !!state.nas;
        status(state.nas ? 'Loading apps…' : 'Connect TrueNAS to view its apps.');
      }
    }
    if (!state.nas || pending === revision) return;
    const current = revision;
    pending = current;
    request('/api/truenas/apps').then(data => {
      if (current !== revision) return;
      if (snapshot?.updatedAt !== data.updatedAt) {
        snapshot = data;
        render();
      }
      const crashed = data.apps.filter(app => app.state === 'CRASHED').length;
      const count = data.apps.length;
      const summary = count ? `${count} installed · ${crashed} crashed` : 'No installed TrueNAS apps.';
      status([summary, !data.usageAvailable && 'Usage unavailable', new Date(data.updatedAt).toLocaleTimeString()].filter(Boolean).join(' · '));
    }).catch(error => {
      if (current === revision) status(snapshot ? `Last updated ${new Date(snapshot.updatedAt).toLocaleTimeString()} · ${error.message}` : error.message);
    }).finally(() => { if (pending === current) pending = undefined; });
  }
  return { update };
}
