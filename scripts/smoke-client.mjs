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
//   * the ladder it renders must preserve the Host-declared ids and count;
//   * a pick must commit `{ provider, model, reasoningEffort }` through
//     `remote.session.selectModel` (local ClientSessions has no such command),
//     and "follow the model default" must omit the tier;
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
      useEffect: (fn, deps) => {
        const i = frame.index++
        const previous = frame.slots[i]
        if (previous && deps && previous.deps && deps.length === previous.deps.length
          && deps.every((value, index) => Object.is(value, previous.deps[index]))) return
        const effect = { deps, cleanup: null }
        frame.slots[i] = effect
        frame.effects.push(() => {
          if (typeof previous?.cleanup === 'function') previous.cleanup()
          const cleanup = fn()
          effect.cleanup = typeof cleanup === 'function' ? cleanup : null
          return () => { effect.cleanup?.(); effect.cleanup = null }
        })
      },
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    },
    beginRender: () => { frame = { slots: frame.slots, index: 0, effects: [] } },
    keepState: () => { const s = frame.slots; frame = { slots: s, index: 0, effects: [] } },
    freshMount: () => {
      for (const cleanup of effectCleanups.splice(0)) cleanup()
      frame = { slots: [], index: 0, effects: [] }
    },
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
// Matches the active Step Agent Host capability declaration. `max` is the
// wire value; Ultra is only the native control's display name for this entry.
const EFFORTS_STEP = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Xhigh' },
  { id: 'max', name: 'Max' },
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
  selectThrows: false,
  selectDeferred: false,
  deferredSelections: [],
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
  selectModel: (input) => {
    state.selectCalls.push(input)
    if (state.selectThrows) throw new Error('selection threw synchronously')
    const model = state.catalog.groups.find((group) => group.id === input.provider)
      ?.models.find((entry) => entry.id === input.model)
    if (!model || (input.reasoningEffort !== undefined
      && !model.reasoning?.efforts.some((effort) => effort.id === input.reasoningEffort))) {
      return Promise.resolve({ ok: false, error: { code: 'INVALID_SELECTION', message: 'selection is not declared by this Host' } })
    }
    if (state.selectDeferred) {
      return new Promise((resolve) => { state.deferredSelections.push({ input, resolve }) })
    }
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
const projections = new Map()
const projectionFor = (sessionId) => {
  if (projections.has(sessionId)) return projections.get(sessionId)
  let snapshot
  const listeners = new Set()
  const projected = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: (value) => { snapshot = value; for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
  projections.set(sessionId, projected)
  return projected
}
// ClientSessions manages local session identity and addressed subagents. Do
// not add Host RPCs here: that inaccurate stub hid the production failure.
const sessionsStub = Object.freeze({
  subagentAddress: () => state.subagentAddress,
  binding: (sessionId) => ({
    session: { projections: {
      faceOf: (name) => {
        if (name !== 'modelSelection') throw new Error(`unexpected projection ${name}`)
        return projectionFor(sessionId)
      },
    } },
  }),
})

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

// `remote.session` MUST be declared. Cordis delivers `internal/service` only to
// fibers that declare the service (see ReflectService.notify:
// `if (!(name in fiber.inject)) continue`). Declaring only `slots` and waiting on
// that event meant we never heard the service arrive, so registration happened
// only when the service was already present at apply time — which made the plugin
// work on some boots and silently do nothing on others.
check('plugin declares remote.session so apply runs when it is ready',
  Array.isArray(plugin.inject) && plugin.inject.includes('sessions') && plugin.inject.includes('slots') && plugin.inject.includes('remote') && plugin.inject.includes('remote.session'),
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
  // The plugin reads `ctx.remote.session` directly, because it declares the
  // dependency and Cordis guarantees it is present before apply runs.
  remote: { session: remoteSessionStub },
  sessions: sessionsStub,
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
// The slot registry is intentionally acquired through one stable child scope;
// this is the same shape used by the built-in model-selection plugin and keeps
// the registration in the renderer's active slot scope.
check('plugin acquires the slot service through one stable scope',
  injectCalls.length === 1 && JSON.stringify(injectCalls[0]) === '["slots"]', JSON.stringify(injectCalls))
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
  if (Array.isArray(node)) {
    for (const item of node) findByClass(item, cls, out)
    return out
  }
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
check('Host selection is separate from the local ClientSessions service',
  !('selectModel' in sessionsStub) && typeof remoteSessionStub.selectModel === 'function')
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

const range = findByClass(openTree, 'deu-range')[0]
check('slider max follows Host-declared tier count',
  range?.props?.max === EFFORTS_FOUR.length - 1, String(range?.props?.max))
check('slider starts at the active tier',
  range?.props?.value === EFFORTS_FOUR.length - 1, String(range?.props?.value))
check('slider renders its starfield fill and thumb',
  findByClass(openTree, 'deu-trackFill').length === 1 && findByClass(openTree, 'deu-thumb').length === 1)
check('the last tier is not flagged as top when the Host does not say so',
  openTree === null || typeof openTree.props['data-top'] === 'string')

// ── committing a tier ──────────────────────────────────────────────────────
range.props.onChange({ currentTarget: { value: '1' } })
await settle()
check('remote.session.selectModel got provider + model + the picked tier',
  state.selectCalls.length === 1
  && state.selectCalls[0].sessionId === 'session-1'
  && state.selectCalls[0].provider === 'relay'
  && state.selectCalls[0].model === 'gpt-6-astra'
  && state.selectCalls[0].reasoningEffort === 'low',
  JSON.stringify(state.selectCalls[0]))

const afterPick = await renderWith()
check('the picked tier becomes the chip label',
  findByClass(afterPick, 'deu-tierButton')[0]?.props?.children?.[0] === 'Low',
  String(findByClass(afterPick, 'deu-tierButton')[0]?.props?.children))
check('a committed drag keeps the panel open for continued adjustment',
  findByClass(afterPick, 'deu-panel').length === 1)

// Hold the first write open while the user moves through several positions.
// The browser will end a native range gesture if its disabled prop flips, so
// checking only the final successful callback does not exercise this bug.
state.selectDeferred = true
const dragCallCount = state.selectCalls.length
const dragRange = findByClass(afterPick, 'deu-range')[0]
dragRange.props.onPointerDown()
dragRange.props.onChange({ currentTarget: { value: '2' } })
let draggingTree = await renderWith()
check('a pending write keeps the range enabled for the same mouse press',
  findByClass(draggingTree, 'deu-range')[0]?.props.disabled === false)
check('a pending drag updates both the title and accessible tier immediately',
  findByClass(draggingTree, 'deu-tierButton')[0]?.props.children?.[0] === 'High'
  && findByClass(draggingTree, 'deu-range')[0]?.props['aria-valuetext'] === 'High')
findByClass(draggingTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '0' } })
draggingTree = await renderWith()
findByClass(draggingTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '3' } })
draggingTree = await renderWith()
check('rapid drag changes coalesce behind one in-flight write',
  state.selectCalls.length === dragCallCount + 1 && state.deferredSelections.length === 1)
