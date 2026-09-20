// dsh-effort-ultra — BROWSER half.
//
// A native reasoning-effort control for the DSH composer. It owns the
// `conversation.input.model` seat and talks to the official
// `modelDirectories` service, so it depends on no third-party plugin and
// restyles nothing it did not render itself.
//
// Interface contract (verified against the shipped DSH packages, not guessed):
//   - `ctx.modelDirectories.directoryFor(sessionId)` returns a directory whose
//     `store` is a snapshot store and whose `load()` / `select(selection)`
//     drive the official persistence path.
//   - A seat registers via
//     `ctx.slots.register({ name, priority, locale, inject }, Component)`.
//     The renderer calls the component with
//     `{ ...kit, ...inject(sessionId), ...ownerProps }`.
//   - Snapshot shape:
//       { status, current: { provider, model, reasoningEffort? } | null,
//         groups: [ { id, name, models: [ { id, name, reasoning?: {
//           defaultEffort?, efforts: [ { id, name } ] } } ] } ], routable }
//   - `model.reasoning.efforts[].name` arrives already localised from the Host,
//     so this file ships no tier vocabulary of its own.
//   - A single-kind slot resolves to its lowest-priority live entry.
//   - `modelDirectories` is NOT a hard dependency. Declaring it in `inject`
//     parks the whole plugin until the service exists, and if the service
//     appears later the plugin can stay parked with `apply` never called —
//     which is silent and looks exactly like "the bundle never loaded". The
//     shipped model-selection plugin avoids this by injecting only stable
//     services and waiting for the rest through `internal/service`; this file
//     follows that pattern.

// One line at evaluation time. A plugin whose client half never runs is
// otherwise indistinguishable from one that is simply not installed, and this
// plugin has already been parked once by a dependency that never arrived.
console.log('[effort-ultra] bundle evaluated')

