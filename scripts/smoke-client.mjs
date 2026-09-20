// Smoke-test the BROWSER half without a browser.
//
// Loads lib/client.js into a stubbed `window.__ModuleLoader__` with a stub React
// and a fake `modelDirectories`, then drives the real component: it must
// register the seat at the right priority, render the tier ladder the Host
// declares, commit `{ provider, model, reasoningEffort }` through the official
// `select` verb, and unmount without leaving a <style> element behind.
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

// ── stub React ─────────────────────────────────────────────────────────────
// Hook state lives in a swappable frame so a handler can trigger a re-render.
const createReact = () => {
  let frame = { slots: [], index: 0, effects: [] }
  let onRerender = null
  const effectCleanups = []
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
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
      const set = (next) => {
        frame.slots[i] = typeof next === 'function' ? next(frame.slots[i]) : next
        if (onRerender !== null) onRerender()
      }
      return [frame.slots[i], set]
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    // Effects are recorded and flushed by runEffects() after the render that
    // declared them. A no-op here would silently hide "do X on mount" behaviour.
    useEffect: (fn, deps) => {
      frame.effects.push({ fn, deps })
    },
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  return {
    React,
    beginRender: (rerender) => { onRerender = rerender; frame = { slots: frame.slots, index: 0, effects: [] } },
    keepState: () => { const s = frame.slots; frame = { slots: s, index: 0, effects: [] } },
    /**
     * Drop all hook state and reset the call cursor — what actually happens when
     * a seat unmounts and a new one mounts. Resetting the slot array without the
     * cursor would make the next render read hook state at the wrong positions.
     */
    freshMount: () => { frame = { slots: [], index: 0, effects: [] } },
    /** Run the effects declared by the most recent render. */
    runEffects: () => {
      const pending = frame.effects
      frame.effects = []
      for (const { fn } of pending) {
        const cleanup = fn()
        if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      }
    },
    /** How many effects the most recent render declared. */
    pendingEffects: () => frame.effects.length,
    /** Tear down every effect cleanup collected so far. */
    disposeEffects: () => {
      for (const cleanup of effectCleanups.splice(0)) cleanup()
    },
  }
}

// ── stub DOM ───────────────────────────────────────────────────────────────
const head = { children: [], appendChild(n) { this.children.push(n); n.parentNode = this }, removeChild(n) {
  const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null
} }
const document = {
  head,
  createElement: (tag) => ({ tagName: tag.toUpperCase(), id: '', textContent: '', attributes: new Map(),
    setAttribute(k, v) { this.attributes.set(k, String(v)) }, getAttribute(k) { return this.attributes.get(k) ?? null },
    parentNode: null }),
  addEventListener: () => {},
  removeEventListener: () => {},
}

// ── the fake official directory ────────────────────────────────────────────
const makeDirectory = (efforts, options = {}) => {
  // `in` rather than `??` for groups: an intentionally empty group list is
  // falsy-ish in spirit but must not silently fall back to the default fixture,
  // or a test that thinks it is exercising "no models" is really testing the
  // happy path (this exact mistake made an earlier assertion pass for the wrong
  // reason).
  const groups = 'groups' in options ? options.groups : [{
    id: 'relay',
    name: 'Relay',
    models: [{
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      reasoning: { defaultEffort: 'high', efforts },
    }],
  }]
  const snapshot = {
    status: options.status ?? 'ready',
    current: 'current' in options ? options.current : { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'ultra' },
    groups,
    routable: true,
  }
  const calls = { load: 0, select: [], subscribe: 0, snapshot: 0 }
  return {
    calls,
    // exposed so a test can simulate the store changing
    setCurrent: (current) => { snapshot.current = current },
    snapshot,
    store: {
      subscribe: () => { calls.subscribe += 1; return () => {} },
      getSnapshot: () => {
        calls.snapshot += 1
        // `unstable: true` models the shape that shipped in v0.1.0: a fresh
        // object per call. react-dom compares snapshots by reference, so a
        // component feeding this straight into useSyncExternalStore loops until
        // it dies with React error #185. The fake has to reproduce that shape or
        // it can never catch the bug.
        return options.unstable === true ? { ...snapshot } : snapshot
      },
    },
    load: () => { calls.load += 1; return Promise.resolve() },
    select: (selection) => { calls.select.push(selection); return Promise.resolve() },
  }
}

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'ultra', name: 'Ultra' },
]