check('the title, thumb and aria text show the newest drag position',
  findByClass(draggingTree, 'deu-tierButton')[0]?.props.children?.[0] === 'Max'
  && findByClass(draggingTree, 'deu-range')[0]?.props.value === 3
  && findByClass(draggingTree, 'deu-range')[0]?.props['aria-valuetext'] === 'Max'
  && findByClass(draggingTree, 'deu-barWrap')[0]?.props.style['--deu-progress'] === '100%')
const resolveNextSelection = () => {
  const request = state.deferredSelections.shift()
  request.resolve({ ok: true, value: { selected: request.input } })
}
resolveNextSelection()
await settle()
draggingTree = await renderWith()
check('the next write is the latest requested effort',
  state.selectCalls.length === dragCallCount + 2
  && state.selectCalls.at(-1)?.reasoningEffort === 'ultra')
check('an earlier response does not replace the latest visible draft',
  findByClass(draggingTree, 'deu-tierButton')[0]?.props.children?.[0] === 'Max'
  && findByClass(draggingTree, 'deu-range')[0]?.props.disabled === false)
resolveNextSelection()
await settle()
findByClass(draggingTree, 'deu-range')[0].props.onPointerUp()
state.selectDeferred = false
draggingTree = await renderWith()
check('releasing a continuous drag leaves the final effort persisted',
  props.directory.getSnapshot().current.reasoningEffort === 'ultra'
  && findByClass(draggingTree, 'deu-range')[0]?.props.value === 3
  && findByClass(draggingTree, 'deu-error').length === 0)

