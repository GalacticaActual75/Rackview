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
      $('nas-status').textContent = state.nas ? 'Reading storage pools and alerts…' : 'Connect TrueNAS to view storage pools and alerts.';
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
