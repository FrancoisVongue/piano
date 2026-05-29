import { venum } from 'venum';
import { services } from '../../services/init';
import { Unifier } from '@piano/shared';

// Ownership-aware reads/writes return venum — routes map `notFound` → 404.
// Like actions, the "not found or not owned" distinction is intentionally
// conflated to avoid an ID-probe oracle.

const notFound = () => venum('notFound', { message: 'Unifier not found or access denied' });

export const create = (userId: string, data: Unifier.DTO.Create) =>
  services.prisma.unifier.create({ data: { userId, ...data } });

export const findByUser = (userId: string) =>
  services.prisma.unifier.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

export const findById = async (id: string, userId: string) => {
  const row = await services.prisma.unifier.findFirst({ where: { id, userId } });
  return row ? venum('ok', row) : notFound();
};

export const update = async (id: string, userId: string, data: Unifier.DTO.Update) => {
  const existing = await services.prisma.unifier.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  return venum('ok', await services.prisma.unifier.update({ where: { id }, data }));
};

export const remove = async (id: string, userId: string) => {
  const existing = await services.prisma.unifier.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  return venum('ok', await services.prisma.unifier.delete({ where: { id } }));
};
