function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${Number(value.toFixed(1))} ${units[i]}`;
}

export function setupNas({ $, request, display, refresh }) {
  let revision;
  let busy = false;
  let pendingRead;

  function render(data) {
    const system = data.system ?? {};
    const sample = data.sample ?? {};
    const rate = value => Number.isFinite(value) ? `${bytes(value)}/s` : '—';
    const stats = [];
    if (system.model) stats.push(['Processor', system.model]);
    if (Number.isFinite(sample.cpu)) stats.push(['CPU usage', `${Number(sample.cpu.toFixed(1))}%`]);
    if (Number.isFinite(sample.ramTotal)) stats.push(['Total RAM', bytes(sample.ramTotal)]);
    if (Number.isFinite(sample.ramAvailable)) stats.push(['Available RAM', bytes(sample.ramAvailable)]);
    if (Number.isFinite(sample.arc)) stats.push(['ZFS ARC cache', bytes(sample.arc)]);
    if (Number.isFinite(sample.diskRead)) stats.push(['Disk read', rate(sample.diskRead)]);
    if (Number.isFinite(sample.diskWrite)) stats.push(['Disk write', rate(sample.diskWrite)]);
    if (Number.isFinite(system.uptime)) {
      const minutes = Math.floor(system.uptime / 60);
      stats.push(['Uptime', `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h ${minutes % 60}m`]);
    }
    if (system.version) stats.push(['TrueNAS version', system.version]);
    $('nas-stats').replaceChildren(...stats.map(([label, value]) => {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      item.append(term, description);
      return item;
    }));
    $('nas-sample-note').hidden = !!data.sample;
    const interfaces = sample.interfaces ?? [];
    $('nas-network').hidden = !interfaces.length;
    $('nas-interfaces').replaceChildren(...interfaces.map(nic => {
      const row = document.createElement('tr');
      const link = { LINK_STATE_UP: 'Up', LINK_STATE_DOWN: 'Down' }[nic.state] ?? '—';
      for (const value of [nic.name, link, rate(nic.received), rate(nic.sent)]) row.insertCell().textContent = value;
      return row;
    }));
    $('nas-pools').replaceChildren(...data.pools.map(p => {
      const row = document.createElement('tr');
      const scan = p.scan;
      const progress = Number.isFinite(scan?.percent) ? ` ${Math.round(scan.percent)}%` : '';
      const health = p.healthy === false && p.status === 'ONLINE' ? 'ONLINE · needs attention' : p.status;
      for (const text of [p.name, health, bytes(p.allocated), bytes(p.free), scan ? `${scan.type} · ${scan.state || 'Unknown'}${progress}` : 'Idle']) {
        row.insertCell().textContent = text;
      }
      return row;
    }));
    const messages = data.alerts.map(a => `${a.level} · ${a.message}`);
    if (!messages.length) messages.push('No active alerts.');
    $('nas-alerts').replaceChildren(...messages.map(message => {
      const li = document.createElement('li');
      li.textContent = message;
      return li;
    }));
    $('nas-status').textContent = `${data.pools.length} pools · Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    $('nas-data').hidden = false;
  }

  function update(state) {
    if (revision !== state.nasRevision) {
      revision = state.nasRevision;
      $('nas-url').value = state.nas?.url ?? '';
      $('nas-user').value = state.nas?.user ?? '';
      $('nas-pin').value = state.nas?.fingerprint ?? '';
      $('nas-key').value = '';
      $('nas-key').required = !state.nas;
      $('nas-key').placeholder = state.nas ? 'Use saved key' : '';
      $('nas-data').hidden = true;
      $('nas-status').textContent = state.nas ? 'Reading system stats, storage pools, and alerts…' : 'Connect TrueNAS to view system stats, storage pools, and alerts.';
    }
    $('nas-test').disabled = $('nas-save').disabled = busy;
    if (!state.nas || pendingRead === revision) return;
    const current = revision;
    pendingRead = current;
    request('/api/truenas/status').then(data => {
      if (current === revision) render(data);
    }).catch(error => {
      if (current === revision) {
        $('nas-status').textContent = error.message;
        $('nas-data').hidden = true;
      }
    }).finally(() => { if (pendingRead === current) pendingRead = undefined; });
  }

  async function configure(save) {
    if (busy || !$('nas-form').reportValidity()) return;
    busy = true;
    $('nas-test').disabled = $('nas-save').disabled = true;
    display('nas-result', 'Verifying read-only access…');
    try {
      const data = await request(save ? '/api/truenas/save' : '/api/truenas/test', {
        revision, url: $('nas-url').value, user: $('nas-user').value, fingerprint: $('nas-pin').value, key: $('nas-key').value,
      });
      if (save) { $('nas-key').value = ''; await refresh(); }
      display('nas-result', `${save ? 'Connection saved' : 'Read-only access verified'}. ${data.pools} pools, ${data.alerts} active alerts.`, 'success');
    } catch (error) { display('nas-result', error.message, 'error'); }
    finally { busy = false; $('nas-test').disabled = $('nas-save').disabled = false; }
  }
  $('nas-test').addEventListener('click', () => configure(false));
  $('nas-form').addEventListener('submit', event => { event.preventDefault(); configure(true); });
  return { update };
}
