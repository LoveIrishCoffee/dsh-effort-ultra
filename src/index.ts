// dsh-effort-ultra — HOST half.
//
// The whole feature lives in the browser half. This half is deliberately inert:
// no route, no tool, no service, no injected capability, nothing that touches
// user data. It exists only because `cordis.patch.yml` registers the host half
// into a profile — the BROWSER half is auto-discovered from
// `exports["./client"]` + `dsh.client` in package.json and needs no row.
//
// Why the feature is client-side at all: the reasoning ladder and the selection
// both come from the official `modelDirectories` client service, which already
// owns the persistence path. The host has nothing to add, and adding something
// would mean a second source of truth for state the Host already holds.

/** Plugin display name, shown in loader diagnostics. */
export const name = 'effort-ultra'

/**
 * No host services are needed. An empty inject list means this half applies
 * immediately and cannot stall a profile boot.
 */
export const inject: string[] = []

export function apply(): void {
  console.log(
    '[effort-ultra] host half loaded (inert by design); ' +
      'the browser half registers the composer reasoning-effort seat.',
  )
}
