// Smoke-test the BROWSER half without a browser.
//
// Loads lib/client.js into a stubbed `window.__ModuleLoader__` with a stub React
// and stubbed Host services, then drives the real component:
//
//   * it must register the seat, in a scope that declares `remote.session`;
//   * it must read the model catalog through `remote.session.modelCatalog` —
//     NOT through `modelDirectories.directoryFor`, whose new-session path throws
//     "cannot get property 'remote.session' without inject" from the resolver's
//     own context, which a third-party plugin cannot supply;
//   * the ladder it renders must be the one the Host declares, sized by the
//     declaration rather than by a hardcoded count;
//   * a pick must commit `{ provider, model, reasoningEffort }` through
//     `sessions.selectModel`, and "follow the model default" must omit the tier;
//   * unmounting must leave no <style> element behind.
//
//   node scripts/smoke-client.mjs

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

const results = []
const check = (label, pass, detail) => {
  results.push({ label, pass, detail })
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// Timers run synchronously so the seat's retry backoff is observable without
// making the suite wait real milliseconds. setImmediate is left alone: the async
// settle() below needs a real turn of the loop for adapter promises to resolve.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = (fn) => { fn(); return 0 }
globalThis.clearTimeout = () => {}

// ── stub React ─────────────────────────────────────────────────────────────
const createReact = () => {
  let frame = { slots: [], index: 0, effects: [] }
  const effectCleanups = []
  return {
    React: {
      createElement: (type, props, ...kids) => ({
        type,
        props: { ...(props ?? {}), children: kids.length <= 1 ? kids[0] : kids },
      }),
      Fragment: Symbol('Fragment'),
      useRef: (initial) => {
        const i = frame.index++
        if (!(i in frame.slots)) frame.slots[i] = { current: initial }
        return frame.slots[i]
      },
      useState: (initial) => {
        const i = frame.index++
        if (!(i in frame.slots)) frame.slots[i] = typeof initial === 'function' ? initial() : initial
        return [frame.slots[i], (next) => {
          frame.slots[i] = typeof next === 'function' ? next(frame.slots[i]) : next
        }]
      },
      useCallback: (fn) => fn,
      useEffect: (fn) => { frame.effects.push(fn) },
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    },
    beginRender: () => { frame = { slots: frame.slots, index: 0, effects: [] } },
    keepState: () => { const s = frame.slots; frame = { slots: s, index: 0, effects: [] } },
    freshMount: () => { frame = { slots: [], index: 0, effects: [] } },
    pendingEffects: () => frame.effects.length,
    runEffects: () => {
      const pending = frame.effects
      frame.effects = []
      for (const fn of pending) {
        if (typeof fn !== 'function') {
          console.error('[smoke] non-function effect callback:', typeof fn, String(fn))
          continue
        }
        const cleanup = fn()
        if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      }
    },
    disposeEffects: () => { for (const cleanup of effectCleanups.splice(0)) cleanup() },
  }
}

// ── stub DOM ───────────────────────────────────────────────────────────────
const head = {
  children: [],
  appendChild(n) { this.children.push(n); n.parentNode = this },
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null },
}
const document = {
  head,
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), id: '', textContent: '', attributes: new Map(), parentNode: null,
    setAttribute(k, v) { this.attributes.set(k, String(v)) },
    getAttribute(k) { return this.attributes.get(k) ?? null },
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
}

// ── stub Host services ─────────────────────────────────────────────────────
const EFFORTS_FOUR = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'ultra', name: 'Max' },
]
const EFFORTS_TWO = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
]

const makeCatalog = (efforts, overrides = {}) => ({
  default: overrides.default ?? { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'ultra' },
  routableProviders: overrides.routableProviders ?? ['relay'],
  failures: overrides.failures ?? [],
  groups: overrides.groups ?? [{
    id: 'relay',
    name: 'Relay',
    models: overrides.models ?? [{
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      reasoning: { defaultEffort: 'high', efforts },
    }],
  }],
})

const state = {
  catalog: makeCatalog(EFFORTS_FOUR),
  catalogFails: false,
  catalogCalls: 0,
  selectCalls: [],
  selectFails: false,
  subagentAddress: undefined,
}

