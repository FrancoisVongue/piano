import { z } from 'zod'

export namespace Secret {
  export type Model = {
    id: string
    key: string
    maskedValue: string
    userId: string
    createdAt: Date
    updatedAt: Date
  }

  export namespace DTO {
    export const CreateSchema = z.object({
      key: z.string().min(1).max(100).regex(/^[A-Z_][A-Z0-9_]*$/, 'Must be UPPER_SNAKE_CASE'),
      value: z.string().min(1).max(5000),
    })

    export const UpdateSchema = z.object({
      value: z.string().min(1).max(5000),
    })

    export type Create = z.infer<typeof CreateSchema>
    export type Update = z.infer<typeof UpdateSchema>
  }

  export const validate = {
    create: (data: unknown) => DTO.CreateSchema.parse(data),
    update: (data: unknown) => DTO.UpdateSchema.parse(data),
  }

  export const mask = (value: string): string => {
    if (value.length <= 4) return '****'
    return '****' + value.slice(-4)
  }

  // Pure transformation: DB row -> Model (masks the raw value)
  export type DbRow = {
    id: string
    key: string
    value: string
    userId: string
    createdAt: Date
    updatedAt: Date
  }

  export const toModel = (row: DbRow): Model => ({
    id: row.id,
    key: row.key,
    maskedValue: mask(row.value),
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}
