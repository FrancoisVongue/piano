import { venum } from 'venum';
import { Prisma } from '@prisma/client';
import { services } from '../../services/init';
import config from '../../config';
import { Daemon } from '@piano/shared';
import { sha256Hex } from '../../shared/lib/sha256';
import { routeForMachine } from '../../services/daemon.adapter';

type DaemonRow = Daemon.DbRow;

const overlayStatus = (userId: string, row: DaemonRow) => {
  const onlineIds = services.daemon.getOnlineDaemonIds(userId);
  return Daemon.toModel({
    ...row,
    status: !row.isPaused && onlineIds.has(row.id) ? 'ONLINE' : 'OFFLINE',
  });
};

class PoolExhaustedError extends Error {}
class ConsumedConcurrentlyError extends Error {}

async function allocateSshPort(
  tx: Pick<typeof services.prisma, 'daemon'>,
): Promise<number> {
  const taken = new Set(
    (await tx.daemon.findMany({
      where: { sshPort: { not: null } },
      select: { sshPort: true },
    })).map(d => d.sshPort).filter((p): p is number => p != null),
  );
  for (let p = config.sish.portRangeStart; p <= config.sish.portRangeEnd; p++) {
    if (!taken.has(p)) return p;
  }
  throw new PoolExhaustedError(
    `SSH port pool exhausted (${config.sish.portRangeStart}-${config.sish.portRangeEnd}). ` +
    `Bump PIANO_SISH_PORT_RANGE_END or delete unused daemons.`,
  );
}

export class DaemonController {
  static async list(userId: string) {
    const rows = await services.prisma.daemon.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const onlineIds = services.daemon.getOnlineDaemonIds(userId);
    return rows.map(r => Daemon.toModel({
      ...r,
      status: !r.isPaused && onlineIds.has(r.id) ? 'ONLINE' : 'OFFLINE',
    }));
  }

  static async createPairingCode(userId: string, dto: Daemon.DTO.CreatePairingCode) {
    const existing = await services.prisma.daemon.findFirst({
      where: { userId, name: dto.name },
    });
    if (existing) return venum('nameTaken', { message: `Daemon "${dto.name}" already exists` });

    await services.prisma.daemonPairingCode.deleteMany({
      where: { userId, name: dto.name, consumedAt: null },
    });

    const code = Daemon.generatePairingCode();
    const expiresAt = new Date(Date.now() + Daemon.PAIRING_CODE_TTL_MS);
    await services.prisma.daemonPairingCode.create({
      data: { code, name: dto.name, userId, expiresAt },
    });
    const model: Daemon.PairingCodeModel = { code, name: dto.name, expiresAt };
    return venum('ok', model);
  }

  static async pair(dto: Daemon.DTO.Pair) {
    const codeRow = await services.prisma.daemonPairingCode.findUnique({
      where: { code: dto.code },
    });
    if (!codeRow) return venum('notFound', { message: 'Invalid pairing code' });
    if (codeRow.consumedAt) return venum('consumed', { message: 'Code already used' });
    if (codeRow.expiresAt < new Date()) return venum('expired', { message: 'Code expired' });

    const token = Daemon.generateToken();
    const tokenHash = await sha256Hex(token);
    const sishHost = config.sish.host || null;

    let daemon;
    try {
      daemon = await services.prisma.$transaction(async tx => {
        const claim = await tx.daemonPairingCode.updateMany({
          where: { code: dto.code, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() },
        });
        if (claim.count === 0) throw new ConsumedConcurrentlyError();

        const sshPort = sishHost ? await allocateSshPort(tx) : null;
        return tx.daemon.create({
          data: {
            userId: codeRow.userId,
            name: codeRow.name,
            tokenHash,
            status: 'OFFLINE',
            sshPort,
            defaultWorkdir: dto.defaultWorkdir ?? null,
          },
        });
      });
    } catch (err) {
      if (err instanceof ConsumedConcurrentlyError) {
        return venum('consumed', { message: 'Code already used' });
      }
      if (err instanceof PoolExhaustedError) {
        return venum('portsExhausted', { message: err.message });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return venum('portsExhausted', {
          message: 'Couldn\'t allocate a unique daemon slot — retry pairing.',
        });
      }
      return venum('notFound', { message: 'Pairing code is no longer valid' });
    }

    return venum('ok', Daemon.toPairResult({ daemon, token, sishHost }));
  }

  static async update(userId: string, daemonId: string, dto: Daemon.DTO.Update) {
    const daemon = await services.prisma.daemon.findFirst({ where: { id: daemonId, userId } });
    if (!daemon) return venum('notFound', { message: 'Daemon not found' });

    const updated = await services.prisma.daemon.update({
      where: { id: daemonId },
      data: { name: dto.name },
    });
    return venum('ok', overlayStatus(userId, updated));
  }

