export namespace Machine {
  /**
   * The four states emitted by the daemon (see `daemon/machine.go:17-33`):
   *   - `running`  — container attached to a user session
   *   - `detached` — container up but no session attached
   *   - `stopped`  — container exited (podman-stopped, not frozen)
   *   - `frozen`   — container snapshotted and torn down, can be branched
   *
   * `frozen` was historically missing from this type. Keep it in sync with
   * `Machine.String()` in the Go daemon any time a new state is introduced.
   */
  export type State = 'running' | 'detached' | 'stopped' | 'frozen'

  export type Info = {
    id: string
    state: State
    attached: boolean
  }
}
