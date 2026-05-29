import { z } from 'zod'

export namespace MachineTemplate {
  export type Model = {
    id: string
    name: string
    description: string | null
    icon: string | null
    color: string | null
    isSystem: boolean
    parentTemplateId: string | null
    userId: string
    // Daemon whose layersDir holds this template's overlay. Null for legacy
    // templates created before multi-daemon support. UI uses this to filter
    // which templates can be spawned on a given daemon — cross-daemon spawn
    // would 404 since layers are local to each daemon's filesystem.
    daemonId: string | null
    createdAt: Date
    updatedAt: Date
  }

  // True when the template can be materialised on the given daemon. Legacy
  // (daemonId === null) is permitted everywhere — operator opted into the
  // gamble that the layers happen to be reachable.
  export const isAvailableOn = (template: Pick<Model, 'daemonId'>, daemonId: string): boolean =>
    template.daemonId === null || template.daemonId === daemonId

  export namespace DTO {
    export const CreateSchema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      icon: z.string().max(10).optional(),
      color: z.string().max(20).optional(),
      parentTemplateId: z.string().optional(),
    })

    export const UpdateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).optional(),
      icon: z.string().max(10).optional(),
      color: z.string().max(20).optional(),
    })

    export type Create = z.infer<typeof CreateSchema>
    export type Update = z.infer<typeof UpdateSchema>

    // What frontend sends to save a sandbox as template
    export const SaveFromMachineSchema = z.object({
      machineId: z.string().min(1),
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      icon: z.string().max(10).optional(),
      color: z.string().max(20).optional(),
      parentTemplateId: z.string().optional(),
    })

    export type SaveFromMachine = z.infer<typeof SaveFromMachineSchema>
  }

  export const validate = {
    create: (data: unknown) => DTO.CreateSchema.parse(data),
    update: (data: unknown) => DTO.UpdateSchema.parse(data),
    saveFromMachine: (data: unknown) => DTO.SaveFromMachineSchema.parse(data),
  }
}
