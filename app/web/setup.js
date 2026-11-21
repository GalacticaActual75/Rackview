export function setupGuide({ $, request, display, getState, disconnect }) {
  const sources = ['idrac', 'nas', 'console'];
  const progress = [
    'Choose the readings or features you want on this server.',
    'Enable IPMI over LAN in iDRAC. Enter its management address and login, test the connection, then save it.',
    'Create a TrueNAS Readonly Admin user and an API key for that user. Enter the HTTPS URL, test access, then save the connection.',
    'Enable VNC in iDRAC and set a VNC password. Open VNC setup for the steps for your iDRAC version, then connect to verify the screen.',
  ];
  const panels = sources.map(id => $(id + '-settings'));
  const slots = panels.map(panel => {
    const slot = document.createComment('Connection settings');
    panel.before(slot);
    return slot;
  });
  let selected = [];
  let index = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem('rackview.setup'));
    if (Array.isArray(saved?.selected)) selected = sources.filter(id => saved.selected.includes(id));
    if (Number.isInteger(saved?.index)) index = saved.index;
  } catch {}
  for (const id of sources) $('want-' + id).checked = selected.includes(id);
  let finishing = false;
  function steps() {
    return sources.filter(id => selected.includes(id) || (id === 'idrac' && selected.includes('console')));
  }
  function restore() {
    panels.forEach((panel, i) => { if (panel.parentNode !== slots[i].parentNode) slots[i].after(panel); });
  }
  function render() {
    const order = steps();
    index = Math.max(0, Math.min(index, order.length));
    const id = order[index - 1];
    restore();
    $('setup-choices').hidden = !!id;
    if (id) $('setup-panel').append($(id + '-settings'));
    $('setup-progress').textContent = id ? `Step ${index} of ${order.length} · ${progress[sources.indexOf(id) + 1]}` : progress[0];
    $('setup-back').hidden = !id;
    $('setup-next').disabled = !id && !selected.length;
    $('setup-next').textContent = id && index === order.length ? 'Finish setup' : 'Continue';
    $('setup-skip').textContent = id ? 'Skip this step' : 'Set up later';
    display('setup-error', '');
    sessionStorage.setItem('rackview.setup', JSON.stringify({ selected, index }));
  }
  async function advance(skip) {
    if (finishing) return;
    const order = steps();
    const id = order[index - 1];
    const state = getState();
    if (!state) return display('setup-error', 'Wait for Rackview to load, then try again.', 'error');
    if (!skip && ((id === 'idrac' && !state.connection) || (id === 'nas' && !state.nas) ||
      (id === 'console' && !state.consoleProfiles?.length && !$('vnc-profiles').value))) {
      return display('setup-error', id === 'console' ? 'Connect to the console or skip this step.' : 'Save the connection or skip this step.', 'error');
    }
    if ((!index && skip) || index === order.length) {
      finishing = true;
      try {
        await request('/api/setup/complete', {});
        state.setupRequired = false;
        sessionStorage.removeItem('rackview.setup');
        index = 0;
        location.hash = 'overview';
      } catch (error) { display('setup-error', error.message, 'error'); }
      finally { finishing = false; }
    } else {
      index++;
      render();
    }
  }
  $('setup-choices').addEventListener('change', () => {
    selected = sources.filter(id => $('want-' + id).checked);
    render();
  });
  $('setup-next').addEventListener('click', () => advance(false));
  $('setup-skip').addEventListener('click', () => advance(true));
  $('setup-back').addEventListener('click', () => { if (!finishing) { disconnect(); index--; render(); } });
  $('setup-launch').addEventListener('click', () => { index = 0; location.hash = 'setup'; });
  return { render, restore };
}
