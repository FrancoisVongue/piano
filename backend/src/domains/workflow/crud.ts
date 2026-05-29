import { venum } from 'venum';
import { services } from '../../services/init';
import { Workflow } from '@piano/shared';
import { Prisma } from '@prisma/client';

// CRUD for workflows. Same ownership-aware pattern as ActionController:
// every read/write that takes a workflow id pairs it with userId in the
// query so misses and "not yours" collapse into one notFound variant.

const notFound = () => venum('notFound', { message: 'Workflow not found or access denied' });

// Prisma's Json input type is wider than our domain type; cast at the boundary.
const levelsToJson = (levels: Workflow.Level[]): Prisma.InputJsonValue =>
  levels as unknown as Prisma.InputJsonValue;

const jsonToLevels = (json: unknown): Workflow.Level[] =>
  Array.isArray(json) ? (json as Workflow.Level[]) : [];

const toModel = (row: { id: string; name: string; levels: unknown; userId: string; createdAt: Date; updatedAt: Date }): Workflow.Model => ({
  id: row.id,
  name: row.name,
  levels: jsonToLevels(row.levels),
  userId: row.userId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const create = async (userId: string, data: Workflow.DTO.Create): Promise<Workflow.Model> => {
  const row = await services.prisma.workflow.create({
    data: { userId, name: data.name, levels: levelsToJson(data.levels) },
  });
  return toModel(row);
};

export const findByUser = async (userId: string): Promise<Workflow.Model[]> => {
  const rows = await services.prisma.workflow.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toModel);
};

export const findById = async (id: string, userId: string) => {
  const row = await services.prisma.workflow.findFirst({ where: { id, userId } });
  return row ? venum('ok', toModel(row)) : notFound();
};

export const update = async (id: string, userId: string, data: Workflow.DTO.Update) => {
  const existing = await services.prisma.workflow.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  const row = await services.prisma.workflow.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.levels !== undefined ? { levels: levelsToJson(data.levels) } : {}),
    },
  });
  return venum('ok', toModel(row));
};

export const remove = async (id: string, userId: string) => {
  const existing = await services.prisma.workflow.findFirst({ where: { id, userId } });
  if (!existing) return notFound();
  await services.prisma.workflow.delete({ where: { id } });
  return venum('ok', { id });
};
