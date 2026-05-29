import { venum } from 'venum';
import { services } from '../../services/init';
import { Secret } from '@piano/shared';

export class SecretController {
  // Plain return: list has NO domain-level failure variants. Prisma can still
  // throw (DB down, timeout) — those are infra failures that cross to the
  // crash boundary (asyncHandler → 500), not choices the route can map to a
  // specific HTTP code. venum is reserved for domain variants like `notFound`
  // / `forbidden` that the route actually matches on (see update/delete).
  static async list(userId: string) {
    const rows = await services.prisma.secret.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(Secret.toModel);
  }

  static async create(userId: string, data: Secret.DTO.Create) {
    const row = await services.prisma.secret.upsert({
      where: { userId_key: { userId, key: data.key } },
      update: { value: data.value },
      create: { key: data.key, value: data.value, userId },
    });
    return venum('ok', Secret.toModel(row));
  }

  static async update(userId: string, secretId: string, data: Secret.DTO.Update) {
    const existing = await services.prisma.secret.findFirst({
      where: { id: secretId, userId },
    });
    if (!existing) return venum('notFound', { message: 'Secret not found' });

    const row = await services.prisma.secret.update({
      where: { id: secretId },
      data: { value: data.value },
    });
    return venum('ok', Secret.toModel(row));
  }

  static async delete(userId: string, secretId: string) {
    const existing = await services.prisma.secret.findFirst({
      where: { id: secretId, userId },
    });
    if (!existing) return venum('notFound', { message: 'Secret not found' });

    await services.prisma.secret.delete({ where: { id: secretId } });
    return venum('ok', { deleted: true });
  }

  // Internal: returns decrypted key-value pairs for injection into machines.
  static async getDecrypted(userId: string): Promise<{ key: string; value: string }[]> {
    const secrets = await services.prisma.secret.findMany({ where: { userId } });
    return secrets.map(s => ({ key: s.key, value: s.value }));
  }
}
