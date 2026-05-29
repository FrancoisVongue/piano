// Export all types from the new type-centric structure
export * from './types/mention';
export * from './types/arrangement';
export * from './types/note';
export * from './types/edge';
export * from './types/run';
export * from './types/user';
export * from './types/api';
export * from './types/models';
export * from './types/canvas';
export * from './types/action';
export * from './types/unifier';
export * from './types/workflow';
export * from './types/clipboard';
export * from './types/user-api-key';
export * from './types/machine';
export * from './types/machine-template';
export * from './types/secret';
export * from './types/daemon';
export * from './types/terminal';
export * from './types/files';
export * from './types/machine-window';

/**
 * Shared types exported for both backend and frontend
 */
export { Note } from './types/note';
export { Edge } from './types/edge';
export { Arrangement } from './types/arrangement';
export { Arrangement as Project } from './types/arrangement';
export { Action } from './types/action';
export { Unifier } from './types/unifier';
export { Workflow } from './types/workflow';
export { Run } from './types/run';
export { User } from './types/user';
export { UserApiKey } from './types/user-api-key';
export { LLM } from './types/models';
export { SSE } from './types/sse';
export { Canvas } from './types/canvas';
export { Clipboard } from './types/clipboard';
export { MachineTemplate } from './types/machine-template';
export { Secret } from './types/secret';
export { Daemon } from './types/daemon';
export { Terminal } from './types/terminal';
export { Files } from './types/files';
export { MachineWindow } from './types/machine-window';
export { Mention } from './types/mention';

/**
 * Shared utilities
 */
export { Layout } from './utils/layout';
export * from './utils/canvas';