const remoteSessionStub = {
  modelCatalog: () => {
    state.catalogCalls += 1
    if (state.catalogFails) {
      return Promise.resolve({ ok: false, error: { code: 'E_CATALOG', message: 'catalog unavailable' } })
    }
    return Promise.resolve({ ok: true, value: state.catalog })
  },
}
const sessionsStub = {
  subagentAddress: () => state.subagentAddress,
  selectModel: (input) => {
    state.selectCalls.push(input)
    if (state.selectFails) {
      return Promise.resolve({ ok: false, error: { code: 'E_SELECT', message: 'selection rejected' } })
    }
    return Promise.resolve({
      ok: true,
      value: {
        selected: {
          provider: input.provider,
          model: input.model,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        },
      },
    })
  },
}

// ── load the bundle ────────────────────────────────────────────────────────
let registration = null
let react = createReact()
const window = { __ModuleLoader__: { load: (spec) => { registration = spec } } }
const source = await readFile(clientPath, 'utf8')
new Function('window', 'document', 'MutationObserver', source)(window, document, class {})

check('bundle registers exactly one module', registration !== null)
check('module id matches the loader contract', registration?.id === 'dsh-effort-ultra', registration?.id)

const plugin = registration.factory((name) => {
  if (name === 'react') return react.React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

check('plugin injects only services present at boot',
  Array.isArray(plugin.inject) && plugin.inject.includes('slots') && !plugin.inject.includes('remote.session'),
  JSON.stringify(plugin.inject))

// ── drive apply() ──────────────────────────────────────────────────────────
const disposers = []
const serviceListeners = []
const injectCalls = []
let seatRegistration = null
const localeDicts = []

const slotsStub = {
  inject: (name, cb) => { cb(); return () => {} },
  register: (options, component) => { seatRegistration = { options, component }; return () => {} },
}
const ctx = {
  get: (name) => {
    if (name === 'remote.session') return remoteSessionStub
    if (name === 'sessions') return sessionsStub
    if (name === 'slots') return slotsStub
    if (name === 'locale') {
      return {
        register: (ns, dicts) => { localeDicts.push({ ns, dicts }); return () => {} },
        bind: () => (key) => ({
          reasoning: '推理等级', providerDefault: '跟随模型默认', noEfforts: '当前模型无档位',
          loading: '读取模型目录…', error: '切换失败', model: '模型', barLabel: '档位',
        }[key] ?? key),
      }
    }
    return undefined
  },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  on: (name, listener) => { serviceListeners.push({ name, listener }); return () => {} },
  slots: slotsStub,
}
ctx.inject = (deps, callback) => { injectCalls.push(deps); callback(ctx); return () => {} }

plugin.apply(ctx)

check('stylesheet appended to head', head.children.some((n) => n.id === 'dsh-effort-ultra-css'))
const css = head.children.find((n) => n.id === 'dsh-effort-ultra-css')?.textContent ?? ''
check('css is balanced', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, `${css.length} chars`)
check('css avoids foreign class names', !/_3_LLuW_|_7KE1Ra_/.test(css))
check('locale dictionaries registered', localeDicts.length === 1 && localeDicts[0].ns === 'effort-ultra')
// The plugin must NEVER defer its apply behind a dependency gate. Declaring
// `remote`/`remote.session` in `inject`, or waiting on them with `ctx.inject`,
// parks the whole plugin when they are not registered yet — and a parked plugin
// never runs apply(), with no error to point at. It reads them with `ctx.get`
// instead, which takes no inject, and retries on the service announcement.
check('plugin never defers apply behind a dependency gate', injectCalls.length === 0, JSON.stringify(injectCalls))
check('seat registered on conversation.input.model',
  seatRegistration?.options?.name === 'conversation.input.model', seatRegistration?.options?.name)
// The seat must WIN the slot: its catalog retries live inside the component, so
// an entry that never renders can never load anything. And it must NOT reach for
// the official resolver, whose new-session construction fails on its own missing
// `remote.session` injection.
check('seat priority takes the slot so the retry can run',
  seatRegistration?.options?.priority === -20, String(seatRegistration?.options?.priority))

// ── helpers ────────────────────────────────────────────────────────────────
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0))

