/**
 * Save a generated file. Inside a claude.ai Artifact viewer, plain downloads
 * are blocked, so the `downloads` capability is used when present; otherwise
 * a normal browser download is triggered.
 */

type DownloadsNs = { save(r: { filename: string; data: Blob | string | ArrayBuffer }): Promise<unknown> };
type ClaudeHost = { use(name: string): Promise<unknown> };

let nsPromise: Promise<DownloadsNs | null> | null = null;
function hostDownloads(): Promise<DownloadsNs | null> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (!host?.use) return Promise.resolve(null);
  nsPromise ??= host.use('downloads').then((n) => (n as DownloadsNs) ?? null).catch(() => null);
  return nsPromise;
}

/** Extensions the artifact viewer accepts; others are wrapped in a zip. */
const HOST_OK = /\.(png|jpg|jpeg|json|csv|txt|md|svg|html|zip|pdf)$/i;

export async function saveFile(filename: string, data: Blob): Promise<'saved' | 'declined' | 'failed'> {
  const ns = await hostDownloads();
  if (ns) {
    let name = filename;
    let blob = data;
    if (!HOST_OK.test(filename)) {
      blob = zipStore([{ name: filename, data: new Uint8Array(await data.arrayBuffer()) }]);
      name = filename.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await ns.save({ filename: name, data: blob });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return code === 'declined' ? 'declined' : 'failed';
    }
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'saved';
}

// ---- minimal ZIP writer (stored, no compression) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, f.data as BlobPart);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    const c = new Uint8Array(46 + name.length);
    c.set(new Uint8Array(cen.buffer), 0);
    c.set(name, 46);
    central.push(c);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: 'application/zip' });
}
