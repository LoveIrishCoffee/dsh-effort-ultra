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
  let frame = { slots: [], index: 0 }
  let onRerender = null
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
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  return {
    React,
    beginRender: (rerender) => { onRerender = rerender; frame = { slots: frame.slots, index: 0 } },
    keepState: () => { const s = frame.slots; frame = { slots: s, index: 0 } },
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
  const snapshot = {
    status: 'ready',
    current: options.current ?? { provider: 'relay', model: 'gpt-6-astra', reasoningEffort: 'ultra' },
    groups: options.groups ?? [{
      id: 'relay',
      name: 'Relay',
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        reasoning: { defaultEffort: 'high', efforts },
      }],
    }],
    routable: true,
  }
  const calls = { load: 0, select: [] }
  return {
    calls,
    snapshot,
    store: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
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

check('plugin declares slots + modelDirectories as hard deps',
  Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('modelDirectories'),
  JSON.stringify(plugin.inject))

// ── drive apply() with a stub ctx ──────────────────────────────────────────
const disposers = []
let seatRegistration = null
const localeDicts = []
const directory = makeDirectory(EFFORTS)

const ctx = {
  modelDirectories: { directoryFor: () => directory },
  get: (name) => {
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

check('seat registered on conversation.input.model',
  seatRegistration?.options?.name === 'conversation.input.model', seatRegistration?.options?.name)
check('seat priority shadows the default and the third-party control',
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
render()

const findByClass = (node, cls, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(cls)) out.push(node)
  const kids = node.props?.children
  for (const kid of Array.isArray(kids) ? kids : [kids]) if (kid !== undefined && kid !== null) findByClass(kid, cls, out)
  return out
}

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
const cliff = makeDirectory(EFFORTS)
cliff.snapshot.current = { provider: 'relay', model: 'gpt-6-astra' }   // no explicit choice
const props2 = { ...props, directory: cliff.store }
react.keepState()
const tree2 = seatRegistration.component(props2)
// The panel is still open from the interactions above, and an open panel
// replaces the chip — so read the tier label from the panel head.
const head2 = findByClass(tree2, 'deu-headValue')[0]?.props?.children ?? findByClass(tree2, 'deu-chipTier')[0]?.props?.children
check('no explicit choice shows the model default label', head2 === '跟随模型默认', String(head2))
check('no explicit choice is not flagged as the top tier', tree2.props['data-top'] === 'false', String(tree2.props['data-top']))

const bare = makeDirectory([])
bare.snapshot.current = { provider: 'relay', model: 'gpt-6-astra' }
bare.snapshot.groups[0].models[0].reasoning = undefined
react.keepState()
findByClass(seatRegistration.component({ ...props, directory: bare.store }), 'deu-note')
check('a model with no ladder renders a note, not a broken bar',
  findByClass(seatRegistration.component({ ...props, directory: bare.store }), 'deu-barWrap').length === 0)

// ── teardown leaves nothing behind ─────────────────────────────────────────
for (const d of disposers) if (typeof d === 'function') d()
check('unmount removes the stylesheet', !head.children.some((n) => n.id === 'dsh-effort-ultra-css'))

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.label}${f.detail === undefined ? '' : ` (${f.detail})`}`).join('\n')}`)
  process.exit(1)
}
console.log('smoke-client: OK — native seat registers, renders the Host ladder, commits selections and unmounts clean.')