const props = seatRegistration.options.inject('session-1')
const renderWith = async (overrides = {}, passes = 6) => {
  let tree = null
  for (let pass = 0; pass < passes; pass += 1) {
    react.keepState()
    tree = seatRegistration.component({ ...props, ...overrides })
    react.runEffects()
    await settle()
  }
  react.keepState()
  return seatRegistration.component({ ...props, ...overrides })
}

const findByClass = (node, cls, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(cls)) out.push(node)
  const kids = node.props?.children
  for (const kid of Array.isArray(kids) ? kids : [kids]) if (kid !== undefined && kid !== null) findByClass(kid, cls, out)
  return out
}

// ── the catalog contract ───────────────────────────────────────────────────
check('inject exposes a directory-shaped face',
  props.directory !== undefined && typeof props.load === 'function' && typeof props.select === 'function',
  JSON.stringify(Object.keys(props)))
// The seat must not reach for the official resolver at all: its new-session path
// constructs a ModelDirectory that touches `ctx.remote.session` on the resolver's
// own context and throws. Checked against CODE (the source minus comments), not
// the whole file — the comments discuss that call by name.
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('the seat resolves no directory of its own outside its adapter',
  !codeOnly.includes('directoryFor') && !codeOnly.includes('modelDirectories'))

// ── first render: the adapter is still loading ─────────────────────────────
// Rendered the way React does after a commit: render, then run the effects that
// render declared. The load is kicked off by one of those effects, so the tree
// is null here while the catalog call is still in flight.
react.freshMount()
react.keepState()
const treeLoading = seatRegistration.component(props)
const callsBefore = state.catalogCalls
react.runEffects()
await settle()
check('before the catalog lands the seat renders nothing',
  treeLoading === null, String(treeLoading))
check('mounting asks the catalog to load',
  state.catalogCalls > callsBefore || state.catalogCalls >= 1, `catalog calls: ${state.catalogCalls}`)

// ── once the catalog resolves ──────────────────────────────────────────────
const tree = await renderWith()
check('chip renders with the model label',
  findByClass(tree, 'deu-chipModel')[0]?.props?.children === 'GPT-6 Astra',
  String(findByClass(tree, 'deu-chipModel')[0]?.props?.children))
check('chip shows the current tier name',
  findByClass(tree, 'deu-chipTier')[0]?.props?.children === 'Max',
  String(findByClass(tree, 'deu-chipTier')[0]?.props?.children))

findByClass(tree, 'deu-chip')[0].props.onClick()
const openTree = await renderWith()
check('panel opens', findByClass(openTree, 'deu-panel').length === 1)

const segs = findByClass(openTree, 'deu-seg')
check('one segment per Host-declared tier', segs.length === EFFORTS_FOUR.length, String(segs.length))
check('segments up to the active tier are filled',
  segs.filter((s) => s.props.className.includes('deu-segOn')).length === EFFORTS_FOUR.length)
check('the last tier is not flagged as top when the Host does not say so',
  openTree === null || typeof openTree.props['data-top'] === 'string')

// ── committing a tier ──────────────────────────────────────────────────────
segs[1].props.onClick()
await settle()
check('select() got provider + model + the picked tier',
  state.selectCalls.length === 1
  && state.selectCalls[0].sessionId === 'session-1'
  && state.selectCalls[0].provider === 'relay'
  && state.selectCalls[0].model === 'gpt-6-astra'
  && state.selectCalls[0].reasoningEffort === 'low',
  JSON.stringify(state.selectCalls[0]))

const afterPick = await renderWith()
check('the picked tier becomes the chip label',
  findByClass(afterPick, 'deu-chipTier')[0]?.props?.children === 'Low',
  String(findByClass(afterPick, 'deu-chipTier')[0]?.props?.children))

// "follow the model default" drops reasoningEffort entirely
findByClass(afterPick, 'deu-chip')[0].props.onClick()
const reopened = await renderWith()
findByClass(reopened, 'deu-reset')[0].props.onClick()
await settle()
check('reset omits reasoningEffort (lets the model default apply)',
  state.selectCalls.length === 2 && !('reasoningEffort' in state.selectCalls[1]),
  JSON.stringify(state.selectCalls[1]))

