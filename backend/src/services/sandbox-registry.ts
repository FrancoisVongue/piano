import type { DaemonTarget } from './daemon';

// In-memory registry of transient sandbox machines. Sandboxes have no Note
// row (they're never persisted), so terminal-proxy can't authorize their
// terminal connections via the usual Note → daemon route. We register them
// at create-time and look them up here when a terminal arrives.
//
// Backend restart drops the registry. Acceptable: sandboxes are transient
// and the user explicitly opts into "I'll lose this if I refresh".
//
// This deliberately lives apart from DaemonService — they have different
// volatility axes (DaemonService = WS routing + RPC tracking; SandboxRegistry
// = "who created this transient machine, and who can attach"). Keeping them
// separate so a future change to either doesn't ripple into the other.
type SandboxEntry = {
  requesterUserId: string;
  daemonOwnerId: string;
  daemonId: string;
};

export class SandboxRegistry {
  private entries = new Map<string, SandboxEntry>();

  // Input is shaped so the requester (a userId) and the daemon owner (also
  // a userId, but a DIFFERENT person in multi-user) can never be swapped at
  // a callsite. `target` is a DaemonTarget — it carries both daemonId and
  // daemonOwnerId together. See daemon.ts DaemonTarget comment for the rule.
  register(input: { machineId: string; requesterUserId: string; target: DaemonTarget }) {
    this.entries.set(input.machineId, {
      requesterUserId: input.requesterUserId,
      daemonOwnerId:   input.target.daemonOwnerId,
      daemonId:        input.target.daemonId,
    });
  }

  unregister(machineId: string) {
    this.entries.delete(machineId);
  }

  // Lookup gated by requester — only the user who created the sandbox can
  // resolve to its daemon target. The in-memory equivalent of the DB
  // ownership check on persisted machines.
  resolve(machineId: string, requesterUserId: string): { daemonOwnerId: string; daemonId: string } | null {
    const entry = this.entries.get(machineId);
    if (!entry || entry.requesterUserId !== requesterUserId) return null;
    return { daemonOwnerId: entry.daemonOwnerId, daemonId: entry.daemonId };
  }
}
