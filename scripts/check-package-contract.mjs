// Contract checks for the `dsh.*` fields and the files a published tarball must
// carry. A typo in these fields means the plugin installs and then silently
// never loads, which is the hardest kind of failure to notice.
//
//   node scripts/check-package-contract.mjs

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const failures = []
const check = (label, pass, detail) => {
  if (!pass) failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ── dsh.client / dsh.bundle: read by the loader and the client module system ──
check('dsh.bundle.patch points at cordis.patch.yml',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch))
check('dsh.client.platform is "web"',
  pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('dsh.client.inject is a string array',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.every((x) => typeof x === 'string'),
  JSON.stringify(pkg.dsh?.client?.inject))
check('exports["./client"] is a string path',
  typeof pkg.exports?.['./client'] === 'string', String(pkg.exports?.['./client']))
check('main resolves to the compiled host half', pkg.main === './dist/index.js', String(pkg.main))

for (const rel of ['dist/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  check(`required file present: ${rel}`, existsSync(join(root, rel)))
}
for (const needed of ['dist', 'lib', 'cordis.patch.yml']) {
  check(`files[] includes ${needed}`, (pkg.files ?? []).includes(needed))
}

// ── the browser bundle must use the loader's registration shape ──────────────
const client = await readFile(join(root, 'lib/client.js'), 'utf8')
check('client registers via window.__ModuleLoader__.load', client.includes('window.__ModuleLoader__.load'))
check('client declares the package id', client.includes(`id: '${pkg.name}'`), pkg.name)
check('client has no bare ESM import (not processed by a bundler)', !/^\s*import\s/m.test(client))
check('client requires only react', !/require\(['"](?!react['"])/.test(client))

// ── this plugin must stay independent of any third-party plugin ──────────────
check('client never references the third-party control it replaces',
  !/@hytime|dsh-thinking-effort|data-seat-/.test(client))
check('client drives the official seat name',
  client.includes("'conversation.input.model'"))
check('client reads the official directory service', client.includes('modelDirectories'))
check('client ships no tier vocabulary of its own',
  !/\bUltra\b\s*:|\btierNames\b|\beffortLabels\b/.test(client))

// ── the host half must not have grown a capability by accident ───────────────
const host = await readFile(join(root, 'dist/index.js'), 'utf8')
check('host half stays inert (no service/tool/route registration)',
  !/webServer|defineTool|registerTool|ctx\.tools/.test(host))
check('host half exports a name', /export const name\s*=/.test(host))

if (failures.length > 0) {
  console.error(`\n${failures.length} contract check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\npackage contract: OK')