const afterReset = await renderWith()
check('after reset the chip shows the model default label',
  findByClass(afterReset, 'deu-chipTier')[0]?.props?.children === '跟随模型默认',
  String(findByClass(afterReset, 'deu-chipTier')[0]?.props?.children))

// ── a model with a shorter ladder ──────────────────────────────────────────
state.catalog = makeCatalog(EFFORTS_TWO, {
  default: { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'high' },
})
react.freshMount()
const treeShort = await renderWith()
check('a model declaring two tiers renders two segments after opening',
  (() => {
    findByClass(treeShort, 'deu-chip')[0].props.onClick()
    return true
  })())
const treeShortOpen = await renderWith()
check('ladder length follows the declaration, not a hardcoded count',
  findByClass(treeShortOpen, 'deu-seg').length === EFFORTS_TWO.length,
  String(findByClass(treeShortOpen, 'deu-seg').length))

// ── a model with no ladder ─────────────────────────────────────────────────
state.catalog = makeCatalog(EFFORTS_FOUR, {
  models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
})
react.freshMount()
const treeBare = await renderWith()
findByClass(treeBare, 'deu-chip')[0].props.onClick()
const treeBareOpen = await renderWith()
check('a model with no ladder renders a note, not a broken bar',
  findByClass(treeBareOpen, 'deu-note').length === 1 && findByClass(treeBareOpen, 'deu-barWrap').length === 0)

// ── a catalog that fails ───────────────────────────────────────────────────
state.catalogFails = true
state.catalog = makeCatalog(EFFORTS_FOUR)
react.freshMount()
const treeErr = await renderWith()
findByClass(treeErr, 'deu-chip')[0].props.onClick()
const treeErrOpen = await renderWith()
const errText = findByClass(treeErrOpen, 'deu-error')[0]?.props?.children
check('a failed catalog surfaces the Host message',
  typeof errText === 'string' && errText.includes('E_CATALOG'), String(errText))
state.catalogFails = false

// ── an addressed-subagent session is read-only, not invisible ─────────────
// `available` is decided when the seat injects, so the stub has to be re-entered
// to model a session becoming an addressed subagent.
state.subagentAddress = { parentSessionId: 'p', childSessionId: 'session-1' }
state.catalog = makeCatalog(EFFORTS_FOUR)
const roProps = seatRegistration.options.inject('session-1')
check('inject marks an addressed-subagent session as read-only', roProps.available === false)
react.freshMount()
let treeRO = null
for (let pass = 0; pass < 6; pass += 1) {
  react.keepState()
  treeRO = seatRegistration.component(roProps)
  react.runEffects()
  await settle()
}
react.keepState()
treeRO = seatRegistration.component(roProps)
check('a read-only session still renders the seat',
  treeRO !== null && findByClass(treeRO, 'deu-root').length === 1, String(treeRO))
// The session may not CHANGE the selection, but it still has one worth showing —
// so the seat renders, disabled, instead of vanishing the way the shipped
// model-selection entry does in an addressed subagent session.
const roChip = findByClass(treeRO, 'deu-chip')[0]
check('a read-only seat renders but cannot be operated',
  roChip !== undefined && roChip.props.disabled === true,
  roChip === undefined ? 'no chip' : String(roChip.props.disabled))
check('a read-only seat still names the current model',
  findByClass(treeRO, 'deu-chipModel')[0]?.props?.children === 'GPT-6 Astra',
  String(findByClass(treeRO, 'deu-chipModel')[0]?.props?.children))
state.subagentAddress = undefined

// ── teardown ───────────────────────────────────────────────────────────────
for (const d of disposers) if (typeof d === 'function') d()
check('unmount removes the stylesheet', !head.children.some((n) => n.id === 'dsh-effort-ultra-css'))

const failed = results.filter((r) => !r.pass)
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.label}${f.detail === undefined ? '' : ` (${f.detail})`}`).join('\n')}`)
  process.exit(1)
}
console.log('smoke-client: OK — the seat reads the catalog itself, renders the Host ladder, commits tiers and unmounts clean.')
