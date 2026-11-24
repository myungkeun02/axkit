import { isIP } from 'node:net';

/** All addresses a host name resolves to. Injected so tests never touch DNS. */
export type Lookup = (host: string) => Promise<string[]>;

const BLOCKED_EXACT = new Set(['localhost', 'local', 'internal', 'home.arpa']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;

function ipv4Public(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // 224/4 multicast plus the reserved 240/4 block.
  if (a >= 224) return false;
  return true;
}

function dottedToGroups(address: string): number[] | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4) return undefined;
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
}

function groupsOf(part: string | undefined): number[] | undefined {
  if (part === undefined || part === '') return [];
  const segments = part.split(':');
  const groups: number[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment.includes('.')) {
      if (index !== segments.length - 1) return undefined;
      const pair = dottedToGroups(segment);
      if (pair === undefined) return undefined;
      groups.push(...pair);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return undefined;
    groups.push(Number.parseInt(segment, 16));
  }
  return groups;
}

function ipv6Groups(address: string): number[] | undefined {
  const bare = (address.split('%')[0] ?? '').toLowerCase();
  const pieces = bare.split('::');
  if (pieces.length > 2) return undefined;
  const head = groupsOf(pieces[0]);
  const tail = pieces.length === 2 ? groupsOf(pieces[1]) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (pieces.length === 1) return head.length === 8 ? head : undefined;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return undefined;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function ipv6Public(groups: readonly number[]): boolean {
  if (groups.every((group) => group === 0)) return false;
  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (mapped || compatible) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return ipv4Public(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return true;
}

export function isPublicAddress(address: string): boolean {
  const bare = address.split('%')[0] ?? address;
  const family = isIP(bare);
  if (family === 4) return ipv4Public(bare);
  if (family === 6) {
    const groups = ipv6Groups(bare);
    return groups !== undefined && ipv6Public(groups);
  }
  return false;
}

export function hostOf(url: URL): string {
  const raw = url.hostname;
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return bare.toLowerCase().replace(/\.$/, '');
}

function blockedHostname(host: string): boolean {
  if (BLOCKED_EXACT.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Refuses anything that is not a public http(s) address. Errors never echo the URL because it can carry a query
 * string with private values.
 */
export async function assertPublicUrl(url: URL, lookup: Lookup): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses are supported.');
  }
  if (url.username !== '' || url.password !== '') throw new Error('This address is not allowed.');
  const host = hostOf(url);
  if (host === '' || blockedHostname(host)) throw new Error('This address is not allowed.');
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new Error('This address is not allowed.');
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error('Could not resolve this address.');
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new Error('This address is not allowed.');
  }
}
