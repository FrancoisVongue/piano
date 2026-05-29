import { venum } from 'venum';
import { services } from '../../services/init';
import { Action } from '@piano/shared';

// CRUD for actions. Ownership-aware reads/writes return a venum so the route
// layer can map "not found OR not owned" to a 404 without throws.
// `notFound` intentionally conflates the two cases — leaking which it is
// would give an oracle for probing other users' IDs.

const notFound = () => venum('notFound', { message: 'Action not found or access denied' });

export const create = (userId: string, data: Action.DTO.Create) =>
  services.prisma.action.create({ data: { userId, ...data } });

export const seedDefaults = (userId: string, data: Action.DTO.Create[]) =>
  services.prisma.$transaction(async (tx) => {
    const existingCount = await tx.action.count({ where: { userId } });
    if (existingCount > 0) {
      return tx.action.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    }
    await tx.action.createMany({ data: data.map((action) => ({ userId, ...action })) });
    return tx.action.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  });

export const findByUser = (userId: string) =>
  services.prisma.action.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

export const findById = async (id: string, userId: string) => {
  const row = await services.prisma.action.findFirst({ where: { id, userId } });
  return row ? venum('ok', row) : notFound();
};

export const update = async (id: string, userId: string, data: Action.DTO.Update) => {
  const existing = await services.prisma.action.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  return venum('ok', await services.prisma.action.update({ where: { id }, data }));
};

export const remove = async (id: string, userId: string) => {
  const existing = await services.prisma.action.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  return venum('ok', await services.prisma.action.delete({ where: { id } }));
};
