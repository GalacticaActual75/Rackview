import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const MANUAL = ['raw', '0x30', '0x30', '0x01', '0x00'];
export const AUTOMATIC = ['raw', '0x30', '0x30', '0x01', '0x01'];

export function speedCommand(percent) {
  return ['raw', '0x30', '0x30', '0x02', '0xff', `0x${percent.toString(16).padStart(2, '0')}`];
}

export async function ipmi(connection, args) {
  const { host, user, password } = connection;
  try {
    const { stdout } = await exec('ipmitool', [
      '-I', 'lanplus', '-H', host, '-U', user, '-E', '-N', '2', '-R', '2', ...args,
    ], {
      env: { PATH: process.env.PATH, LC_ALL: 'C', IPMI_PASSWORD: password },
      timeout: args.includes('sdr') ? 30_000 : 10_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('ipmitool is unavailable.');
    if (error.killed) throw new Error('The IPMI command timed out.');
    const detail = error.stderr?.replaceAll(password, '[redacted]').trim().slice(0, 500);
    throw new Error(detail || 'The IPMI command failed.');
  }
}

export function parseSensors(output) {
  const rows = [];
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split('|').map((field) => field.trim());
    const [name, number, status, entity, label] = fields;
    if (fields.length !== 5 || !name || !/^[\da-f]{2}h$/i.test(number) || !/^\d+\.\d+$/.test(entity)) continue;
    const unavailable = /^(?:no reading|disabled|not readable)$/i.test(label) || status === 'ns' && !label;
    const measurement = /^(-?\d+(?:\.\d+)?)\s+([^,]+?)(?:,\s*(.+))?$/.exec(label);
    const value = measurement ? Number(measurement[1]) : null;
    const unit = measurement?.[2] ?? '';
    const reading = unavailable ? null : label || 'No named state reported';
    // For discrete sensors ipmitool's "ok" means a valid read, even for an asserted fault.
    const displayStatus = unavailable ? 'na' : status === 'ok' && (!measurement || measurement[3]) ? 'reported' : status;
    const kind = /\bRPM\b/i.test(unit) || /^fan\s*\d/i.test(name) ? 'fan'
      : /degrees [CFK]/i.test(unit) ? 'temperature' : 'other';
    rows.push({ name, number, entity, reading, value, unit, state: measurement?.[3], status: displayStatus, kind });
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const row of rows) {
    if (counts.get(row.name) > 1) row.name += ` (entity ${row.entity}, sensor ${row.number})`;
  }
  return rows;
}

export function parseController(output) {
  const details = {};
  for (const line of output.split(/\r?\n/)) {
    const pair = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
    if (pair) details[pair[1].trim()] = pair[2].trim();
  }
  if (!details['Firmware Revision'] || !details['IPMI Version']) {
    throw new Error('The controller returned incomplete identification data.');
  }
  return details;
}