  static async setPaused(userId: string, daemonId: string, isPaused: boolean) {
    const daemon = await services.prisma.daemon.findFirst({ where: { id: daemonId, userId } });
    if (!daemon) return venum('notFound', { message: 'Daemon not found' });
    const updated = await services.prisma.daemon.update({
      where: { id: daemonId },
      data: { isPaused },
    });
    services.daemon.setPaused(daemonId, isPaused);
    return venum('ok', overlayStatus(userId, updated));
  }

  static async rotateToken(userId: string, daemonId: string) {
    const daemon = await services.prisma.daemon.findFirst({ where: { id: daemonId, userId } });
    if (!daemon) return venum('notFound', { message: 'Daemon not found' });

    const token = Daemon.generateToken();
    const tokenHash = await sha256Hex(token);
    await services.prisma.daemon.update({ where: { id: daemonId }, data: { tokenHash } });
    services.daemon.disconnectDaemon(daemonId);

    return venum('ok', Daemon.toPairResult({
      daemon,
      token,
      sishHost: config.sish.host || null,
    }));
  }

  static async cancelPairingCode(userId: string, code: string) {
    await services.prisma.daemonPairingCode.deleteMany({ where: { code, userId } });
    return venum('ok', { cancelled: true });
  }

  static async sshInfoForMachine(userId: string, machineId: string) {
    const sishHost = config.sish.host;
    if (!sishHost) return venum('notFound', { message: 'IDE access not configured for this Piano instance' });

    const route = await routeForMachine(userId, machineId);
    if (!route) return venum('notFound', { message: 'Machine has no IDE-reachable daemon' });
    if (!route.daemon.sshPort) {
      return venum('notFound', { message: 'Daemon has no SSH tunnel allocated' });
    }
    // Use in-memory state (services.daemon.isPaused / isConnected) over the
    // FK-joined route.daemon.isPaused — the in-memory map is the source of
    // truth for "right now" and updates immediately on setPaused / WS close,
    // while the DB row lags by a heartbeat / write.
    if (services.daemon.isPaused(route.target.daemonId)) {
      return venum('offline', { message: `Daemon "${route.daemon.name}" is paused — resume it in Settings to open the IDE` });
    }
    if (!services.daemon.isConnected(route.target)) {
      return venum('offline', { message: `Daemon "${route.daemon.name}" is offline — start it before opening the IDE` });
    }

    return venum('ok', Daemon.toSshInfo({
      host: sishHost,
      port: route.daemon.sshPort,
      machineId,
      daemonName: route.daemon.name,
      workdir: route.daemon.defaultWorkdir,
    }));
  }

  static async delete(userId: string, daemonId: string) {
    const daemon = await services.prisma.daemon.findFirst({ where: { id: daemonId, userId } });
    if (!daemon) return venum('notFound', { message: 'Daemon not found' });

    if (services.daemon.isConnected({ daemonOwnerId: daemon.userId, daemonId })) {
      // Query by daemonId only — in single-user this matches `userId`-scoped
      // notes anyway, and in multi-user (Step 6) other members' notes on
      // this daemon would be missed by a userId filter, leaving zombies on
      // the host after cleanup.
      const notes = await services.prisma.note.findMany({
        where: { daemonId },
        select: { machineId: true },
      });
      const machineIds = notes.map(n => n.machineId).filter((id): id is string => !!id);
      if (machineIds.length > 0) {
        services.daemon.send({ daemonOwnerId: daemon.userId, daemonId }, {
          type: 'command:delete-batch',
          data: { machineIds },
        });
      }
    }

    await services.prisma.daemon.delete({ where: { id: daemonId } });
    services.daemon.disconnectDaemon(daemonId);
    return venum('ok', { deleted: true });
  }

  static async authenticateToken(token: string) {
    const tokenHash = await sha256Hex(token);
    return services.prisma.daemon.findUnique({ where: { tokenHash } });
  }

  /**
   * Self-healing dev/self-hosted shortcut: if the presented token matches
   * the env-configured PIANO_DEV_DAEMON_TOKEN but no daemon row exists yet
   * (fresh DB before first sign-up, or .env was regenerated), auto-register
   * the daemon against the first user in the DB. Returns null until at
   * least one user has signed up — daemon will keep retrying every 5s.
   */
  static async ensureFromDevToken(token: string) {
    const expected = config.dev.daemonToken;
    if (!expected || token !== expected) return null;

    const user = await services.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) return null; // no user yet — daemon will retry

    const tokenHash = await sha256Hex(token);
    return services.prisma.daemon.upsert({
      where: { userId_name: { userId: user.id, name: 'dev' } },
      update: { tokenHash, status: 'OFFLINE' },
      create: { userId: user.id, name: 'dev', tokenHash, status: 'OFFLINE' },
    });
  }
}
