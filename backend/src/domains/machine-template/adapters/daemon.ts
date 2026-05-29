import { services } from '../../../services/init';
import { targetForMachine } from '../../../services/daemon.adapter';

// Inject all of this user's secrets into the given daemon machine. No-op
// when the user has no secrets, or when the machine isn't associated with
// a daemon (legacy data without a daemonId — silently skip rather than crash).
export async function injectUserSecrets(userId: string, machineId: string): Promise<void> {
  const secrets = await services.prisma.secret.findMany({ where: { userId } });
  if (secrets.length === 0) return;
  const target = await targetForMachine(userId, machineId);
  if (!target) return;
  await services.daemon.sendCommand(target, {
    type: 'command:inject-secrets',
    machineId,
    data: { secrets: secrets.map(s => ({ key: s.key, value: s.value })) },
  }, 'secrets:injected');
}