// ── load the bundle ────────────────────────────────────────────────────────
// The seat schedules its catalog retries through setTimeout. Running timers
// synchronously keeps every retry assertion observable without making the suite
// wait real milliseconds.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = (fn) => { fn(); return 0 }
globalThis.clearTimeout = () => {}

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

check('plugin injects only services that exist at boot',
  Array.isArray(plugin.inject) && plugin.inject.includes('slots') && !plugin.inject.includes('modelDirectories'),
  JSON.stringify(plugin.inject))

// ── drive apply() with a stub ctx ──────────────────────────────────────────
const disposers = []
const serviceListeners = []
let seatRegistration = null
const localeDicts = []
const directory = makeDirectory(EFFORTS)

const ctx = {
  get: (name) => {
    if (name === 'modelDirectories') return { directoryFor: () => directory }
    if (name === 'sessions') return { subagentAddress: () => undefined }
    if (name === 'locale') {
      return {
        register: (ns, dicts) => { localeDicts.push({ ns, dicts }); return () => {} },
        bind: () => (key) => ({ reasoning: '推理等级', providerDefault: '跟随模型默认',
          noEfforts: '当前模型无档位', loading: '加载中', error: '失败', model: '模型', barLabel: '档位' }[key] ?? key),
      }
    }
    return undefined
  },
  effect: (fn) => { disposers.push(fn()) },
  on: (name, listener) => { serviceListeners.push({ name, listener }); return () => {} },
  slots: {
    inject: (name, cb) => { cb(); return () => {} },
    register: (options, component) => { seatRegistration = { options, component }; return () => {} },
  },
}
plugin.apply(ctx)

check('stylesheet appended to head', head.children.some((n) => n.id === 'dsh-effort-ultra-css'))
const css = head.children.find((n) => n.id === 'dsh-effort-ultra-css')?.textContent ?? ''
check('css is balanced', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, `${css.length} chars`)
check('css avoids foreign class names', !/_3_LLuW_|_7KE1Ra_/.test(css))
check('locale dictionaries registered', localeDicts.length === 1 && localeDicts[0].ns === 'effort-ultra')
// The service can appear after this plugin loads. Without this listener the seat
// would simply never register, with no error to point at.
check('plugin watches internal/service so a late directory still registers',
  serviceListeners.some((l) => l.name === 'internal/service'), JSON.stringify(serviceListeners.map((l) => l.name)))

check('seat registered on conversation.input.model',
  seatRegistration?.options?.name === 'conversation.input.model', seatRegistration?.options?.name)
// The seat must WIN the slot. Registering behind the shipped entry (1) deadlocked:
// the catalog retries live inside this component, so an entry that never renders
// can never load anything. Pinned here so the deadlock cannot come back.
check('seat priority takes the slot so the retry can run',
  seatRegistration?.options?.priority === -20, String(seatRegistration?.options?.priority))

// ── render ─────────────────────────────────────────────────────────────────
const props = seatRegistration.options.inject('session-1')
check('inject resolves the official directory store', props.directory === directory.store)
check('inject reports the seat as available', props.available === true)

let tree = null
const render = () => {
  react.beginRender(() => { react.keepState(); tree = seatRegistration.component(props) })
  react.keepState()
  tree = seatRegistration.component(props)
}

/**
 * Render the seat and flush the effects that render declared, the way React
 * does after a commit. Tests that care about mount-time behaviour (asking the
 * directory to load, installing the store subscription) must use this rather
 * than calling the component directly.
 *
 * Re-renders while a render declares fresh effects, because an effect that
 * schedules follow-up work (the catalog retry) only becomes observable when the
 * render it triggers runs again. Bounded so a runaway loop fails the suite
 * instead of hanging it.
 *
 * @param overrides - props merged over the seat's injected props.
 * @returns the rendered element tree.
 */
const renderCommitted = (overrides = {}) => {
  let tree = null
  for (let pass = 0; pass < 12; pass += 1) {
    react.keepState()
    tree = seatRegistration.component({ ...props, ...overrides })
    const pending = react.pendingEffects()
    if (pending === 0) break
    react.runEffects()
  }
  return tree
}

