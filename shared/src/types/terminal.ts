export namespace Terminal {
  export type ClientFrame =
    | { type: 'input'; data: string }
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'file'; path: string; data: string }

  export const encode = (frame: ClientFrame): string => JSON.stringify(frame)
}