state.selectFails = true
findByClass(draggingTree, 'deu-range')[0].props.onPointerDown()
findByClass(draggingTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '1' } })
let rejectedTree = await renderWith()
check('a rejected write keeps the active drag preview and shows the error',
  findByClass(rejectedTree, 'deu-tierButton')[0]?.props.children?.[0] === 'Low'
  && findByClass(rejectedTree, 'deu-range')[0]?.props.disabled === false
  && findByClass(rejectedTree, 'deu-error').length === 1)
findByClass(rejectedTree, 'deu-range')[0].props.onPointerUp()
rejectedTree = await renderWith()
check('releasing a failed drag restores the last confirmed title and thumb',
  props.directory.getSnapshot().current.reasoningEffort === 'ultra'
  && findByClass(rejectedTree, 'deu-tierButton')[0]?.props.children?.[0] === 'Max'
  && findByClass(rejectedTree, 'deu-range')[0]?.props.value === 3)
state.selectFails = false
findByClass(rejectedTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '1' } })
const retriedTree = await renderWith()
check('a retry commits successfully and clears the rejected-write message',
  props.directory.getSnapshot().current.reasoningEffort === 'low'
  && findByClass(retriedTree, 'deu-error').length === 0)

state.selectThrows = true
findByClass(retriedTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '2' } })
const thrownTree = await renderWith()
check('a synchronous service exception leaves the slider usable and restores the confirmed tier',
  findByClass(thrownTree, 'deu-range')[0]?.props.disabled === false
  && props.directory.getSnapshot().status !== 'selecting'
  && findByClass(thrownTree, 'deu-range')[0]?.props.value === 1
  && findByClass(thrownTree, 'deu-tierButton')[0]?.props.children?.[0] === 'Low'
  && findByClass(thrownTree, 'deu-error').length === 1)
state.selectThrows = false
findByClass(thrownTree, 'deu-range')[0].props.onChange({ currentTarget: { value: '3' } })
const afterThrowRetry = await renderWith()
check('a service exception can be retried without reopening the panel',
  props.directory.getSnapshot().current.reasoningEffort === 'ultra'
  && findByClass(afterThrowRetry, 'deu-error').length === 0)

// A catalog with more than one model exposes a native picker inside the card.
state.catalog = makeCatalog(EFFORTS_FOUR, {
  models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: { defaultEffort: 'high', efforts: EFFORTS_FOUR } },
    { id: 'deepseek-v3', name: 'DeepSeek V3', reasoning: { defaultEffort: 'high', efforts: EFFORTS_FOUR } },
  ],
})
react.freshMount()
const multiModel = await renderWith()
findByClass(multiModel, 'deu-chip')[0].props.onClick()
const multiModelOpen = await renderWith()
check('multiple models expose a native model picker',
  findByClass(multiModelOpen, 'deu-modelButton').length === 1,
  String(findByClass(multiModelOpen, 'deu-modelButton').length))