window.__ModuleLoader__.load({
  id: 'dsh-effort-ultra',
  factory: (require) => {
    const React = require('react')
    const { useState, useCallback, useEffect, useRef, createElement: h } = React

    const SLOT_NAME = 'conversation.input.model'
    const LOCALE_NS = 'effort-ultra'
    const STYLE_ID = 'dsh-effort-ultra-css'
    const SEP = '\u0000'
    /**
     * The seat registers at a WINNING priority, and that is deliberate - the
     * opposite of the previous attempt. DSH resolves this slot to its
     * lowest-priority live entry, and the shipped model-selection entry sits
     * at 0, so a value below 0 takes the seat from it.
     *
     * Registering behind it (priority 1) looked safer but deadlocked: the seat
     * drives its catalog retries from inside its own component, so an entry
     * that is never rendered can never load anything - no seat, no retry, no
     * data, no seat. Rendering null while the directory is empty is what keeps
     * the composer clean, and that only works because this entry is rendered.
     */
    const SEAT_PRIORITY = -20
    /** Backoff between catalog reload attempts while the directory reads "loading". */
    const LOAD_RETRY_MS = 1500
    /** Attempts before the seat settles on its error face instead of retrying forever. */
    const MAX_LOAD_RETRIES = 5

    const zh = {
      reasoning: '推理等级',
      providerDefault: '跟随模型默认',
      noEfforts: '当前模型未提供推理等级。',
      loading: '读取模型目录…',
      error: '切换失败，请重试。',
      model: '模型',
      barLabel: '推理档位',
    }
    const en = {
      reasoning: 'Reasoning effort',
      providerDefault: 'Follow model default',
      noEfforts: 'This model provides no reasoning effort levels.',
      loading: 'Loading model directory…',
      error: 'Switch failed, please retry.',
      model: 'Model',
      barLabel: 'Reasoning effort tiers',
    }

    // ── styling ────────────────────────────────────────────────────────────
    // Colors go through --dsw-alias-* tokens with literal fallbacks. The one
    // deliberate exception is the brand gradient: the alias table has no violet
    // and the violet end is the point of the design, so the three gradient
    // stops live in plugin-owned --effort-* properties and are the only place
    // theme branching happens. Never `[data-theme]` selectors.
    const CSS = [
      '.deu-root{min-width:0;font-size:13px;line-height:20px;display:flex;position:relative;',
      'color:var(--dsw-alias-label-primary,#0f1115);--effort-a:#4d93f8;--effort-b:#2563eb;',
      '--effort-c:#8b5cf6;--effort-star:rgba(255,255,255,.92);',
      '--effort-glow:rgba(139,92,246,.55);--effort-bar-h:26px}',
      'body[data-ds-dark-theme] .deu-root{--effort-a:#5686fe;--effort-b:#3b6ef0;--effort-c:#a06bff}',

      '.deu-chip{min-width:0;max-width:min(360px,100vw - 80px);height:28px;padding:0 10px;cursor:pointer;',
      'font:inherit;display:flex;align-items:center;gap:8px;border-radius:999px;',
      'border:1px solid color-mix(in srgb,var(--effort-a) 26%,transparent);',
      'background:linear-gradient(120deg,color-mix(in srgb,var(--effort-a) 13%,transparent) 0%,',
      'color-mix(in srgb,var(--effort-c) 15%,transparent) 100%);box-shadow:0 1px 2px rgba(0,0,0,.05);',
      'transition:box-shadow 160ms ease,border-color 160ms ease,background 160ms ease}',
      '.deu-chip:hover:not(:disabled){border-color:color-mix(in srgb,var(--effort-a) 46%,transparent);',
      'background:linear-gradient(120deg,color-mix(in srgb,var(--effort-a) 20%,transparent) 0%,',
      'color-mix(in srgb,var(--effort-c) 24%,transparent) 100%);box-shadow:0 1px 6px -1px var(--effort-glow)}',
      '.deu-chip:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 60%,transparent);outline-offset:2px}',
      '.deu-chip:disabled{cursor:default;color:var(--dsw-alias-label-dimmed,#a2a4a6)}',
      '.deu-chipModel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.deu-chipTier{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;font-weight:600;',
      'background:color-mix(in srgb,var(--effort-a) 14%,transparent);',
      'color:color-mix(in srgb,var(--effort-a) 82%,var(--dsw-alias-label-primary,#0f1115))}',
      '.deu-chevron{flex:none;width:14px;height:14px;display:grid;place-items:center;',
      'color:var(--dsw-alias-label-secondary,#61666b)}',
      '.deu-chevron::before{content:"";width:6px;height:6px;border-right:1px solid;border-bottom:1px solid;',
      'transform:rotate(45deg) translateY(-2px)}',

      '.deu-panel{z-index:60;position:absolute;bottom:calc(100% + 8px);right:0;width:min(336px,100vw - 32px);',
      'box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px 16px 14px;border-radius:14px;',
      'background:var(--dsw-specific-menu,#fff);border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.14));',
      'color:var(--dsw-alias-label-primary,#0f1115)}',
      '.deu-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;min-width:0}',
      '.deu-headLabel{font-weight:600}',
      '.deu-headValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;',
      'background:linear-gradient(92deg,var(--effort-a),var(--effort-c));-webkit-background-clip:text;',
      'background-clip:text;-webkit-text-fill-color:transparent;color:transparent}',

      '.deu-barWrap{position:relative;height:var(--effort-bar-h)}',
      '.deu-bar{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);height:var(--effort-bar-h);',
      'display:flex;align-items:stretch;border-radius:999px;overflow:hidden;',
      'background:var(--dsw-alias-border-l2,rgba(127,132,140,.22));box-shadow:inset 0 1px 2px rgba(0,0,0,.16)}',
      '.deu-seg{flex:1 1 0;min-width:0;padding:0;border:0;background:transparent;cursor:pointer;position:relative;',
      'border-radius:999px;transition:background 160ms ease;overflow:hidden}',
      '.deu-seg:not(.deu-segOn):hover{background:color-mix(in srgb,var(--effort-a) 10%,transparent)}',
      '.deu-seg:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 60%,transparent);outline-offset:1px}',
      '.deu-segOn{background-image:',
      'radial-gradient(circle at 14% 42%,var(--effort-star) 0 .9px,transparent 1.7px),',
      'radial-gradient(circle at 38% 70%,rgba(255,255,255,.72) 0 .8px,transparent 1.6px),',
      'radial-gradient(circle at 62% 30%,rgba(255,255,255,.85) 0 .9px,transparent 1.7px),',
      'radial-gradient(circle at 86% 62%,rgba(255,255,255,.66) 0 .8px,transparent 1.6px),',
      'linear-gradient(92deg,var(--effort-a) 0%,var(--effort-b) 46%,var(--effort-c) 100%);',
      'background-size:86px 100%,112px 100%,134px 100%,158px 100%,100% 100%;',
      'background-repeat:repeat-x,repeat-x,repeat-x,repeat-x,no-repeat;',
      'box-shadow:0 2px 10px -2px var(--effort-glow);animation:deuStars 6s linear infinite}',
      '.deu-segOn::after{content:"";position:absolute;top:0;bottom:0;left:-50%;width:46%;border-radius:999px;',
      'background:linear-gradient(100deg,transparent 0%,rgba(255,255,255,.42) 50%,transparent 100%);',
      'animation:deuSheen 2.6s cubic-bezier(.45,0,.55,1) infinite}',
      '.deu-root[data-top="true"] .deu-segOn{animation-duration:3.4s,2s}',
      '.deu-root[data-top="true"] .deu-bar{box-shadow:inset 0 1px 2px rgba(0,0,0,.16),',
      '0 0 0 1px color-mix(in srgb,var(--effort-c) 22%,transparent)}',

      '.deu-scale{display:flex;align-items:center;gap:6px;min-width:0}',
      '.deu-scale>*{flex:1 1 0;min-width:0;text-align:center;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);',
      'transition:color 140ms ease}',
      '.deu-scale>.deu-on{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',

      '.deu-row{display:flex;flex-direction:column;gap:6px}',
      '.deu-rowLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.deu-select{width:100%;box-sizing:border-box;height:32px;padding:0 8px;border-radius:8px;font:inherit;',
      'color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-2,#f5f5f5);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}',
      '.deu-select:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 60%,transparent);outline-offset:1px}',
      '.deu-reset{min-height:32px;display:flex;align-items:center;gap:8px;padding:4px 8px;border:0;border-radius:8px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;text-align:left;cursor:pointer}',
      '.deu-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.deu-reset::before{content:"";flex:0 0 14px;width:14px;height:14px;box-sizing:border-box;border-radius:50%;',
      'border:2px solid var(--dsw-alias-border-l1,rgba(0,0,0,.2));background:var(--dsw-specific-menu,#fff)}',
      '.deu-reset[aria-pressed="true"]{color:var(--effort-a);font-weight:600}',
      '.deu-reset[aria-pressed="true"]::before{border-color:var(--effort-a);background:var(--effort-a);',
      'box-shadow:inset 0 0 0 3px var(--dsw-specific-menu,#fff)}',

      '.deu-note{color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.deu-error{color:var(--dsw-alias-state-error-primary,#ec1313)}',

      '@keyframes deuSheen{0%{left:-50%;opacity:0}12%{opacity:1}70%{opacity:1}100%{left:104%;opacity:0}}',
      '@keyframes deuStars{0%{background-position:0 0,0 0,0 0,0 0,0 0}',
      '100%{background-position:86px 0,-112px 0,134px 0,-158px 0,0 0}}',
      '@media (prefers-reduced-motion:reduce){',
      '.deu-segOn,.deu-segOn::after{animation:none}.deu-segOn::after{opacity:0}}',
    ].join('')

    /** Current model row for a snapshot, or undefined when nothing is selected. */
    const modelOf = (state) => {
      const current = state.current
      if (current === null || current === undefined) return undefined
      for (const group of state.groups) {
        if (group.id !== current.provider) continue
        for (const model of group.models) if (model.id === current.model) return model
      }
      return undefined
    }

    /**
     * A tiny snapshot store with a STABLE identity.
     *
     * This is deliberately not the official `directory.store`. That one is
     * reached through `modelDirectories.directoryFor(sessionId)`, whose first
     * construction for a NEW session runs `new ModelDirectory(...)` → touches
     * `ctx.remote.session` on the resolver's own context, and throws "cannot get
     * property 'remote.session' without inject". The resolver's injection is not
     * something a third-party plugin can fix, and the shipped seat walks the
     * same path.
     *
     * So this plugin owns its adapter instead: it reads the same Host catalog
     * through `remote.session.modelCatalog()` — the same call the official
     * resolver makes — and keeps the current selection itself. The snapshot
     * shape matches a directory store on purpose, so the component above is
     * unchanged.
     *
     * @param initial - initial snapshot.
     * @returns a store with getSnapshot/subscribe/set.
     */
    const makeStore = (initial) => {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        set: (next) => {
          snapshot = { ...snapshot, ...next }
          for (const fn of [...listeners]) {
            try { fn() } catch (error) { console.error('[effort-ultra] subscriber failed:', error) }
          }
        },
      }
    }

    /**
     * Per-session adapter over the Host catalog.
     *
     * Reads the same `remote.session.modelCatalog()` the official resolver reads,
     * and commits through `sessions.selectModel` — the same verb the official
     * directory uses. It exists so the seat does not go through
     * `modelDirectories.directoryFor`, whose new-session path throws
     * "cannot get property 'remote.session' without inject" from the resolver's
     * own context — an injection a third-party plugin cannot supply.
     *
     * @param options - remote session face, sessions service, session id.
     * @returns `{ store, load, select }` shaped like a directory.
     */
    const createSessionDirectory = ({ remoteSession, sessions, sessionId }) => {
      const store = makeStore({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: 'loading',
        error: null,
      })
      let inflight = null

      const load = () => {
        if (inflight !== null) return inflight
        const attempt = Promise.resolve(remoteSession.modelCatalog()).then((response) => {
          if (response === null || response === undefined || response.ok !== true) {
            const message = response !== null && response !== undefined && response.error !== undefined
              ? String(response.error.code) + ': ' + String(response.error.message)
              : 'modelCatalog returned no value'
            store.set({ status: 'error', error: message })
            throw new Error(message)
          }
          const value = response.value
          const previous = store.getSnapshot().current
          const current = previous ?? value.default ?? null
          store.set({
            current,
            groups: value.groups,
            failures: Array.isArray(value.failures) ? value.failures : [],
            routable: Array.isArray(value.routableProviders) && current !== null
              ? value.routableProviders.includes(current.provider)
              : null,
            status: 'ready',
            error: null,
          })
          return store.getSnapshot()
        }).finally(() => { inflight = null })
        inflight = attempt
        return attempt
      }

      const select = async (selection) => {
        store.set({ status: 'selecting', error: null })
        const result = await sessions.selectModel({
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        })
        if (result === null || result === undefined || result.ok !== true) {
          const message = result !== null && result !== undefined && result.error !== undefined
            ? String(result.error.code) + ': ' + String(result.error.message)
            : 'selectModel returned no value'
          store.set({ status: 'error', error: message })
          throw new Error(message)
        }
        const selected = result.value !== undefined && result.value.selected !== undefined
          ? result.value.selected
          : selection
        store.set({
          current: {
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          },
          status: 'ready',
          error: null,
        })
      }

      return { store, load, select }
    }

    /**
     * The ladder in force: the Host-declared `efforts`, the effective tier, and
     * whether that tier is the model's own default (no explicit choice pinned).
     */
    const ladderOf = (state) => {
      const model = modelOf(state)
      const reasoning = model === undefined ? undefined : model.reasoning
      const efforts = reasoning === undefined ? undefined : reasoning.efforts
      if (!Array.isArray(efforts) || efforts.length === 0) return null
      const chosen = state.current === null ? undefined : state.current.reasoningEffort
      const effective = chosen === undefined ? reasoning.defaultEffort : chosen
      const found = efforts.findIndex((level) => level.id === effective)
      return {
        model,
        efforts,
        chosen,
        effective,
        index: found < 0 ? 0 : found,
        onDefault: chosen === undefined,
      }
    }

    const selectionFor = (provider, model, effortId) => ({
      provider,
      model,
      ...(effortId === undefined ? {} : { reasoningEffort: effortId }),
    })

    /**
     * Subscribe to the directory store while keeping a STABLE snapshot identity.
     *
     * Why this is not a bare `useSyncExternalStore(subscribe, () => store.getSnapshot())`:
     * react-dom compares `getSnapshot()` results by reference, so a store that
     * re-creates its snapshot object per call makes every render look like a
     * store change and react-dom aborts with "Maximum update depth exceeded"
     * (minified React error #185). That is exactly how the first release of this
     * plugin failed in the field, and why a stub store returning one frozen
     * object could never catch it in tests.
     *
     * The renderer's own bridge is preferred when it is present, because DSH
     * caches that bridge per source at the binding site. The fallback keeps a
     * cache of its own and only republishes when the store really changed.
     *
     * @param props - the seat's injected props.
     * @returns the current directory snapshot.
     */
    function useDirectorySnapshot(props) {
      const directory = props.directory
      const injected = props.useModelDirectory
      const [, bump] = useState(0)
      // The cache is keyed by store so a seat pointed at a different directory
      // (a session switch) re-reads immediately instead of showing stale state.
      const cache = useRef({ directory: undefined, value: undefined })

      useEffect(() => {
        cache.current.directory = directory
        cache.current.value = directory.getSnapshot()
        bump((n) => n + 1)
        return directory.subscribe(() => {
          const next = directory.getSnapshot()
          if (next === cache.current.value) return
          cache.current.value = next
          bump((n) => n + 1)
        })
      }, [directory])

      if (typeof injected === 'function') return injected((snapshot) => snapshot)
      if (cache.current.directory !== directory) {
        cache.current.directory = directory
        cache.current.value = directory.getSnapshot()
      }
      return cache.current.value
    }

    function EffortUltra(props) {
      const directory = props.directory
      const load = props.load
      const select = props.select
      const available = props.available !== false
      const locked = props.locked === true
      const t = props.t ?? ((key) => key)

      const state = useDirectorySnapshot(props)

      // Take the seat only once there is something real to draw.
      //
      // The shipped model-selection entry at priority 0 is not just another
      // renderer: mounting it is what drives the shared directory's catalog
      // load. Taking the seat unconditionally (priority -20, the first attempt)
      // shadowed that entry, the catalog never loaded, and this control sat on
      // "loading" forever — the failure seen in the field.
      //
      // So this registration sits BEHIND the shipped one and yields until the
      // directory carries data. Rendering null is what lets the shipped entry
      // mount, load the catalog, and hand the seat over on the next render.
      //
      // NOTE: every hook must run before the yield. Returning early above them
      // would change the hook count between renders.
      // Populated means "there is a ladder to draw", not "the store is idle".
      // A status check here would be wrong: committing a pick sets the status to
      // 'selecting', and treating that as unpopulated made the control vanish for
      // the duration of every tier change.
      const populated = state.groups.length > 0
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const rootRef = useRef(null)
      const retries = useRef(0)
      const reported = useRef(false)
      const initialLoad = useRef(true)
      const tookSeat = useRef(false)
      if (populated) tookSeat.current = true

      // A directory starts at `{ current: null, groups: [], status: 'loading' }`
      // and leaves that state only once the shared catalog reaches `ready`.
      // The catalog's own loader runs exactly once, in a constructor, and
      // swallows its failure — so a single transient failure at startup leaves
      // the seat reading "loading" forever, with no retry anywhere in the stack.
      //
      // These effects MUST sit above the yield below. The seat only takes the
      // seat once the directory carries data, so a retry placed after the yield
      // would never run: no load → no data → no seat → no load.
      // Kick the load off on mount, unconditionally. It must not be coupled to
      // whether the seat has already taken the slot: a read-only session takes
      // the slot immediately (its catalog may never arrive), and gating the first
      // load on "not yet populated" left such a seat reading `loading` forever.
      useEffect(() => {
        const initial = initialLoad.current
        initialLoad.current = false
        if (typeof load === 'function') load()
        return () => { void initial }
      }, [load])

      // Retry while the directory is still empty, so a transient startup failure
      // heals instead of pinning the seat on its placeholder. The official
      // catalog loader runs exactly once, in a constructor, and swallows its own
      // failure — there is no retry anywhere below this.
      useEffect(() => {
        if (typeof load !== 'function') return undefined
        if (state.groups.length > 0) return undefined
        if (state.status === 'selecting') return undefined
        if (retries.current >= MAX_LOAD_RETRIES) {
          // Diagnosable dead end: nothing arrived even after every retry.
          if (!reported.current) {
            reported.current = true
            console.warn('[effort-ultra] model catalog still unavailable after ' + String(MAX_LOAD_RETRIES) +
              ' attempts. snapshot=' +
              JSON.stringify({ status: state.status, error: state.error ?? null, groups: state.groups.length }))
          }
          return undefined
        }
        retries.current += 1
        const handle = setTimeout(() => { load() }, LOAD_RETRY_MS * retries.current)
        return () => clearTimeout(handle)
      }, [load, state.status, state.groups.length])
      useEffect(() => {
        if (state.groups.length === 0) return
        retries.current = 0
        reported.current = false
      }, [state.groups.length])

      // `available` is about WRITES, not about rendering. A session that may not
      // change the selection (an addressed subagent) still has a selection worth
      // showing, and the shipped plugin renders nothing there — which is why the
      // composer looks empty. Render read-only instead of disappearing.
      const readOnly = !available
      const disabled = locked || readOnly || busy

      // Yield the seat while the directory is still empty ... unless this is a
      // read-only session. In an addressed-subagent session the directory's own
      // `load()` refuses, so waiting for data would wait forever and the seat
      // would stay invisible; showing a read-only placeholder is the honest
      // result there.
      if (!tookSeat.current && !readOnly) return null

      const commit = useCallback((selection) => {
        setBusy(true)
        setFailed(false)
        Promise.resolve(select(selection)).then((ok) => {
          setBusy(false)
          if (ok === false) {
            setFailed(true)
            return
          }
          // Collapse on success so the chip's updated tier label is visible —
          // the chip renders only while the panel is closed.
          setOpen(false)
        }, () => {
          setBusy(false)
          setFailed(true)
        })
      }, [select])

      // Dismiss on outside press and Escape while the panel is open.
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const current = state.current
      const ladder = ladderOf(state)
      const noSelection = current === null
      const catalogueError = typeof state.error === 'string' && state.error.length > 0 ? state.error : null
      // Before the directory's first populated snapshot there is no model label
      // to show. A bare chevron is a broken-looking control, so fall back to
      // copy that describes the state instead of rendering nothing.
      const modelLabel = ladder !== null
        ? ladder.model.name
        : noSelection
          ? t(state.status === 'error' ? 'loadFailed' : 'loading')
          : current.model
      const tierName = ladder === null
        ? undefined
        : ladder.chosen === undefined
          ? t('providerDefault')
          : (ladder.efforts.find((level) => level.id === ladder.effective) ?? {}).name ?? ladder.effective
      const topSelected = ladder !== null && ladder.index === ladder.efforts.length - 1

      const setTier = (effortId) => {
        if (current === null) return
        commit(selectionFor(current.provider, current.model, effortId))
      }

      const chip = h('button', {
        className: 'deu-chip',
        type: 'button',
        disabled,
        'aria-expanded': open,
        'aria-label': modelLabel === '' ? t('reasoning') : `${modelLabel}: ${tierName ?? ''}`,
        onClick: () => {
          if (disabled) return
          // Toggle. The chip is only rendered while the panel is closed, but a
          // stray click during the handover must not be able to pin the panel
          // open with no way back.
          setOpen((wasOpen) => !wasOpen)
          if (typeof load === 'function') load()
        },
      },
        h('span', { className: 'deu-chipModel' }, modelLabel),
        tierName === undefined ? null : h('span', { className: 'deu-chipTier' }, tierName),
        h('span', { className: 'deu-chevron', 'aria-hidden': true }),
      )

      const bar = ladder === null ? null : h('div', { className: 'deu-barWrap' },
        h('div', { className: 'deu-bar', role: 'group', 'aria-label': t('barLabel') },
          ...ladder.efforts.map((level, index) => h('button', {
            key: level.id,
            className: index <= ladder.index ? 'deu-seg deu-segOn' : 'deu-seg',
            type: 'button',
            disabled,
            'aria-pressed': index === ladder.index,
            'aria-label': level.name,
            'data-deu-tier': level.id,
            onClick: () => setTier(level.id),
          })),
        ),
      )

      const scale = ladder === null ? null : h('div', { className: 'deu-scale' },
        ...ladder.efforts.map((level, index) => h('span', {
          key: level.id,
          className: index === ladder.index ? 'deu-on' : undefined,
        }, level.name)),
      )

      const modelRow = state.groups.length <= 1 ? null : h('label', { className: 'deu-row' },
        h('span', { className: 'deu-rowLabel' }, t('model')),
        h('select', {
          className: 'deu-select',
          value: current === null ? '' : `${current.provider}${SEP}${current.model}`,
          disabled,
          onChange: (event) => {
            const split = event.target.value.indexOf(SEP)
            if (split < 0) return
            commit(selectionFor(event.target.value.slice(0, split), event.target.value.slice(split + 1), undefined))
          },
        },
          ...state.groups.flatMap((group) => group.models.map((model) => h('option', {
            key: `${group.id}${SEP}${model.id}`,
            value: `${group.id}${SEP}${model.id}`,
          }, state.groups.length > 1 ? `${group.name} · ${model.name}` : model.name))),
        ),
      )

      const reset = ladder === null || ladder.chosen === undefined ? null : h('button', {
        className: 'deu-reset',
        type: 'button',
        disabled,
        'aria-pressed': ladder.onDefault,
        onClick: () => setTier(undefined),
      }, t('providerDefault'))

      // When the directory reports a failure, show WHAT failed. Swallowing the
      // message would leave the user (and anyone debugging) with a generic line
      // and no way to tell a network failure from a rejected selection.
      const body = ladder !== null
        ? h(React.Fragment, null, bar, scale, reset)
        : catalogueError !== null
          ? h('div', { className: 'deu-note deu-error' }, `${t('loadFailed')}: ${catalogueError}`)
          : h('div', { className: 'deu-note' },
            t(state.status === 'loading' ? 'loading' : 'noEfforts'))

      const panel = open ? h('div', { className: 'deu-panel', 'data-deu-panel': 'true' },
        h('div', { className: 'deu-head' },
          h('span', { className: 'deu-headLabel' }, t('reasoning')),
          h('span', { className: 'deu-headValue' }, tierName ?? ''),
        ),
        body,
        modelRow,
        failed ? h('div', { className: 'deu-error' }, t('error')) : null,
      ) : null

      return h('div', {
        className: 'deu-root',
        ref: rootRef,
        'data-top': topSelected ? 'true' : 'false',
        'data-deu-root': 'true',
      }, panel, open ? null : chip)
    }

    return {
      // Only services that are always present at boot go here. `modelDirectories`
      // is deliberately resolved lazily in apply(): declaring it as a hard
      // dependency parks the whole plugin until it exists, and a plugin parked
      // that way never runs apply() and produces no diagnostic of its own.
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.setAttribute('data-dsh-plugin', 'effort-ultra')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }, 'effort-ultra: stylesheet')

        const sessions = ctx.get('sessions')
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(LOCALE_NS, { zh, en }), 'effort-ultra: dicts')
        }
        const bound = locale !== undefined && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NS)
          : undefined

        let registered = false
        /**
         * Register the seat once the remote face is readable.
         *
         * @param remoteSession - the `remote.session` service, passed explicitly.
         * @returns true when registration happened (or had already happened).
         */
        const registerWhenReady = (remoteSession) => {
          if (registered) return true
          if (remoteSession === undefined || typeof remoteSession.modelCatalog !== 'function') return false
          if (sessions === undefined || typeof sessions.selectModel !== 'function') return false
          registered = true
          const scopedSlots = ctx.get('slots')
          if (scopedSlots === undefined) return false

          // One adapter per session, created on first use and reused after.
          const directories = new Map()
          const adapterFor = (sessionId) => {
            const existing = directories.get(sessionId)
            if (existing !== undefined) return existing
            const created = createSessionDirectory({
              remoteSession,
              sessions,
              sessionId,
              t: bound,
            })
            directories.set(sessionId, created)
            return created
          }
          ctx.effect(() => () => directories.clear(), 'effort-ultra: session directories')

          scopedSlots.inject(SLOT_NAME, () => scopedSlots.register({
            name: SLOT_NAME,
            priority: SEAT_PRIORITY,
            locale: LOCALE_NS,
            inject: (sessionId) => {
              // This adapter is built in a scope that declares `remote.session`
              // (see the ctx.inject below), so the catalog call cannot hit the
              // injection guard that broke `modelDirectories.directoryFor` for
              // every new session.
              const directory = adapterFor(sessionId)
              const address = sessions === undefined || typeof sessions.subagentAddress !== 'function'
                ? undefined
                : sessions.subagentAddress(sessionId)
              // An addressed subagent session may not CHANGE the selection, which
              // is what the shipped plugin gates on. It must still LOAD the
              // catalog, though: gating the load on this left the seat reading an
              // empty store forever. Read always; write only when no address is
              // retained.
              const available = address === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  Promise.resolve(directory.load()).catch((error) => {
                    console.warn('[effort-ultra] load rejected: ' +
                      String(error && error.message ? error.message : error))
                  })
                },
                select: (selection) => available
                  ? Promise.resolve(directory.select(selection)).then(() => true, () => false)
                  : Promise.resolve(false),
                t: bound,
              }
            },
          }, EffortUltra))
          return true
        }

        // Resolve the remote face through `ctx.get`, which reads a service
        // WITHOUT the inject requirement, and retry on the service announcement.
        //
        // `ctx.inject(['remote', 'remote.session'], cb)` was the previous attempt
        // and it parked the plugin: when the declared services are not registered
        // yet, the callback simply never runs — and a parked plugin never reaches
        // apply(), silently. That is the same trap as declaring them in `inject`
        // at the top level; only the position differed.
        //
        // This way the plugin always applies, registers as soon as the face is
        // readable, and the adapter hands that face to `modelCatalog` explicitly
        // instead of reaching for a service from a context that does not declare
        // it — the guard that broke `modelDirectories.directoryFor`.
        const tryRegister = () => {
          const remoteSession = ctx.get('remote.session')
          if (remoteSession === undefined) return false
          return registerWhenReady(remoteSession)
        }
        if (tryRegister()) return
        ctx.on('internal/service', (serviceName) => {
          if (serviceName === 'remote.session' || serviceName === 'remote') tryRegister()
        })
      },
    }
  },
})
