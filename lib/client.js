// dsh-effort-ultra — BROWSER half.
//
// A native reasoning-effort control for the DSH composer. It owns the
// `conversation.input.model` seat and talks to the official
// `remote.session` catalog and selection services, so it depends on no third-party plugin and
// restyles nothing it did not render itself.
//
// Interface contract (verified against the shipped DSH packages, not guessed):
//   - `remote.session.modelCatalog()` returns the Host catalog and
//     `remote.session.selectModel(selection)` drives the official persistence path.
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
//   - The browser half declares only stable Cordis services. The Host catalog
//     is read through the remote session face so a new-session resolver cannot
//     strand the seat before the first render.

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
      reasoning: '推理档位',
      providerDefault: '跟随模型默认',
      noEfforts: '当前模型未提供推理等级。',
      loading: '读取模型目录…',
      error: '切换失败，请重试。',
      model: '模型',
      searchModels: '搜索模型',
      noModelResults: '没有匹配的模型',
      loadFailed: '模型目录加载失败',
      barLabel: '推理档位',
      reset: '恢复模型默认档位',
      adjustHint: '拖动或点击档位调整推理强度',
    }
    const en = {
      reasoning: 'Reasoning effort',
      providerDefault: 'Follow model default',
      noEfforts: 'This model provides no reasoning effort levels.',
      loading: 'Loading model directory…',
      error: 'Switch failed, please retry.',
      model: 'Model',
      searchModels: 'Search models',
      noModelResults: 'No matching models',
      loadFailed: 'Model directory failed to load',
      barLabel: 'Reasoning effort tiers',
      reset: 'Use model default',
      adjustHint: 'Drag the slider or choose a tier to adjust reasoning',
    }

    // ── styling ────────────────────────────────────────────────────────────
    // Colors go through --dsw-alias-* tokens with literal fallbacks. The one
    // deliberate exception is the brand gradient: the alias table has no violet
    // and the violet end is the point of the design, so the three gradient
    // stops live in plugin-owned --effort-* properties and are the only place
    // theme branching happens. Never `[data-theme]` selectors.
    const CSS = [
      '.deu-root{position:relative;display:inline-flex;align-items:center;min-width:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#111318);--effort-a:#2943bb;--effort-b:#a57fff;--effort-c:#6f51e2;--effort-track:#e9eaf4}',
      'body[data-ds-dark-theme] .deu-root{--effort-a:#3a6fe0;--effort-b:#9a82ff;--effort-c:#7958e6;--effort-track:#2c2e3d;color:#f4f5f8}',
      '.deu-chip{height:28px;min-width:0;max-width:min(240px,100vw - 44px);padding:0 3px;border:0;background:transparent;color:inherit;font:inherit;display:flex;align-items:center;gap:6px;cursor:pointer}',
      '.deu-chip:hover:not(:disabled){color:var(--effort-b)}.deu-chip:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 65%,transparent);outline-offset:3px}.deu-chip:disabled{opacity:.55;cursor:default}',
      '.deu-chipModel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7078);font-size:12px}',
      '.deu-chipTier{flex:none;color:var(--effort-b);font-weight:600;font-size:12px}',
      '.deu-chevron{flex:none;width:11px;height:14px;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary,#8c9098)}.deu-chevron::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg)}',
      '.deu-panel{z-index:60;position:absolute;right:0;bottom:calc(100% + 8px);width:226px;box-sizing:border-box;padding:10px 12px 9px;border:1px solid rgba(20,25,40,.09);border-radius:12px;background:var(--dsw-specific-menu,#fff);box-shadow:0 4px 14px rgba(25,30,45,.10);color:var(--dsw-alias-label-primary,#111318)}',
      'body[data-ds-dark-theme] .deu-panel{border-color:rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.32)}',
      '.deu-head{position:relative;display:flex;align-items:center;justify-content:center;min-height:20px}',
      '.deu-tierButton{display:inline-flex;align-items:center;gap:5px;padding:0;border:0;background:transparent;color:var(--effort-b);font-family:inherit;font-size:14px;font-weight:600;line-height:20px;cursor:pointer}',
      '.deu-tierButton:hover{color:var(--effort-c)}.deu-tierButton:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 55%,transparent);outline-offset:2px;border-radius:4px}',
      '.deu-tierChevron{flex:none;width:7px;height:7px;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg) translate(-1px,1px);transition:transform 120ms ease}.deu-tierButton[aria-expanded="true"] .deu-tierChevron{transform:rotate(135deg) translate(-1px,1px)}',
      '.deu-tierMenu{position:absolute;z-index:4;top:31px;left:12px;right:12px;max-height:214px;overflow:auto;padding:4px;border:1px solid rgba(20,25,40,.10);border-radius:8px;background:var(--dsw-specific-menu,#fff);box-shadow:0 5px 16px rgba(25,30,45,.14)}',
      'body[data-ds-dark-theme] .deu-tierMenu{border-color:rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.34)}',
      '.deu-tierOption{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:28px;padding:4px 7px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary,#111318);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}',
      '.deu-tierOption:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.deu-tierOptionSelected{color:var(--effort-b);font-weight:600}.deu-tierOptionMark{font-size:13px;line-height:18px}',
      '.deu-reset{position:absolute;right:-1px;top:0;width:20px;height:20px;padding:0;border:0;background:transparent;color:#8e8f94;font-size:16px;line-height:20px;font-family:Arial,sans-serif;cursor:pointer}',
      '.deu-reset::before{content:"↻";display:block;transform:translateY(-.5px)}.deu-reset:hover:not(:disabled){color:var(--effort-b)}.deu-reset:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 55%,transparent);outline-offset:1px;border-radius:50%}.deu-reset:disabled{opacity:.45;cursor:default}',
      '.deu-modelPicker{position:relative;margin-top:1px;display:flex;justify-content:center}',
      '.deu-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;color:var(--dsw-alias-label-tertiary,#858991);font-size:12px;line-height:17px}',
      '.deu-modelButton{max-width:100%;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#858991);font:inherit;font-size:12px;line-height:17px;cursor:pointer}',
      '.deu-modelButton:hover:not(:disabled){color:var(--effort-b)}.deu-modelButton:focus-visible{outline:2px solid color-mix(in srgb,var(--effort-a) 55%,transparent);outline-offset:2px;border-radius:4px}.deu-modelButton:disabled{opacity:.55;cursor:default}',
      '.deu-modelText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.deu-modelChevron{flex:none;width:6px;height:6px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg) translateY(-1px)}',
      '.deu-modelMenu{position:absolute;z-index:3;top:calc(100% + 6px);left:-1px;right:-1px;max-height:220px;overflow:auto;padding:4px;border:1px solid rgba(20,25,40,.10);border-radius:8px;background:var(--dsw-specific-menu,#fff);box-shadow:0 5px 16px rgba(25,30,45,.14)}',
      'body[data-ds-dark-theme] .deu-modelMenu{border-color:rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.34)}',
      '.deu-modelSearch{box-sizing:border-box;width:100%;height:28px;margin:0 0 4px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(20,25,40,.14));border-radius:5px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111318);font:inherit;font-size:12px;outline:none}',
      '.deu-modelSearch:focus{border-color:var(--effort-a);box-shadow:0 0 0 2px color-mix(in srgb,var(--effort-a) 22%,transparent)}',
      '.deu-modelGroup+.deu-modelGroup{margin-top:3px}.deu-modelGroupToggle{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:26px;padding:3px 7px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#858991);font:inherit;font-size:11px;line-height:18px;text-align:left;cursor:pointer}.deu-modelGroupToggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.deu-modelGroupChevron{width:6px;height:6px;margin-left:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg) translateY(-1px)}.deu-modelGroupChevronOpen{transform:rotate(225deg) translateY(-1px)}',
      '.deu-modelNoResults{padding:10px 4px;color:var(--dsw-alias-label-tertiary,#858991);font-size:12px;text-align:center}',
      '.deu-modelOption{display:block;width:100%;min-height:28px;padding:4px 7px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary,#111318);font:inherit;font-size:12px;line-height:18px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
      '.deu-modelOption:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.deu-modelOptionSelected{color:var(--effort-b);font-weight:600}',
      '.deu-barWrap{position:relative;height:30px;margin-top:8px;margin-right:14px}',
      '.deu-trackBase{position:absolute;left:0;right:0;top:3px;height:24px;border-radius:999px;background:var(--effort-track);box-shadow:inset 0 1px 2px rgba(20,25,45,.08)}',
      '.deu-trackFill{position:absolute;left:0;top:0;height:24px;width:var(--deu-progress,100%);min-width:24px;border-radius:999px;background-image:radial-gradient(circle at 12% 36%,rgba(255,255,255,.94) 0 1px,transparent 1.8px),radial-gradient(circle at 24% 70%,rgba(255,255,255,.76) 0 .8px,transparent 1.6px),radial-gradient(circle at 39% 24%,rgba(255,255,255,.88) 0 .9px,transparent 1.7px),radial-gradient(circle at 53% 63%,rgba(255,255,255,.88) 0 .8px,transparent 1.6px),radial-gradient(circle at 67% 32%,rgba(255,255,255,.74) 0 .9px,transparent 1.7px),radial-gradient(circle at 82% 70%,rgba(255,255,255,.92) 0 .9px,transparent 1.7px),linear-gradient(100deg,var(--effort-a) 0%,var(--effort-b) 54%,var(--effort-c) 100%);background-size:52px 100%,68px 100%,84px 100%,96px 100%,112px 100%,124px 100%,100% 100%;background-repeat:repeat-x,repeat-x,repeat-x,repeat-x,repeat-x,repeat-x,no-repeat;box-shadow:0 2px 8px rgba(98,91,229,.24);transition:width 120ms ease}',
      '.deu-trackFill[data-deu-unset=true]{min-width:0;background-image:none;box-shadow:none}',
      '.deu-trackFill::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(105deg,transparent 0%,rgba(255,255,255,.36) 48%,transparent 72%);background-size:190% 100%;animation:deuSheen 3.2s ease-in-out infinite}',
      '.deu-thumb{position:absolute;left:clamp(15px,var(--deu-progress,100%),calc(100% - 15px));top:15px;width:30px;height:30px;box-sizing:border-box;border:1px solid rgba(44,48,70,.13);border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(26,30,50,.12);transform:translate(-50%,-50%);pointer-events:none;transition:left 120ms ease}.deu-thumbUnset{opacity:0}',
      '.deu-range{position:absolute;z-index:2;left:0;right:0;top:3px;width:100%;height:24px;margin:0;opacity:0;cursor:pointer;appearance:none;touch-action:none}',
      '.deu-range:disabled{cursor:default}.deu-range:focus-visible{opacity:.16;outline:2px solid var(--effort-a);outline-offset:2px;border-radius:999px}',
      '.deu-scale{display:flex;align-items:center;gap:2px;margin:1px 14px 0 0;min-width:0}',
      '.deu-scaleItem{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;color:var(--dsw-alias-label-tertiary,#858991);font-size:10px;line-height:14px}',
      '.deu-scaleItem.deu-scaleActive{color:var(--effort-b);font-weight:600}',
      '.deu-hint{margin:4px 14px 0 0;color:var(--dsw-alias-label-tertiary,#858991);font-size:10px;line-height:14px;text-align:center}',
      '.deu-default{display:block;width:100%;margin-top:4px;padding:4px 6px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#858991);font:inherit;font-size:12px;text-align:left;cursor:pointer}.deu-default:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--effort-b)}.deu-default[aria-pressed=true]{color:var(--effort-b);font-weight:600}.deu-default:disabled{opacity:.55;cursor:default}',
      '.deu-note{padding:8px 2px 2px;text-align:center;color:var(--dsw-alias-label-tertiary,#858991);font-size:12px}.deu-error{color:var(--dsw-alias-state-error-primary,#d33b3b);font-size:12px;margin-top:6px}',
      '@keyframes deuSheen{0%,20%{background-position:140% 0;opacity:0}35%{opacity:.8}70%,100%{background-position:-80% 0;opacity:0}}',
      '@media (prefers-reduced-motion:reduce){.deu-trackFill::after{animation:none;opacity:0}}',
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
     * and commits through `remote.session.selectModel` — the same Host command
     * the official directory uses. It exists so the seat does not go through
     * `modelDirectories.directoryFor`, whose new-session path throws
     * "cannot get property 'remote.session' without inject" from the resolver's
     * own context — an injection a third-party plugin cannot supply.
     *
     * @param options - remote session face, a sessions getter, and the session id.
     * @returns `{ store, load, select }` shaped like a directory.
     */
    const createSessionDirectory = ({ remoteSession, sessionsOf, sessionId, projected }) => {
      const store = makeStore({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: 'loading',
        error: null,
      })
      let inflight = null
      let catalogValue = null
      let disposed = false
      let operation = 0

      // The projection is the session-local source of truth.  A missing
      // projection means that this DSH build does not expose the local
      // sessions facade to third-party bundles; in that case the catalog
      // default remains the best available value and the component can still
      // read the session hook supplied by the renderer.
      const currentFromProjection = () => {
        if (catalogValue === null) return null
        const value = projected === undefined ? undefined : projected.getSnapshot()
        if (value === undefined) {
          const previous = store.getSnapshot().current
          return previous ?? catalogValue.default ?? null
        }
        return value?.next ?? catalogValue.default ?? null
      }
      const syncProjection = () => {
        if (disposed || catalogValue === null) return
        const current = currentFromProjection()
        store.set({
          current,
          routable: Array.isArray(catalogValue.routableProviders) && current !== null
            ? catalogValue.routableProviders.includes(current.provider)
            : null,
          groups: catalogValue.groups,
          failures: Array.isArray(catalogValue.failures) ? catalogValue.failures : [],
          status: store.getSnapshot().status === 'selecting' ? 'selecting' : 'ready',
          error: null,
        })
      }
      let stopProjection = projected !== undefined && typeof projected.subscribe === 'function'
        ? projected.subscribe(syncProjection)
        : undefined

      const load = () => {
        if (disposed) return Promise.reject(new Error('model directory is disposed'))
        if (inflight !== null) return inflight
        const generation = ++operation
        const attempt = Promise.resolve().then(() => remoteSession.modelCatalog()).then((response) => {
          if (disposed || generation !== operation) return store.getSnapshot()
          if (response === null || response === undefined || response.ok !== true) {
            const message = response !== null && response !== undefined && response.error !== undefined
              ? String(response.error.code) + ': ' + String(response.error.message)
              : 'modelCatalog returned no value'
            store.set({ status: 'error', error: message })
            throw new Error(message)
          }
          const value = response.value
          catalogValue = value
          syncProjection()
          return store.getSnapshot()
        }).finally(() => { inflight = null })
        inflight = attempt
        return attempt
      }

      const select = async (selection) => {
        if (disposed) return false
        // The official command lives on the generated remote session face.
        // ClientSessions only owns session identity, bindings, and projections;
        // using a similarly named local method here would bypass the Host
        // persistence path and reproduce the old "switch failed" error.
        if (remoteSession === undefined || typeof remoteSession.selectModel !== 'function') {
          const message = 'model selection is unavailable: the session selectModel command is not readable'
          store.set({ status: 'error', error: message })
          throw new Error(message)
        }
        const generation = ++operation
        store.set({ status: 'selecting', error: null })
        let result
        try {
          result = await remoteSession.selectModel({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          })
        } catch (error) {
          if (!disposed && generation === operation) store.set({ status: 'error', error: String(error?.message ?? error) })
          throw error
        }
        if (disposed || generation !== operation) return false
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
        // The Host emits the projection asynchronously.  Keep the successful
        // selection visible immediately; a later projection frame will
        // replace it with the durable session value.
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

      const dispose = () => {
        if (disposed) return
        disposed = true
        ++operation
        if (typeof stopProjection === 'function') stopProjection()
        stopProjection = undefined
        inflight = null
      }

      return { store, load, select, dispose }
    }

    /**
     * Step's Agent route calls its highest wire level `max`; the old control
     * presents that final position as `Ultra`. Preserve every Host-declared
     * entry and only rename that declared terminal label. A short capability
     * declaration must stay short so the browser never submits an unsupported
     * wire id.
     */
    const effortsFor = (model, efforts) => {
      if (!model || !/step[- ]?5/i.test(String(model.id ?? ''))) return efforts
      return efforts.map((effort) => {
        const id = String(effort.id)
        if (id === 'max' || id === 'ultra') return { ...effort, name: 'Ultra' }
        return effort
      })
    }

    /**
     * The ladder in force: the Host-declared `efforts`, the effective tier, and
     * whether that tier is the model's own default (no explicit choice pinned).
     */
    const ladderOf = (state) => {
      const model = modelOf(state)
      const reasoning = model === undefined ? undefined : model.reasoning
      const efforts = reasoning === undefined || !Array.isArray(reasoning.efforts)
        ? undefined
        : effortsFor(model, reasoning.efforts)
      if (!Array.isArray(efforts) || efforts.length === 0) return null
      const chosen = state.current === null ? undefined : state.current.reasoningEffort
      const effective = chosen === undefined ? reasoning.defaultEffort : chosen
      const found = efforts.findIndex((level) => level.id === effective)
      // An absent explicit value and an absent model default are a distinct
      // state in the old seat: the slider follows the provider default and
      // keeps its thumb hidden until the user makes an explicit pick.
      const onDefault = chosen === undefined && reasoning.defaultEffort === undefined
      return {
        model,
        efforts,
        chosen,
        effective,
        index: found < 0 ? 0 : found,
        onDefault,
      }
    }

    // `undefined` means follow the model/provider default. `off` is a real
    // advertised tier: sessions.selectModel carries it through and the
    // adapter translates the tier to a request with reasoning disabled.
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
      const directoryState = useDirectorySnapshot(props)
      // SessionEntry already provides the official projection hook to every
      // seat.  Prefer its durable model-selection value when available so a
      // per-session choice wins over the Host-wide default after a reload.
      const projectedSelection = typeof props.useProjection === 'function'
        ? props.useProjection('modelSelection')
        : undefined
      const state = projectedSelection !== undefined && projectedSelection !== null
        ? {
          ...directoryState,
          current: projectedSelection.next ?? directoryState.current,
        }
        : directoryState
      const [open, setOpen] = useState(false)
      const [modelOpen, setModelOpen] = useState(false)
      const [tierOpen, setTierOpen] = useState(false)
      const [modelQuery, setModelQuery] = useState('')
      const [expandedModelGroup, setExpandedModelGroup] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const ladder = ladderOf(state)
      const current = state.current
      const currentIndex = ladder === null ? 0 : ladder.index
      const [draftIndex, setDraftIndex] = useState(currentIndex)
      const [draftActive, setDraftActive] = useState(false)
      const dragging = useRef(false)
      const pendingSelection = useRef(null)
      const committing = useRef(false)
      const lifecycle = useRef(0)
      const rootRef = useRef(null)
      const retries = useRef(0)
      const reported = useRef(false)
      const initialLoad = useRef(true)
      const tookSeat = useRef(false)
      if (state.groups.length > 0) tookSeat.current = true

      useEffect(() => () => {
        lifecycle.current += 1
        pendingSelection.current = null
        dragging.current = false
      }, [])

      // Hooks remain unconditional so the loading -> ready handoff is a valid
      // React update even when this entry wins the slot from the first render.
      useEffect(() => {
        const initial = initialLoad.current
        initialLoad.current = false
        if (typeof load === 'function') load()
        return () => { void initial }
      }, [load])
      useEffect(() => {
        if (typeof load !== 'function') return undefined
        if (state.groups.length > 0 || state.status === 'selecting') return undefined
        if (retries.current >= MAX_LOAD_RETRIES) {
          if (!reported.current) {
            reported.current = true
            console.warn('[effort-ultra] model catalog still unavailable after ' + String(MAX_LOAD_RETRIES) + ' attempts. snapshot=' + JSON.stringify({ status: state.status, error: state.error ?? null, groups: state.groups.length }))
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
      const readOnly = !available
      // Disabling a native range during a pointer gesture cancels that gesture.
      // Saving can lock model/reset buttons, but must never lock the slider.
      const sliderDisabled = locked || readOnly || typeof select !== 'function'
      const disabled = sliderDisabled || busy || state.status === 'selecting'
      const commit = useCallback((selection) => {
        pendingSelection.current = selection
        setBusy(true)
        setFailed(false)
        if (committing.current) return
        committing.current = true
        const token = lifecycle.current
        // At most one write runs at a time. Keep the newest drag value while
        // it is in flight so slow replies cannot overwrite a later choice.
        const flush = async () => {
          let rejected = false
          while (pendingSelection.current !== null && token === lifecycle.current) {
            const next = pendingSelection.current
            pendingSelection.current = null
            try {
              rejected = await select(next) === false
            } catch (error) {
              rejected = true
              console.warn('[effort-ultra] selection rejected:', error)
            }
            if (token !== lifecycle.current) return
          }
          if (token !== lifecycle.current) return
          committing.current = false
          setBusy(false)
          setFailed(rejected)
          if (!dragging.current) setDraftActive(false)
        }
        void flush()
      }, [select])
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      useEffect(() => {
        if (!open) setModelOpen(false)
      }, [open])
      useEffect(() => {
        if (!open) setTierOpen(false)
      }, [open])
      useEffect(() => {
        if (!modelOpen) return
        setTierOpen(false)
        setExpandedModelGroup(current?.provider ?? state.groups[0]?.id ?? null)
      }, [modelOpen, current?.provider, state.groups])

      const populated = state.groups.length > 0
      if (!tookSeat.current && !readOnly) return null

      const catalogueError = typeof state.error === 'string' && state.error.length > 0 ? state.error : null
      const model = ladder === null ? undefined : ladder.model
      const displayModelName = (value) => {
        if (value === undefined) return ''
        const name = String(value.name ?? '').trim()
        return name.length > 0 ? name : String(value.id ?? '')
      }
      const modelLabel = model !== undefined
        ? displayModelName(model)
        : current === null
          ? t(state.status === 'error' ? 'loadFailed' : 'loading')
          : `${current.provider}/${current.model}`
      const displayedIndex = draftActive ? draftIndex : currentIndex
      const onDefault = ladder !== null && ladder.onDefault && !draftActive
      const tierName = ladder === null
        ? undefined
        : draftActive
          ? ladder.efforts[displayedIndex]?.name
        : onDefault
          ? t('providerDefault')
          : (ladder.efforts.find((level) => level.id === ladder.effective) ?? {}).name
            ?? (ladder.effective ?? t('providerDefault'))
      const topSelected = ladder !== null && !onDefault && displayedIndex === ladder.efforts.length - 1
      const modelChoices = state.groups.flatMap((group) => (Array.isArray(group.models) ? group.models.map((entry) => ({
        provider: group.id,
        providerName: group.name,
        model: entry,
      })) : []))
      const providerCount = new Set(modelChoices.map((choice) => choice.provider)).size
      const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase()
      const visibleModelGroups = state.groups.map((group) => ({
        group,
        models: (Array.isArray(group.models) ? group.models : []).filter((entry) => {
          if (normalizedModelQuery.length === 0) return true
          return `${entry.name ?? ''} ${entry.id ?? ''}`.toLocaleLowerCase().includes(normalizedModelQuery)
        }),
      })).filter(({ models }) => models.length > 0)
      const modelPicker = modelChoices.length > 1
        ? h('div', { className: 'deu-modelPicker' },
          h('button', {
            className: 'deu-modelButton',
            type: 'button',
            disabled: disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': modelOpen,
            onClick: () => setModelOpen((value) => {
              if (value) setModelQuery('')
              return !value
            }),
          }, h('span', { className: 'deu-modelText', title: modelLabel }, modelLabel), h('span', { className: 'deu-modelChevron', 'aria-hidden': true })),
          modelOpen
            ? h('div', { className: 'deu-modelMenu', role: 'listbox', 'aria-label': t('model') },
              h('input', {
                className: 'deu-modelSearch',
                type: 'search',
                value: modelQuery,
                placeholder: t('searchModels'),
                'aria-label': t('searchModels'),
                onChange: (event) => setModelQuery(event.currentTarget?.value ?? ''),
              }),
              visibleModelGroups.length === 0
                ? h('div', { className: 'deu-modelNoResults' }, t('noModelResults'))
                : visibleModelGroups.map(({ group, models }) => {
                  const expanded = normalizedModelQuery.length > 0 || group.id === expandedModelGroup
                  return h('div', { className: 'deu-modelGroup', key: group.id },
                    h('button', {
                      className: 'deu-modelGroupToggle',
                      type: 'button',
                      'aria-expanded': expanded,
                      onClick: () => setExpandedModelGroup((value) => value === group.id ? null : group.id),
                    }, h('span', { className: 'deu-modelGroupLabel' }, group.name), h('span', {
                      className: expanded ? 'deu-modelGroupChevron deu-modelGroupChevronOpen' : 'deu-modelGroupChevron',
                      'aria-hidden': true,
                    })),
                    expanded ? models.map((entry) => {
                      const choice = modelChoices.find((item) => item.provider === group.id && item.model.id === entry.id)
                      if (choice === undefined) return null
                      const selected = current !== null
                        && current.provider === choice.provider
                        && current.model === choice.model.id
                      return h('button', {
                        key: choice.provider + ':' + choice.model.id,
                        className: 'deu-modelOption' + (selected ? ' deu-modelOptionSelected' : ''),
                        type: 'button',
                        role: 'option',
                        'aria-selected': selected,
                        disabled,
                        onClick: () => {
                          setModelOpen(false)
                          setModelQuery('')
                          const reasoningEffort = choice.provider === current?.provider && choice.model.id === current?.model
                            ? current?.reasoningEffort ?? choice.model.reasoning?.defaultEffort
                            : choice.model.reasoning?.defaultEffort
                          commit(selectionFor(choice.provider, choice.model.id, reasoningEffort))
                        },
                      }, choice.providerName && (providerCount > 1 || modelChoices.filter((item) => item.provider === choice.provider).length > 1)
                        ? choice.providerName + ' · ' + displayModelName(choice.model)
                        : displayModelName(choice.model))
                    }) : null,
                  )
                }),
            )
            : null,
        )
        : h('div', { className: 'deu-model', title: modelLabel }, modelLabel)

      const setTier = (effortId) => {
        if (disabled || current === null) return
        commit(selectionFor(current.provider, current.model, effortId))
      }
      const defaultSelected = current !== null && current.reasoningEffort === undefined
      const selectTier = (effortId) => {
        setTier(effortId)
        setTierOpen(false)
      }
      const progress = ladder === null
        ? 100
        : onDefault
          ? 0
          : ladder.efforts.length <= 1
            ? 100
        : Math.max(0, Math.min(100, displayedIndex / (ladder.efforts.length - 1) * 100))

      const chip = h('button', {
        className: 'deu-chip',
        type: 'button',
        disabled,
        'aria-expanded': open,
        'aria-label': `${modelLabel}: ${tierName ?? ''}`,
        onClick: () => {
          if (disabled) return
          setOpen(true)
          if (typeof load === 'function') load()
        },
      },
        h('span', { className: 'deu-chipModel' }, modelLabel),
        tierName === undefined ? null : h('span', { className: 'deu-chipTier' }, tierName),
        h('span', { className: 'deu-chevron', 'aria-hidden': true }),
      )

      const bar = ladder === null ? null : h('div', {
        className: 'deu-barWrap',
        style: { '--deu-progress': `${progress}%` },
      },
        h('div', { className: 'deu-trackBase', 'aria-hidden': true },
          h('div', { className: 'deu-trackFill', 'data-deu-unset': onDefault ? 'true' : 'false' }),
        ),
        h('span', { className: onDefault ? 'deu-thumb deu-thumbUnset' : 'deu-thumb', 'aria-hidden': true }),
        h('input', {
          className: 'deu-range',
          type: 'range',
          min: 0,
          max: ladder.efforts.length - 1,
          step: 1,
          value: displayedIndex,
          disabled: sliderDisabled,
          'aria-label': t('barLabel'),
          'aria-valuetext': tierName ?? '',
          onPointerDown: () => { if (!sliderDisabled) dragging.current = true },
          onPointerUp: () => {
            dragging.current = false
            if (!committing.current) setDraftActive(false)
          },
          onPointerCancel: () => {
            dragging.current = false
            if (!committing.current) setDraftActive(false)
          },
          onBlur: () => {
            dragging.current = false
            if (!committing.current) setDraftActive(false)
          },
          onChange: (event) => {
            if (sliderDisabled) return
            const next = Number(event.currentTarget?.value)
            if (!Number.isFinite(next)) return
            const index = Math.max(0, Math.min(ladder.efforts.length - 1, Math.round(next)))
            setDraftIndex(index)
            setDraftActive(true)
            const effort = ladder.efforts[index]
            if (current !== null && effort !== undefined) commit(selectionFor(current.provider, current.model, effort.id))
          },
        }),
      )

      const scale = ladder === null ? null : h('div', {
        className: 'deu-scale',
        'aria-hidden': true,
      }, ...ladder.efforts.map((level, index) => h('span', {
        key: level.id,
        className: index === displayedIndex && !defaultSelected ? 'deu-scaleItem deu-scaleActive' : 'deu-scaleItem',
      }, level.name)))
      const tierMenu = ladder === null || current === null || !tierOpen ? null : h('div', {
        className: 'deu-tierMenu',
        role: 'listbox',
        'aria-label': t('barLabel'),
      },
        h('button', {
          className: defaultSelected ? 'deu-tierOption deu-tierOptionSelected' : 'deu-tierOption',
          type: 'button',
          role: 'option',
          'aria-selected': defaultSelected,
          disabled,
          onClick: () => selectTier(undefined),
        }, t('providerDefault'), defaultSelected ? h('span', { className: 'deu-tierOptionMark', 'aria-hidden': true }, '✓') : null),
        ...ladder.efforts.map((level, index) => {
          const selected = !defaultSelected && index === displayedIndex
          return h('button', {
            key: level.id,
            className: selected ? 'deu-tierOption deu-tierOptionSelected' : 'deu-tierOption',
            type: 'button',
            role: 'option',
            'aria-selected': selected,
            disabled,
            onClick: () => selectTier(level.id),
          }, level.name, selected ? h('span', { className: 'deu-tierOptionMark', 'aria-hidden': true }, '✓') : null)
        }),
      )

      const reset = ladder === null || current === null ? null : h('button', {
        className: 'deu-reset',
        type: 'button',
        disabled,
        'aria-label': t('reset'),
        title: t('reset'),
        onClick: () => setTier(undefined),
      })
      const followDefault = ladder !== null && current !== null && ladder.model?.reasoning?.defaultEffort === undefined
        ? h('button', {
          className: 'deu-default',
          type: 'button',
          disabled,
          'aria-pressed': onDefault,
          onClick: () => setTier(undefined),
        }, t('providerDefault'))
        : null
      const body = ladder !== null
        ? h(React.Fragment, null, bar, scale, h('div', { className: 'deu-hint' }, t('adjustHint')), followDefault, failed ? h('div', { className: 'deu-error' }, t('error')) : null)
        : catalogueError !== null
          ? h('div', { className: 'deu-note deu-error' }, `${t('loadFailed')}: ${catalogueError}`)
          : h('div', { className: 'deu-note' }, t(state.status === 'loading' ? 'loading' : 'noEfforts'))

      const panel = open ? h('div', { className: 'deu-panel', 'data-deu-panel': 'true' },
        h('div', { className: 'deu-head' },
          h('button', {
            className: 'deu-tierButton',
            type: 'button',
            disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': tierOpen,
            'aria-label': tierName ?? t('reasoning'),
            onClick: () => {
              if (disabled) return
              setModelOpen(false)
              setTierOpen((value) => !value)
            },
          }, tierName ?? t('reasoning'), h('span', { className: 'deu-tierChevron', 'aria-hidden': true })),
          reset,
        ),
        tierMenu,
        modelPicker,
        body,
      ) : null

      return h('div', {
        className: 'deu-root',
        ref: rootRef,
        'data-top': topSelected ? 'true' : 'false',
        'data-deu-root': 'true',
        'data-deu-populated': populated ? 'true' : 'false',
      }, panel, open ? null : chip)
    }
    return {
      // `remote.session` MUST be declared here. It is not a convenience: Cordis
      // delivers `internal/service` only to fibers that declare the service
      // (see `notify()`: `if (!(name in fiber.inject)) continue`). Declaring
      // only `slots` and then waiting on that event meant we never heard about
      // `remote.session` arriving — so registration happened only when the
      // service was already present at apply time. That is why this plugin
      // worked on some boots and silently did nothing on others.
      //
      // Declaring it costs nothing: Cordis parks this fiber until the service
      // exists, then runs apply with `ctx.remote.session` available. `sessions`
      // and `slots` are declared alongside it because the seat registration
      // needs the current-session resolver and active slot scope.
      // Cordis exposes `ctx.remote` only when the parent service is also
      // declared. `remote.session` alone parks the fiber but still makes the
      // direct `ctx.remote.session` access throw during apply().
      inject: ['sessions', 'slots', 'remote', 'remote.session'],
      apply(ctx) {
        const remoteSession = ctx.remote.session
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.setAttribute('data-dsh-plugin', 'effort-ultra')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }, 'effort-ultra: stylesheet')

        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(LOCALE_NS, { zh, en }), 'effort-ultra: dicts')
        }
        const bound = locale !== undefined && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NS)
          : undefined

        // The slot service must be injected into a child scope before using
        // `scope.slots`. A root `ctx.slots` handle can schedule an injection
        // against the wrong scope, which leaves this seat unregistered while
        // the legacy thinking-effort entry keeps winning the composer slot.
        // Keep the session face from the root context as the authoritative
        // write path.  On some DSH builds the child scope exposes `slots` but
        // does not mirror the root `sessions` face; capturing `scope.sessions`
        // alone then makes every select look like an unavailable service.
        // `sessions` is already injected by the outer plugin.  Only create a
        // child scope for the slot registry; redeclaring `sessions` here can
        // shadow the active connection face with an inactive child binding.
        ctx.inject(['slots'], (scope) => {
          const scopedSlots = scope.slots
          // Resolve the face lazily.  Cordis can activate this nested scope
          // before the connection's sessions implementation is mirrored onto
          // the child context; a value captured during apply would stay
          // undefined forever even though the service is live by render time.
          const sessionsOf = () => {
            const root = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
            return root ?? ctx.sessions ?? scope.sessions
          }

          // One adapter per session, created on first use and reused after.
          const directories = new Map()
          const adapterFor = (sessionId) => {
            const existing = directories.get(sessionId)
            if (existing !== undefined) return existing
            const sessions = sessionsOf()
            let projected
            try {
              projected = sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('modelSelection')
            } catch (error) {
              console.warn('[effort-ultra] model projection unavailable:',
                String(error && error.message ? error.message : error))
            }
            const created = createSessionDirectory({
              remoteSession,
              sessionsOf,
              sessionId,
              projected,
              t: bound,
            })
            directories.set(sessionId, created)
            return created
          }
          ctx.effect(() => () => {
            for (const directory of directories.values()) directory.dispose?.()
            directories.clear()
          }, 'effort-ultra: session directories')

          scopedSlots.inject(SLOT_NAME, () => scopedSlots.register({
            name: SLOT_NAME,
            priority: SEAT_PRIORITY,
            locale: LOCALE_NS,
            inject: (sessionId) => {
              const directory = adapterFor(sessionId)
              // Read at inject time, not captured from apply: the sessions service
              // is usually absent when this plugin applies.
              const live = sessionsOf()
              const address = live === undefined || typeof live.subagentAddress !== 'function'
                ? undefined
                : live.subagentAddress(sessionId)
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
        })
      },
    }
  },
})