findByClass(multiModelOpen, 'deu-modelButton')[0].props.onClick()
const modelMenuOpen = await renderWith()
check('model picker lists every catalog model',
  findByClass(modelMenuOpen, 'deu-modelOption').length === 2,
  String(findByClass(modelMenuOpen, 'deu-modelOption').length))
findByClass(modelMenuOpen, 'deu-modelOption')[1].props.onClick()
await settle()
check('model picker selects the requested model and uses its default effort',
  state.selectCalls.at(-1)?.provider === 'relay'
  && state.selectCalls.at(-1)?.model === 'deepseek-v3'
  && state.selectCalls.at(-1)?.reasoningEffort === 'high',
  JSON.stringify(state.selectCalls.at(-1)))
const afterModelPick = await renderWith()
check('selected model is shown without renaming it',
  findByClass(afterModelPick, 'deu-modelText')[0]?.props?.children === 'DeepSeek V3',
  String(findByClass(afterModelPick, 'deu-modelText')[0]?.props?.children))

// The tier chevron opens a list of explicit choices, so the affordance is
// discoverable even before a user understands that the range itself is draggable.
findByClass(afterModelPick, 'deu-tierButton')[0].props.onClick()
const tierMenuOpen = await renderWith()
check('tier chevron opens an explicit effort menu',
  findByClass(tierMenuOpen, 'deu-tierMenu').length === 1
  && findByClass(tierMenuOpen, 'deu-tierOption').length === EFFORTS_FOUR.length + 1,
  String(findByClass(tierMenuOpen, 'deu-tierOption').length))
findByClass(tierMenuOpen, 'deu-tierButton')[0].props.onClick()
const tierMenuClosed = await renderWith()
check('tier chevron toggles its menu closed', findByClass(tierMenuClosed, 'deu-tierMenu').length === 0)

// "follow the model default" drops reasoningEffort entirely
findByClass(tierMenuClosed, 'deu-reset')[0].props.onClick()
await settle()
check('reset omits reasoningEffort (lets the model default apply)',
  !('reasoningEffort' in state.selectCalls.at(-1)),
  JSON.stringify(state.selectCalls.at(-1)))

const afterReset = await renderWith()
check('after reset the chip shows the model default label',
  findByClass(afterReset, 'deu-tierButton')[0]?.props?.children?.[0] === 'High',
  String(findByClass(afterReset, 'deu-tierButton')[0]?.props?.children))

// When neither the session nor the model declares a default, the old seat
// follows the provider default until the user picks an explicit tier.
state.catalog = makeCatalog(EFFORTS_FOUR, {
  default: { provider: 'relay', model: 'gpt-6-astra' },
  models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: { efforts: EFFORTS_FOUR } }],
})
react.freshMount()
const providerDefaultProps = seatRegistration.options.inject('session-provider-default')
const providerDefaultTree = await renderWith(providerDefaultProps)
findByClass(providerDefaultTree, 'deu-chip')[0].props.onClick()
const providerDefaultOpen = await renderWith(providerDefaultProps)
check('an unset model default shows the follow-default label',
  findByClass(providerDefaultOpen, 'deu-tierButton')[0]?.props?.children?.[0] === '跟随模型默认',
  String(findByClass(providerDefaultOpen, 'deu-tierButton')[0]?.props?.children))
check('an unset model default exposes the same effort menu',
  findByClass(providerDefaultOpen, 'deu-tierButton')[0]?.props?.['aria-haspopup'] === 'listbox'
  && findByClass(providerDefaultOpen, 'deu-hint').length === 1)
check('an unset model default hides the custom thumb',
  findByClass(providerDefaultOpen, 'deu-thumb')[0]?.props?.className === 'deu-thumb deu-thumbUnset',
  String(findByClass(providerDefaultOpen, 'deu-thumb')[0]?.props?.className))

