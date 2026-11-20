import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { pipeline } from 'node:stream';
import { connect as connectTls } from 'node:tls';

const ticketPattern = /^\/api\/console\/ws\?ticket=([\w-]{43})$/;

export function installConsole(server, ws, currentRevision) {
  const listener = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const tickets = new Map();
  let active = false;

  server.on('upgrade', (request, socket, head) => {
    const match = ticketPattern.exec(request.url);
    const ticket = match && tickets.get(match[1]);
    if (match) tickets.delete(match[1]);
    if (!ticket || ticket.expires < Date.now() || ticket.revision !== currentRevision() || active) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    listener.handleUpgrade(request, socket, head, (client) => {
      active = true;
      const { host, port, encrypted, fingerprint } = ticket;
      const target = encrypted ? connectTls({ host, port, rejectUnauthorized: !fingerprint })
        : createConnection({ host, port });
      const duplex = ws.createWebSocketStream(client);
      duplex.on('error', () => target.destroy());
      target.setTimeout(8_000, () => target.destroy());
      target.once('close', () => { active = false; });
      target.once('error', () => duplex.destroy());
      client.once('close', () => target.destroy());

      target.once(encrypted ? 'secureConnect' : 'connect', () => {
        if (fingerprint && target.getPeerCertificate().fingerprint256?.replaceAll(':', '').toUpperCase() !== fingerprint) {
          target.destroy();
          return;
        }
        target.setTimeout(0);
        pipeline(target, duplex, () => {});
        pipeline(duplex, target, () => {});
      });
      target.once('close', () => duplex.destroy());
    });
  });

  return (target) => {
    for (const [key, ticket] of tickets) {
      if (ticket.expires < Date.now()) tickets.delete(key);
    }
    if (active) return null;
    if (tickets.size >= 16) tickets.delete(tickets.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    tickets.set(token, { ...target, expires: Date.now() + 30_000 });
    return token;
  };
}
