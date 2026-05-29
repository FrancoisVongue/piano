// Lower-case hex SHA-256 of `input`. Single source of truth for the daemon
// token hashing scheme — both `ensureDevDaemon` (writer) and
// `DaemonController.authenticateToken` (reader) must agree, otherwise
// authentication fails with no useful diagnostic.
export const sha256Hex = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
};