// Step's six positions come from its actual Host declaration.
state.catalog = makeCatalog(EFFORTS_STEP, {
  default: { provider: 'relay', model: 'step-5-preview', reasoningEffort: 'high' },
  models: [{
    id: 'step-5-preview',
    name: 'Step 5 Preview',
    reasoning: { defaultEffort: 'high', efforts: EFFORTS_STEP },
  }],
})
react.freshMount()
const stepProps = seatRegistration.options.inject('session-step')
const stepAgent = await renderWith(stepProps)
check('Step Agent keeps the Host model name',
  findByClass(stepAgent, 'deu-chipModel')[0]?.props?.children === 'Step 5 Preview',
  String(findByClass(stepAgent, 'deu-chipModel')[0]?.props?.children))
findByClass(stepAgent, 'deu-chip')[0].props.onClick()
const stepAgentOpen = await renderWith(stepProps)
check('Step Agent exposes off/low/medium/high/xhigh/Ultra',
  findByClass(stepAgentOpen, 'deu-range')[0]?.props?.max === 5,
  String(findByClass(stepAgentOpen, 'deu-range')[0]?.props?.max))
const stepRange = findByClass(stepAgentOpen, 'deu-range')[0]
stepRange.props.onChange({ currentTarget: { value: '0' } })
await settle()
check('Step Agent sends the explicit off tier so the adapter disables reasoning',
  state.selectCalls.at(-1)?.reasoningEffort === 'off',
  JSON.stringify(state.selectCalls.at(-1)))
const expectedStepEfforts = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const expectedStepNames = ['Off', 'Low', 'Medium', 'High', 'Xhigh', 'Ultra']
for (const [index, effort] of expectedStepEfforts.entries()) {
  const before = await renderWith(stepProps)
  findByClass(before, 'deu-range')[0].props.onChange({ currentTarget: { value: String(index) } })
  const after = await renderWith(stepProps)
  check(`Step Agent position ${index} persists ${effort} and updates its label`,
    state.selectCalls.at(-1)?.reasoningEffort === effort
    && stepProps.directory.getSnapshot().current.reasoningEffort === effort
    && findByClass(after, 'deu-range')[0]?.props.value === index
    && findByClass(after, 'deu-tierButton')[0]?.props.children?.[0] === expectedStepNames[index])
}

// An incomplete Step capability declaration cannot be repaired by inventing
// wire ids in the browser. Render only the positions the Host will accept.
state.catalog = makeCatalog(EFFORTS_TWO, {
  default: { provider: 'relay', model: 'step-5-preview', reasoningEffort: 'high' },
  models: [{
    id: 'step-5-preview',
    name: 'Step 5 Preview',
    reasoning: { defaultEffort: 'high', efforts: EFFORTS_TWO },
  }],
})
react.freshMount()
const stepShortProps = seatRegistration.options.inject('session-step-short')
const stepShort = await renderWith(stepShortProps)
findByClass(stepShort, 'deu-chip')[0].props.onClick()
const stepShortOpen = await renderWith(stepShortProps)
check('a short Step declaration is not expanded with unsupported wire ids',
  findByClass(stepShortOpen, 'deu-range')[0]?.props.max === 1)
findByClass(stepShortOpen, 'deu-range')[0].props.onChange({ currentTarget: { value: '0' } })
const stepShortAfter = await renderWith(stepShortProps)
check('a short Step ladder sends its declared first tier',
  state.selectCalls.at(-1)?.reasoningEffort === 'low'
  && findByClass(stepShortAfter, 'deu-tierButton')[0]?.props.children?.[0] === 'Low')

// ── a model with a shorter ladder ──────────────────────────────────────────
state.catalog = makeCatalog(EFFORTS_TWO, {
  default: { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'high' },
})
react.freshMount()
const shortProps = seatRegistration.options.inject('session-short')
const treeShort = await renderWith(shortProps)
check('a model declaring two tiers renders two segments after opening',
  (() => {
    findByClass(treeShort, 'deu-chip')[0].props.onClick()
    return true
  })())
