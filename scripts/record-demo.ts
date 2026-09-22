/**
 * Record the CLI demo GIF.
 *
 * Seeds a throwaway HOME with fake accounts, puts the built CLI on PATH, and
 * runs the VHS tape against it. Nothing here touches the real account store.
 *
 * Requires: https://github.com/charmbracelet/vhs
 */
import { $ } from 'bun'

const HOME = '/tmp/ocdemo'
const BIN = `${HOME}/bin`

await $`rm -rf ${HOME}`
await $`mkdir -p ${BIN} ${HOME}/.local/share/opencode`

// Build first — the tape runs the compiled entrypoint, not the sources.
await $`bun run build`

// A shim rather than a symlink, so PATH lookup cannot escape to a real install.
await Bun.write(
  `${BIN}/oc-anthropic`,
  `#!/bin/sh\nexec node ${import.meta.dir}/../bin/oc-anthropic.js "$@"\n`,
)
await $`chmod +x ${BIN}/oc-anthropic`

await $`bun ${import.meta.dir}/demo-store.ts`.env({
  ...process.env,
  HOME,
  ANTHROPIC_ACCOUNTS_FILE: `${HOME}/.local/share/opencode/anthropic-accounts.json`,
  ANTHROPIC_STATUS_FILE: `${HOME}/.local/share/opencode/anthropic-status.json`,
})

// HOME and PATH come from here rather than from the tape, so no setup
// commands appear in the recording.
await $`vhs ${import.meta.dir}/demo.tape`.env({
  ...process.env,
  HOME,
  PATH: `${BIN}:${process.env.PATH}`,
  PS1: '$ ',
  ENV: '',
})

console.log('wrote images/cli.gif')