/**
 * Same as renderCommitted, but for a brand-new seat instance: component-local
 * refs are dropped first, the way a fresh mount (a new session) starts. Tests
 * that assert on mount-time decisions must use this, or a previous scenario's
 * refs leak in.
 *
 * @param overrides - props merged over the seat's injected props.
 * @returns the rendered element tree.
 */
const renderFresh = (overrides = {}) => {
  react.freshMount()
  return renderCommitted(overrides)
}

// ── the empty-directory window ─────────────────────────────────────────────
const findByClass = (node, cls, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(cls)) out.push(node)
  const kids = node.props?.children
  for (const kid of Array.isArray(kids) ? kids : [kids]) if (kid !== undefined && kid !== null) findByClass(kid, cls, out)
  return out
}

// ── the empty-directory window ─────────────────────────────────────────────
// Runs BEFORE any warm render on purpose. Taking the seat is a one-way latch for
// an instance (it must not flicker back to the shipped control mid-session), so
// once a populated render has happened this instance can no longer exhibit the
// yielding behaviour. The shipped model-selection entry at priority 0 is not
// just another renderer — mounting it is what drives the shared directory's
// catalog load — so rendering null here is what keeps that load path alive
// instead of pinning the seat on "loading" forever.
const cold = makeDirectory(EFFORTS, { groups: [], current: null, status: 'loading' })
const coldProps = { ...props, directory: cold.store, load: () => { cold.calls.load += 1 } }
let treeCold = undefined
for (let pass = 0; pass < 8; pass += 1) {
  react.keepState()
  treeCold = seatRegistration.component(coldProps)
  react.runEffects()
  if (treeCold !== null) break
}
check('an unloaded directory renders nothing, yielding the seat',
  treeCold === null, String(treeCold))
check('mounting the seat asks the directory to load',
  cold.calls.load >= 1, `load calls: ${cold.calls.load}`)
// The catalog loader runs once in a constructor and swallows its failure, so a
// transient startup failure would otherwise pin the seat on "loading" forever.
check('a directory stuck in loading is retried, not abandoned',
  cold.calls.load > 1 && cold.calls.load <= 8, `load calls: ${cold.calls.load}`)

// …and once the directory carries data, the same instance takes the seat over.
cold.snapshot.groups = [{
  id: 'relay',
  name: 'Relay',
  models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: { defaultEffort: 'high', efforts: EFFORTS } }],
}]
cold.snapshot.current = { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'ultra' }
cold.snapshot.status = 'ready'
react.keepState()
const treeWarm = seatRegistration.component(coldProps)
react.runEffects()
check('once the directory is populated the seat renders its own control',
  treeWarm !== null && findByClass(treeWarm, 'deu-root').length === 1)

// A fresh mount for the remaining scenarios: this instance has now latched.
react.freshMount()
render()

check('chip renders with the model label', findByClass(tree, 'deu-chipModel')[0]?.props?.children === 'GPT-6 Astra')
check('chip shows the current tier name', findByClass(tree, 'deu-chipTier')[0]?.props?.children === 'Ultra')
check('panel is closed on first render', findByClass(tree, 'deu-panel').length === 0)
check('top tier flags the root for the hotter animation', tree.props['data-top'] === 'true')

// open the panel
findByClass(tree, 'deu-chip')[0].props.onClick()
check('opening the panel calls load()', directory.calls.load === 1, String(directory.calls.load))
check('panel opens after the click', findByClass(tree, 'deu-panel').length === 1)

const segs = findByClass(tree, 'deu-seg')
check('one segment per Host-declared tier', segs.length === EFFORTS.length, String(segs.length))
check('segments up to the active tier are filled',
  segs.filter((s) => s.props.className.includes('deu-segOn')).length === EFFORTS.length,
  String(segs.filter((s) => s.props.className.includes('deu-segOn')).length))

// pick the middle tier
segs[1].props.onClick()
check('select() got provider + model + the picked tier',
  directory.calls.select.length === 1
  && directory.calls.select[0].provider === 'relay'
  && directory.calls.select[0].model === 'gpt-6-astra'
  && directory.calls.select[0].reasoningEffort === 'medium',
  JSON.stringify(directory.calls.select[0]))

