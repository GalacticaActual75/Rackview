export function setupConsole({ $, request, display, getStatus }) {
  let viewer;
  let connecting = false;
  let connected = false;
  let attempt = 0;
  let failure = '';
  let consoleRevision;

  function update() {
    const state = getStatus();
    if (viewer && state?.revision !== consoleRevision) disconnect();
    $('start-console').disabled = connecting || !state?.connection || !state.consoleAvailable;
    $('console-form').hidden = !!viewer;
    $('console-screen').hidden = !viewer;
    $('console-actions').hidden = !viewer;
    $('fullscreen-console').disabled = !connected;
    $('console-cad').disabled = !connected;
    $('console-status').textContent = connected ? 'Connected' : connecting ? 'Connecting…'
      : !state?.connection ? 'Save an iDRAC connection first' : !state.consoleAvailable ? 'Console bridge unavailable' : 'Disconnected';
  }

  function disconnect() {
    if (!viewer && !connecting) return;
    attempt++;
    viewer?.disconnect();
    viewer = null;
    connected = false;
    connecting = false;
    $('console-screen').replaceChildren();
    update();
  }

  $('console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (connecting || viewer) return;
    const currentAttempt = ++attempt;
    const password = $('vnc-password').value;
    const encrypted = $('vnc-tls').checked;
    consoleRevision = getStatus().revision;
    failure = '';
    connecting = true;
    update();
    display('console-result', '');
    try {
      const { default: RFB } = await import('/novnc/core/rfb.js');
      if (attempt !== currentAttempt) return;
      const data = await request('/api/console/ticket', {
        port: $('vnc-port').valueAsNumber,
        encrypted,
        fingerprint: encrypted ? $('vnc-fingerprint').value : '',
        revision: consoleRevision,
      });
      if (attempt !== currentAttempt) return;
      const url = new URL(`/api/console/ws?ticket=${data.ticket}`, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const session = new RFB($('console-screen'), url.href, { credentials: { password } });
      viewer = session;
      $('vnc-password').value = '';
      session.scaleViewport = true;
      session.background = '#090b0e';
      session.addEventListener('connect', () => {
        if (viewer !== session) return;
        connecting = false;
        connected = true;
        update();
      });
      session.addEventListener('securityfailure', (event) => {
        failure = event.detail.reason || 'The iDRAC rejected VNC authentication.';
      });
      session.addEventListener('credentialsrequired', () => {
        failure = 'The iDRAC requested a different VNC authentication method.';
        session.disconnect();
      });
      session.addEventListener('disconnect', (event) => {
        if (viewer !== session) return;
        viewer = null;
        const wasConnected = connected;
        connecting = false;
        connected = false;
        $('console-screen').replaceChildren();
        update();
        if (failure || !event.detail.clean) {
          display('console-result', failure || (wasConnected ? 'The VNC session ended unexpectedly.' : 'Could not establish VNC. Check the port, TLS settings, fingerprint, and whether another viewer is connected.'), 'error');
        }
      });
      update();
    } catch (error) {
      if (attempt !== currentAttempt) return;
      disconnect();
      display('console-result', error.message, 'error');
    }
  });
  $('vnc-tls').addEventListener('change', () => { $('fingerprint-label').hidden = !$('vnc-tls').checked; });
  $('disconnect-console').addEventListener('click', disconnect);
  $('fullscreen-console').addEventListener('click', async () => {
    try {
      await $('console-screen').requestFullscreen();
      viewer?.focus();
    } catch {
      display('console-result', 'Full screen is unavailable in this browser.', 'error');
    }
  });
  $('console-cad').addEventListener('click', () => viewer?.sendCtrlAltDel());
  $('vnc-help').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('vnc-help').open = false;
      $('vnc-help').querySelector('summary').focus();
    }
  });
  return { update, disconnect };
}