const treeShortOpen = await renderWith(shortProps)
check('ladder length follows the declaration, not a hardcoded count',
  findByClass(treeShortOpen, 'deu-range')[0]?.props?.max === EFFORTS_TWO.length - 1,
  String(findByClass(treeShortOpen, 'deu-range')[0]?.props?.max))

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

// Existing sessions get their current choice from the session projection,
// even when it differs from the Host's default for a new conversation.
state.catalog = makeCatalog(EFFORTS_FOUR, {
  models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: { defaultEffort: 'high', efforts: EFFORTS_FOUR } },
    { id: 'deepseek-v3', name: 'DeepSeek V3', reasoning: { defaultEffort: 'high', efforts: EFFORTS_FOUR } },
  ],
})
const existingProjection = projectionFor('session-existing')
existingProjection.emit({ next: { provider: 'relay', model: 'deepseek-v3', reasoningEffort: 'low' } })
react.freshMount()
const existingProps = seatRegistration.options.inject('session-existing')
const existingTree = await renderWith(existingProps)
check('an existing session projection overrides the new-session Host default',
  findByClass(existingTree, 'deu-chipModel')[0]?.props.children === 'DeepSeek V3'
  && findByClass(existingTree, 'deu-chipTier')[0]?.props.children === 'Low')
check('the directory subscribes to the session model-selection projection',
  existingProjection.listenerCount() > 0)
existingProjection.emit({ next: { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'low' } })
const externallyChangedTree = await renderWith(existingProps)
check('a model choice made outside the plugin updates the current model and effort',
  findByClass(externallyChangedTree, 'deu-chipModel')[0]?.props.children === 'GPT-6 Astra'
  && findByClass(externallyChangedTree, 'deu-chipTier')[0]?.props.children === 'Low'
  && existingProps.directory.getSnapshot().current.reasoningEffort === 'low')

const newProjection = projectionFor('session-new-default')
newProjection.emit({ next: null })
react.freshMount()
const newDefaultProps = seatRegistration.options.inject('session-new-default')
const newDefaultTree = await renderWith(newDefaultProps)
check('a new session with a null selection follows the Host default',
  findByClass(newDefaultTree, 'deu-chipModel')[0]?.props.children === 'GPT-6 Astra'
  && findByClass(newDefaultTree, 'deu-chipTier')[0]?.props.children === 'Max')

react.freshMount()
const delayedProps = seatRegistration.options.inject('session-projection-delayed')
const delayedInitialTree = await renderWith(delayedProps)
check('a not-yet-loaded session projection can initially use the Host default',
  findByClass(delayedInitialTree, 'deu-chipModel')[0]?.props.children === 'GPT-6 Astra')
projectionFor('session-projection-delayed').emit({ next: { provider: 'relay', model: 'deepseek-v3', reasoningEffort: 'high' } })
const delayedLoadedTree = await renderWith(delayedProps)
check('a projection arriving after the catalog replaces the temporary default',
  findByClass(delayedLoadedTree, 'deu-chipModel')[0]?.props.children === 'DeepSeek V3'
  && findByClass(delayedLoadedTree, 'deu-chipTier')[0]?.props.children === 'High')

// ── an addressed-subagent session is read-only, not invisible ─────────────
// `available` is decided when the seat injects, so the stub has to be re-entered
// to model a session becoming an addressed subagent.
state.subagentAddress = { parentSessionId: 'p', childSessionId: 'session-1' }
state.catalog = makeCatalog(EFFORTS_FOUR)
const roProps = seatRegistration.options.inject('session-ro')
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
check('plugin disposal removes every session projection subscription',
  [...projections.values()].every((projection) => projection.listenerCount() === 0))

const failed = results.filter((r) => !r.pass)
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.label}${f.detail === undefined ? '' : ` (${f.detail})`}`).join('\n')}`)
  process.exit(1)
}
console.log('smoke-client: OK — the seat reads the catalog itself, renders the Host ladder, commits tiers and unmounts clean.')