// "follow the model default" drops reasoningEffort entirely
findByClass(tree, 'deu-reset')[0].props.onClick()
check('reset omits reasoningEffort (lets the model default apply)',
  directory.calls.select.length === 2 && !('reasoningEffort' in directory.calls.select[1]),
  JSON.stringify(directory.calls.select[1]))

// ── Host contract edge cases ───────────────────────────────────────────────
// Each scenario gets a FRESH mount. The component caches the directory snapshot
// so store writes cannot tear a render; reusing the instance above would show
// the previous scenario's cached state instead of the new store.
const cliff = makeDirectory(EFFORTS)
cliff.snapshot.current = { provider: 'relay', model: 'gpt-6-astra' }   // no explicit choice
react.freshMount()
const tree2 = seatRegistration.component({ ...props, directory: cliff.store })
// The panel is still open from the interactions above, and an open panel
// replaces the chip — so read the tier label from the panel head.
const head2 = findByClass(tree2, 'deu-headValue')[0]?.props?.children ?? findByClass(tree2, 'deu-chipTier')[0]?.props?.children
check('no explicit choice shows the model default label', head2 === '跟随模型默认', String(head2))
check('no explicit choice is not flagged as the top tier', tree2.props['data-top'] === 'false', String(tree2.props['data-top']))

// A model that EXISTS but declares no reasoning ladder — the real-world case,
// not "no models at all" (which would leave nothing to render a control for).
const bare = makeDirectory(EFFORTS)
bare.snapshot.groups[0].models[0].reasoning = undefined
react.freshMount()
react.keepState()   // reset the hook cursor for the fresh mount
const treeB0 = seatRegistration.component({ ...props, directory: bare.store })
findByClass(treeB0, 'deu-chip')[0].props.onClick()
react.keepState()
const treeB = seatRegistration.component({ ...props, directory: bare.store })
check('a model with no ladder renders a note, not a broken bar',
  findByClass(treeB, 'deu-note').length === 1 && findByClass(treeB, 'deu-barWrap').length === 0)
check('a model with no ladder still shows its name on the chip',
  findByClass(treeB, 'deu-headValue').length === 1)

// ── regression: the v0.1.0 field failure ──────────────────────────────────
// v0.1.0 fed `useSyncExternalStore(() => store.getSnapshot())` straight to
// react-dom. When the real store re-creates its snapshot per call, react-dom
// sees a change on every render and aborts with React error #185 ("Maximum
// update depth exceeded"), which is what crashed the seat in the field. The
// old fake always returned one frozen object, so the suite stayed green.
const unstable = makeDirectory(EFFORTS, { unstable: true })
react.keepState()
const treeU = seatRegistration.component({ ...props, directory: unstable.store })
check('an unstable store still renders a usable ladder',
  findByClass(treeU, 'deu-chipTier').length + findByClass(treeU, 'deu-headValue').length > 0)
check('an unstable store does not re-read the snapshot per render',
  unstable.calls.snapshot <= 2, `getSnapshot calls: ${unstable.calls.snapshot}`)

// the injected hook must be preferred when the renderer supplies one
let hookCalls = 0
const withHook = {
  ...props,
  directory: unstable.store,
  useModelDirectory: (selector) => { hookCalls += 1; return selector(unstable.snapshot) },
}
react.keepState()
const treeH = seatRegistration.component(withHook)
check('the renderer-injected hook is used when present', hookCalls === 1, `hook calls: ${hookCalls}`)
check('the injected hook path renders the ladder',
  findByClass(treeH, 'deu-chipTier').length + findByClass(treeH, 'deu-headValue').length > 0)

// ── teardown leaves nothing behind ─────────────────────────────────────────
for (const d of disposers) if (typeof d === 'function') d()
check('unmount removes the stylesheet', !head.children.some((n) => n.id === 'dsh-effort-ultra-css'))

const failed = results.filter((r) => !r.pass)
// Restore the real timers before reporting: leaving them synchronous would
// affect anything Node does afterwards.
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.label}${f.detail === undefined ? '' : ` (${f.detail})`}`).join('\n')}`)
  process.exit(1)
}
console.log('smoke-client: OK — native seat registers, renders the Host ladder, commits selections and unmounts clean.')
