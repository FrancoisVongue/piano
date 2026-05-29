import { venum } from 'venum';
import { Files } from '@piano/shared';
import {
  daemonCommand,
  DaemonResult,
  noDaemonForMachine,
  targetForMachine,
} from '../../services/daemon.adapter';

// Reshape `ok` payload while propagating daemon-failure tags untouched.
const onOk = <U>(result: DaemonResult<any>, transform: (response: any) => U): DaemonResult<U> =>
  result.tag === 'ok' ? venum('ok', transform(result.data)) : result;

// FileController is the file-browser counterpart to MachineController. The
// daemon exposes `command:fs-list` / `command:fs-read`; we look up which
// daemon owns this machine (multi-daemon routing) and dispatch.
export class FileController {
  static async list(userId: string, machineId: string, path: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(
      target,
      { type: 'command:fs-list', machineId, data: { path } },
      'machine:fs-list',
      { fallbackMsg: 'List failed', timeoutMs: 10000 },
    );
    return onOk(r, (response): Files.ListResult => ({
      path: response?.data?.path || '',
      entries: response?.data?.entries || [],
    }));
  }

  static async read(userId: string, machineId: string, path: string, maxBytes?: number) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(
      target,
      { type: 'command:fs-read', machineId, data: { path, maxBytes: maxBytes ?? 1024 * 1024 } },
      'machine:fs-read',
      { fallbackMsg: 'Read failed', timeoutMs: 15000 },
    );
    return onOk(r, (response): Files.ReadResult => {
      const d = response?.data ?? {};
      const base = {
        path: d.path || path,
        sizeBytes: Number(d.sizeBytes ?? 0),
        mime: d.mime || 'application/octet-stream',
      };
      // Daemon decides the kind based on extension + magic-number sniff —
      // we just narrow the wire shape to the discriminated union. Unknown
      // kinds collapse to 'binary' so old daemons don't crash the parser.
      if (d.kind === 'text') {
        return {
          ...base,
          kind: 'text',
          truncated: !!d.truncated,
          content: typeof d.content === 'string' ? d.content : '',
        };
      }
      if (d.kind === 'image' && typeof d.dataBase64 === 'string') {
        return {
          ...base,
          kind: 'image',
          truncated: false,
          dataBase64: d.dataBase64,
        };
      }
      return {
        ...base,
        kind: 'binary',
        truncated: !!d.truncated,
        dataBase64: typeof d.dataBase64 === 'string' ? d.dataBase64 : undefined,
      };
    });
  }
}
