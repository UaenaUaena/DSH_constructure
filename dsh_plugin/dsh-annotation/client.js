/**
 * Browser half of the in-place annotation bundle.
 *
 * Reads no React state and claims no slot: it watches the transcript DOM the
 * chat already produced, so the plugin adds no component to the message tree
 * and changes nothing a message renders by itself. Three things live here — a
 * selection trigger (floating button, right-click, and Alt+Shift+E), the
 * request that turns one selected word into a note section, and the link
 * applied to that word once the note exists, again after every re-render.
 *
 * Two published DOM facts make the word findable after a reload, and neither is
 * a hashed class name: `[data-chat-flow]` marks a transcript flow column,
 * `[data-chat-node-key]` marks one rendered chat node, and
 * `[data-conversation-session]` carries the Session the transcript belongs to.
 * A record stores that node key plus 60 characters on each side of the word, so
 * the word is located by its own text when a re-render replaced the element.
 */

const LINK_CLASS = 'dsh-annot-link'
const POP_CLASS = 'dsh-annot-pop'
const NS = 'annotation'

/** Transcript anchors published by the chat renderer. */
const FLOW = '[data-chat-flow]'
const CHAT_NODE = '[data-chat-node-key]'
const SESSION_ATTR = 'data-conversation-session'

/** Text kept on each side of the word, long enough to survive as a fingerprint. */
const FENCE = 60

/** How long the boot waits for the transcript anchor before reporting an incompatible build. */
const ANCHOR_PROBE_MS = 15_000

/** Bounds mirrored from the Host route so one request never exceeds them. */
const MAX_WORD = 200
/** Longest optional instruction the reader may attach before explaining. */
const MAX_PROMPT = 800
const MAX_PASSAGE = 3000
const MAX_CONTEXT = 6000

/** First backoff for a word whose text is absent; doubles up to the cap. */
const MISSING_RETRY_MS = 5_000

/** Longest backoff between two attempts at the same annotation. */
const MISSING_RETRY_MAX_MS = 60_000

/** Minimum gap between rebuilds while the transcript streams. */
const REBUILD_GAP_MS = 500

/** Longest wait before retrying a failed annotation-table read. */
const TABLE_RETRY_MAX_MS = 5_000

/** Failed table reads reported to the console before going quiet. */
const TABLE_FAILURE_LOGS = 3

/** Named custom highlight that keeps the annotated range visible while the field types. */
const SELECTION_HIGHLIGHT = 'dsh-annotation-selection'

/** Trigger key; the floating button and the right-click menu do the same thing. */
const SHORTCUT = { code: 'KeyE', altKey: true, shiftKey: true }

const zh = {
  'trigger': '解释「{word}」',
  'busy': '正在生成解释…',
  'failed': '生成失败：{message}',
  'no-workspace': '当前会话没有工作目录，无法写入笔记',
  'bad-response': '响应缺少批注记录',
  'ask-placeholder': '可补充要求，回车解释；留空按默认',
  'ask-hint': '回车解释 · Esc 取消',
}

const en = {
  'trigger': 'Explain “{word}”',
  'busy': 'Explaining…',
  'failed': 'Failed: {message}',
  'no-workspace': 'This session has no workspace to write the note into',
  'bad-response': 'The response carried no annotation record',
  'ask-placeholder': 'Add a request, Enter to explain, empty for the default',
  'ask-hint': 'Enter to explain · Esc to cancel',
}

const STYLE = `
.${LINK_CLASS} {
  color: var(--dsw-alias-brand-primary, #247bbf);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
  border-radius: 3px;
  cursor: pointer;
}
.${LINK_CLASS}:hover { background: var(--dsw-alias-bg-layer-2, rgb(0 0 0 / 6%)); }
.${LINK_CLASS}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }
.${POP_CLASS} {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(520px, calc(100vw - 16px));
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 12%));
  border-radius: 9px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--dsw-alias-label-primary, #1b1b1f);
}
.${POP_CLASS}-act {
  all: unset;
  padding: 3px 7px;
  border-radius: 6px;
  color: var(--dsw-alias-brand-primary, #247bbf);
  font-weight: 600;
  cursor: pointer;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${POP_CLASS}-ask {
  box-sizing: border-box;
  width: 260px;
  max-width: 46vw;
  padding: 3px 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 18%));
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
  outline: none;
}
.${POP_CLASS}-ask:focus { border-color: var(--dsw-alias-brand-primary, #247bbf); }
.${POP_CLASS}-ask::placeholder { color: var(--dsw-alias-label-secondary, #6b6b74); }
::highlight(${SELECTION_HIGHLIGHT}) {
  background-color: var(--dsw-alias-bg-layer-2, rgb(36 123 191 / 18%));
  color: inherit;
}
.${POP_CLASS}-act:hover { background: var(--dsw-alias-bg-layer-2, rgb(0 0 0 / 6%)); }
.${POP_CLASS}-act[disabled] { cursor: progress; color: var(--dsw-alias-label-secondary, #6b6b74); }
.${POP_CLASS}-hint { color: var(--dsw-alias-label-secondary, #6b6b74); font-size: 11px; white-space: nowrap; }
`

window.__ModuleLoader__.load({
  id: '@local/dsh-annotation',
  factory() {
    return {
      inject: ['sessions', 'sidebarRight', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'annotation: dictionaries')
        const t = ctx.locale.bind(NS)

        /** Stored annotations of the transcript on screen. */
        let annotations = []
        /** Session whose table is loaded; undefined before either is known. */
        let tableSession
        /** Words whose text is absent right now: next retry instant and attempt count. */
        const missing = new Map()
        /** True while this plugin mutates the transcript, so it ignores itself. */
        let mutating = false
        /** One explain request at a time. */
        let busy = false
        let lastRebuildAt = 0
        let scheduled = false
        let retry
        let tableTimer
        let tableFailures = 0
        /** Whether the transcript this plugin targets was ever found. */
        let sawAnchor = false
        let popover

        const style = document.createElement('style')
        style.textContent = STYLE
        document.head.appendChild(style)

        const observer = new MutationObserver(() => { schedule() })

        /** The Session the rendered transcript belongs to. */
        function domSession() {
          const holder = document.querySelector(`[${SESSION_ATTR}]`)
          const value = holder?.getAttribute(SESSION_ATTR) ?? ''
          return value === '' ? undefined : value
        }

        /** The Session shown in the window. */
        function windowSession() {
          const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.()
          return typeof mounted === 'string' && mounted !== '' ? mounted : undefined
        }

        /** That Session's workspace root, as the page already knows it. */
        function cwdOf(id) {
          const row = ctx.sessions?.list?.getSnapshot?.()?.byId?.[id]
          return typeof row?.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
        }

        /** The transcript flow column holding the rendered conversation. */
        function flow() {
          const root = document.querySelector(FLOW)
          if (root !== null) sawAnchor = true
          return root
        }

        /** The chat node wrapping one selection boundary. */
        function chatNodeOf(container) {
          const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement
          return element?.closest?.(CHAT_NODE) ?? null
        }

        /** Text nodes of one element in document order, with their character spans. */
        function textSegments(scope) {
          const segments = []
          let offset = 0
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode()
          while (node !== null) {
            const length = node.nodeValue?.length ?? 0
            segments.push({
              node,
              start: offset,
              end: offset + length,
              linked: node.parentElement?.closest(`.${LINK_CLASS}`) != null,
            })
            offset += length
            node = walker.nextNode()
          }
          return segments
        }

        /** Character offset of one text-node boundary inside the chat node. */
        function offsetIn(scope, container, offset) {
          if (container.nodeType !== Node.TEXT_NODE) return undefined
          let total = 0
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode()
          while (node !== null) {
            if (node === container) return total + offset
            total += node.nodeValue?.length ?? 0
            node = walker.nextNode()
          }
          return undefined
        }

        /**
         * Read the current selection as one annotation candidate.
         * @returns the selection facts, or undefined when there is nothing to annotate.
         */
        function readSelection() {
          const selection = window.getSelection()
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
          const range = selection.getRangeAt(0)
          const root = flow()
          if (root === null || !root.contains(range.commonAncestorContainer)) return undefined
          const node = chatNodeOf(range.commonAncestorContainer)
          if (node === null) return undefined
          const text = node.textContent ?? ''
          const start = offsetIn(node, range.startContainer, range.startOffset)
          const end = offsetIn(node, range.endContainer, range.endOffset)
          if (start === undefined || end === undefined || start >= end) return undefined
          // The exact rendered text, not the collapsed selection: the same slice
          // is what a later render will be searched for.
          const word = text.slice(start, end)
          const label = word.replace(/\s+/g, ' ').trim()
          if (label === '' || word.length > MAX_WORD) return undefined
          return {
            node,
            range,
            nodeKey: node.getAttribute('data-chat-node-key') ?? '',
            word,
            label,
            before: text.slice(Math.max(0, start - FENCE), start),
            after: text.slice(end, Math.min(text.length, end + FENCE)),
            passage: text.slice(
              Math.max(0, start - MAX_PASSAGE / 2),
              Math.min(text.length, end + MAX_PASSAGE / 2),
            ).slice(0, MAX_PASSAGE),
            context: contextOf(node, start, end),
          }
        }

        /** Preceding transcript text plus the selected passage, as the model's context. */
        function contextOf(node, start, end) {
          const own = node.textContent ?? ''
          const chunks = [own.slice(Math.max(0, start - MAX_PASSAGE / 2), Math.min(own.length, end + MAX_PASSAGE / 2))]
          let total = chunks[0].length
          let previous = node.previousElementSibling
          while (previous !== null && total < MAX_CONTEXT) {
            const text = (previous.textContent ?? '').trim()
            if (text !== '') {
              const kept = Math.min(text.length, MAX_CONTEXT - total)
              chunks.unshift(text.slice(-kept))
              total += kept
            }
            previous = previous.previousElementSibling
          }
          return chunks.join('\n\n').slice(-MAX_CONTEXT)
        }

        /** Replace every applied link with its own text. */
        function unwrapAll(root) {
          for (const span of Array.from(root.querySelectorAll(`.${LINK_CLASS}`))) {
            const parent = span.parentNode
            if (parent === null) continue
            while (span.firstChild !== null) parent.insertBefore(span.firstChild, span)
            parent.removeChild(span)
          }
        }

        /** Wrap one character range of a chat node in link spans; never nests links. */
        function wrap(scope, start, end, annotation) {
          const pieces = []
          for (const segment of textSegments(scope)) {
            const from = Math.max(start, segment.start)
            const to = Math.min(end, segment.end)
            if (from >= to) continue
            if (segment.linked) return false
            pieces.push({ node: segment.node, from: from - segment.start, to: to - segment.start })
          }
          if (pieces.length === 0) return false
          for (const piece of pieces) {
            const range = document.createRange()
            range.setStart(piece.node, piece.from)
            range.setEnd(piece.node, piece.to)
            const span = document.createElement('span')
            span.className = LINK_CLASS
            span.setAttribute('role', 'link')
            span.setAttribute('tabindex', '0')
            span.title = `${annotation.heading ?? annotation.word} → ${annotation.path}`
            span.dataset.annotationId = annotation.id
            span.appendChild(range.extractContents())
            range.insertNode(span)
          }
          return true
        }

        /** Apply one annotation to the transcript; false when its text is absent. */
        function applyOne(root, annotation) {
          const scopes = Array.from(root.querySelectorAll(CHAT_NODE))
          const preferred = scopes.filter(scope => scope.getAttribute('data-chat-node-key') === annotation.nodeKey)
          const ordered = preferred.length === 0
            ? scopes
            : preferred.concat(scopes.filter(scope => !preferred.includes(scope)))
          const fence = `${annotation.before}${annotation.word}${annotation.after}`
          const probes = fence === annotation.word ? [annotation.word] : [fence, annotation.word]
          for (const scope of ordered) {
            const text = scope.textContent ?? ''
            for (const probe of probes) {
              const index = text.indexOf(probe)
              if (index < 0) continue
              const start = probe === fence ? index + annotation.before.length : index
              if (text.slice(start, start + annotation.word.length) !== annotation.word) continue
              if (wrap(scope, start, start + annotation.word.length, annotation)) return true
            }
          }
          return false
        }

        /** Rebuild every link from the stored table. */
        function rebuild() {
          const root = flow()
          if (root === null) return
          lastRebuildAt = Date.now()
          mutating = true
          try {
            unwrapAll(root)
            for (const annotation of annotations) {
              const state = missing.get(annotation.id)
              if (state !== undefined && state.at > Date.now()) continue
              if (applyOne(root, annotation)) {
                missing.delete(annotation.id)
                continue
              }
              const tries = (state?.tries ?? 0) + 1
              const wait = Math.min(MISSING_RETRY_MAX_MS, MISSING_RETRY_MS * 2 ** Math.min(tries - 1, 4))
              missing.set(annotation.id, { at: Date.now() + wait, tries })
            }
          } finally {
            mutating = false
            observer.takeRecords()
          }
        }

        /** Rebuild only when the transcript no longer carries every link. */
        function reconcile() {
          ensureSession()
          const root = flow()
          if (root === null) return
          if (annotations.length === 0) {
            if (root.querySelector(`.${LINK_CLASS}`) !== null) rebuild()
            return
          }
          const live = new Set(annotations.map(annotation => annotation.id))
          const seen = new Set()
          for (const span of Array.from(root.querySelectorAll(`.${LINK_CLASS}`))) {
            const id = span.getAttribute('data-annotation-id')
            if (id === null || !live.has(id) || seen.has(id)) return rebuild()
            seen.add(id)
          }
          if (seen.size === live.size - missing.size) {
            if (missing.size === 0) return
            const soonest = Math.min(...Array.from(missing.values(), state => state.at))
            if (soonest > Date.now()) return scheduleRetry(soonest - Date.now())
          }
          if (Date.now() - lastRebuildAt < REBUILD_GAP_MS) {
            // The render that dropped a link also silenced the observer; keep one
            // trailing attempt so a settled transcript is not left unlinked.
            return scheduleRetry(REBUILD_GAP_MS)
          }
          rebuild()
        }

        /** Run one reconcile after a delay; the first pending request wins. */
        function scheduleRetry(delay) {
          if (retry !== undefined) return
          retry = setTimeout(() => {
            retry = undefined
            reconcile()
          }, Math.max(50, Math.min(delay, MISSING_RETRY_MAX_MS)))
        }

        /** Coalesce DOM churn into one reconcile per frame. */
        function schedule() {
          if (mutating || scheduled) return
          scheduled = true
          requestAnimationFrame(() => {
            scheduled = false
            reconcile()
          })
        }

        /** Open the note section an annotation points at, in the right Sidebar. */
        function openNote(annotation) {
          const id = tableSession ?? domSession() ?? windowSession()
          if (id === undefined) return
          try {
            ctx.sidebarRight.openResource(fileAddress(id, annotation.path), { params: { line: annotation.line } })
          } catch (error) {
            console.warn('annotation: could not open the note', error)
          }
        }

        /** One applied link's activation. */
        function onLinkActivate(event) {
          const target = event.target instanceof Element ? event.target : null
          const span = target?.closest(`.${LINK_CLASS}`) ?? null
          if (span === null) return
          const annotation = annotations.find(candidate => candidate.id === span.getAttribute('data-annotation-id'))
          if (annotation === undefined) return
          event.preventDefault()
          event.stopPropagation()
          openNote(annotation)
        }

        /** Keyboard activation for a focused link. */
        function onLinkKey(event) {
          if (event.key !== 'Enter' && event.key !== ' ') return
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.classList.contains(LINK_CLASS)) return
          onLinkActivate(event)
        }

        /**
         * Keep the annotated range visible while the instruction field owns the caret.
         * Focusing an input is what makes typing immediate, and it is also what drops
         * the native selection highlight — the button label and this paint carry it.
         */
        function paintSelection(range) {
          const registry = globalThis.CSS?.highlights
          if (registry === undefined || typeof globalThis.Highlight !== 'function') return
          try {
            registry.set(SELECTION_HIGHLIGHT, new globalThis.Highlight(range))
          } catch {
            // An engine that rejects the range simply shows no extra highlight.
          }
        }

        /** Drop the painted range. */
        function clearSelectionPaint() {
          globalThis.CSS?.highlights?.delete(SELECTION_HIGHLIGHT)
        }

        /** The floating trigger, created once and reused. */
        function popoverElement() {
          if (popover !== undefined) return popover
          const element = document.createElement('div')
          element.className = POP_CLASS
          element.setAttribute('role', 'dialog')
          const ask = document.createElement('input')
          ask.type = 'text'
          ask.className = `${POP_CLASS}-ask`
          ask.maxLength = MAX_PROMPT
          ask.hidden = true
          const action = document.createElement('button')
          action.type = 'button'
          action.className = `${POP_CLASS}-act`
          const hint = document.createElement('span')
          hint.className = `${POP_CLASS}-hint`
          element.append(ask, action, hint)
          // Keep the transcript selection for the button, but let the field take focus.
          element.addEventListener('mousedown', event => {
            if (event.target === ask) return
            event.preventDefault()
          })
          ask.addEventListener('keydown', event => {
            event.stopPropagation()
            const copy = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'c'
            if (copy && ask.value === '' && popover !== undefined && popover.copyText !== undefined) {
              // The field took the caret away from the transcript, so Cmd/Ctrl+C
              // on an empty field copies the word the reader actually selected.
              event.preventDefault()
              void navigator.clipboard?.writeText(popover.copyText)
              hidePopover()
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              popover?.submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              hidePopover()
            }
          })
          document.body.appendChild(element)
          popover = { element, ask, action, hint, submit: () => {} }
          return popover
        }

        /** Place the trigger against a screen rectangle and show it. */
        function placePopover(rect) {
          const { element } = popoverElement()
          element.style.visibility = 'hidden'
          element.style.left = '0px'
          element.style.top = '0px'
          const box = element.getBoundingClientRect()
          const above = rect.top - box.height - 8
          const left = Math.min(
            Math.max(8, rect.left + rect.width / 2 - box.width / 2),
            Math.max(8, window.innerWidth - box.width - 8),
          )
          element.style.left = `${Math.round(left)}px`
          element.style.top = `${Math.round(above >= 8 ? above : rect.bottom + 8)}px`
          element.style.visibility = 'visible'
        }

        /**
         * Show the trigger for one selection and focus its field, so a selection is
         * immediately typeable. Writing something is optional: submitting empty is
         * exactly the default explanation.
         * @param candidate - the captured selection facts, taken before focus moves.
         * @param rect - where the trigger should appear.
         */
        function showTrigger(candidate, rect) {
          const trigger = popoverElement()
          const { action, hint, ask: field } = trigger
          trigger.submit = () => {
            void explain(candidate, rect, field.value.trim())
          }
          trigger.copyText = candidate.word
          field.hidden = false
          field.value = ''
          field.placeholder = t('ask-placeholder')
          hint.textContent = t('ask-hint')
          action.disabled = false
          action.textContent = t('trigger', { word: candidate.label })
          action.onclick = trigger.submit
          placePopover(rect)
          paintSelection(candidate.range)
          field.focus()
        }

        /** Show a failure in place of the trigger label, keeping it open for a retry. */
        function showFailure(candidate, rect, prompt, message) {
          const trigger = popoverElement()
          const { action, hint, ask: field } = trigger
          // A retry may carry an edited instruction, not just the one that failed.
          trigger.submit = () => { void explain(candidate, rect, field.hidden ? prompt : field.value.trim()) }
          hint.textContent = ''
          action.disabled = false
          action.textContent = t('failed', { message: String(message).slice(0, 160) })
          action.onclick = trigger.submit
          if (field.hidden !== true) field.value = prompt
          placePopover(rect)
        }

        /** Hide the trigger, releasing focus so keystrokes return to the page. */
        function hidePopover() {
          if (popover === undefined) return
          if (document.activeElement === popover.ask) popover.ask.blur()
          clearSelectionPaint()
          popover.element.style.visibility = 'hidden'
        }

        /** Whether the event target is inside the trigger. */
        function insidePopover(event) {
          return popover !== undefined && event.target instanceof Node && popover.element.contains(event.target)
        }

        /**
         * Explain one selection: ask the Host, apply the link, open the note.
         * @param candidate - the captured selection facts.
         * @param rect - where a failure notice belongs.
         * @param prompt - the reader's optional instruction; empty means the default explanation.
         */
        async function explain(candidate, rect, prompt) {
          if (busy) return
          const id = tableSession ?? domSession() ?? windowSession()
          const cwd = id === undefined ? undefined : cwdOf(id)
          if (id === undefined || cwd === undefined) {
            showFailure(candidate, rect, prompt, t('no-workspace'))
            return
          }
          busy = true
          const { action, hint } = popoverElement()
          action.disabled = true
          action.textContent = t('busy')
          hint.textContent = ''
          try {
            const response = await fetch('annotation/explain', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                sessionId: id,
                cwd,
                nodeKey: candidate.nodeKey,
                word: candidate.word,
                before: candidate.before,
                after: candidate.after,
                passage: candidate.passage,
                context: candidate.context,
                prompt,
              }),
            })
            const payload = await response.json().catch(() => undefined)
            if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`)
            const annotation = payload?.annotation
            if (typeof annotation?.id !== 'string') throw new Error(t('bad-response'))
            annotations.push(annotation)
            missing.delete(annotation.id)
            hidePopover()
            rebuild()
            openNote(annotation)
          } catch (error) {
            showFailure(candidate, rect, prompt, error instanceof Error ? error.message : String(error))
          } finally {
            busy = false
          }
        }

        /**
         * Read the session's annotation table, retrying until it lands.
         *
         * The page can be open before this Host row has registered its routes —
         * a reload during startup gets the SPA fallback instead of JSON — so one
         * attempt is not evidence that the session has no annotations.
         * @param id - the Session whose table is wanted.
         * @param attempt - zero for the first try; the backoff step after that.
         */
        async function readTable(id, attempt) {
          if (tableSession !== id) return
          try {
            const response = await fetch(`annotation/list?sessionId=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (!Array.isArray(payload?.annotations)) throw new Error('response carried no annotation list')
            if (tableSession !== id) return
            annotations = payload.annotations.slice()
            missing.clear()
            if (tableFailures > 0) console.info('annotation: table loaded after retrying')
            tableFailures = 0
            rebuild()
          } catch (error) {
            if (tableSession !== id) return
            tableFailures += 1
            if (tableFailures <= TABLE_FAILURE_LOGS) console.warn('annotation: annotation table not ready yet', error)
            scheduleTable(id, attempt + 1)
          }
        }

        /** Queue one table read, backing off to the cap and never giving up. */
        function scheduleTable(id, attempt) {
          if (tableTimer !== undefined) return
          const wait = attempt === 0 ? 0 : Math.min(TABLE_RETRY_MAX_MS, 250 * 2 ** Math.min(attempt - 1, 5))
          tableTimer = setTimeout(() => {
            tableTimer = undefined
            void readTable(id, attempt)
          }, wait)
        }

        /** Follow the transcript to the Session it now renders. */
        function ensureSession() {
          const id = domSession() ?? windowSession()
          if (id === tableSession) return
          if (tableTimer !== undefined) clearTimeout(tableTimer)
          tableTimer = undefined
          tableFailures = 0
          tableSession = id
          annotations = []
          missing.clear()
          if (id === undefined) rebuild()
          else scheduleTable(id, 0)
        }

        function onMouseUp(event) {
          // A right click already opened the trigger through `contextmenu`; the
          // trailing release must not replace it (macOS fires them in this order).
          if (event.button !== 0) return
          if (insidePopover(event)) return
          window.setTimeout(() => {
            const candidate = readSelection()
            if (candidate === undefined) {
              hidePopover()
              return
            }
            const selection = window.getSelection()
            const range = selection === null || selection.rangeCount === 0 ? undefined : selection.getRangeAt(0)
            if (range === undefined) return
            showTrigger(candidate, range.getBoundingClientRect())
          }, 0)
        }

        function onContextMenu(event) {
          if (insidePopover(event)) return
          const candidate = readSelection()
          if (candidate === undefined) return
          event.preventDefault()
          showTrigger(candidate, new DOMRect(event.clientX, event.clientY, 0, 0))
        }

        /** Whether a keystroke belongs to some other editable surface. */
        function isEditable(target) {
          return target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null
        }

        function onKeyDown(event) {
          if (event.key === 'Enter' && popover !== undefined && popover.element.style.visibility !== 'hidden') {
            // The field owns its own Enter; anywhere else, Enter submits the open trigger.
            if (popover.element.contains(event.target)) return
            if (isEditable(event.target)) return
            event.preventDefault()
            popover.submit()
            return
          }
          if (event.code !== SHORTCUT.code || event.altKey !== SHORTCUT.altKey || event.shiftKey !== SHORTCUT.shiftKey) return
          const candidate = readSelection()
          if (candidate === undefined) return
          event.preventDefault()
          const selection = window.getSelection()
          const range = selection === null || selection.rangeCount === 0 ? undefined : selection.getRangeAt(0)
          showTrigger(candidate, range === undefined ? new DOMRect(24, 96, 0, 0) : range.getBoundingClientRect())
        }

        function onPointerDown(event) {
          if (insidePopover(event)) return
          hidePopover()
        }

        function onEscape(event) {
          if (event.key !== 'Escape' || popover === undefined) return
          if (popover.element.style.visibility === 'hidden') return
          hidePopover()
        }

        function onScroll() {
          // Typing must survive a scroll; the anchor may move, the draft may not vanish.
          if (popover !== undefined && popover.element.contains(document.activeElement)) return
          hidePopover()
        }

        const listeners = [
          [document, 'mouseup', onMouseUp],
          [document, 'contextmenu', onContextMenu],
          [document, 'keydown', onKeyDown],
          [document, 'keydown', onLinkKey],
          [document, 'keydown', onEscape],
          [document, 'mousedown', onPointerDown],
          [document, 'scroll', onScroll],
          [document, 'click', onLinkActivate],
          [window, 'resize', onScroll],
        ]
        const capture = new Set(['mouseup', 'contextmenu', 'keydown', 'mousedown', 'scroll', 'click'])
        for (const [target, type, handler] of listeners) target.addEventListener(type, handler, capture.has(type))

        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        ensureSession()
        // A DSH whose transcript markup moved would leave this plugin silently
        // inert; say so once instead of looking broken.
        const anchorProbe = setTimeout(() => {
          if (sawAnchor) return
          console.warn(
            'annotation: transcript anchor "' + FLOW + '" never appeared — '
            + 'this DSH build may have changed the conversation DOM (see README compatibility).',
          )
        }, ANCHOR_PROBE_MS)

        ctx.effect(() => () => {
          observer.disconnect()
          if (retry !== undefined) clearTimeout(retry)
          retry = undefined
          if (tableTimer !== undefined) clearTimeout(tableTimer)
          tableTimer = undefined
          clearTimeout(anchorProbe)
          clearSelectionPaint()
          for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, capture.has(type))
          popover?.element.remove()
          popover = undefined
          const root = flow()
          if (root !== null) unwrapAll(root)
          style.remove()
        }, 'annotation: transcript wiring')
      },
    }
  },
})

/**
 * Encode one address segment the way the resource address builder does.
 * @param value - raw segment.
 * @returns the encoded segment, with `:` left readable.
 */
function encodeSegment(value) {
  return encodeURIComponent(value).replace(/%3A/gi, ':')
}

/**
 * Address one session-scoped file for the Sidebar's resource navigation.
 * @param sessionId - the Session whose workspace resolves the path.
 * @param path - workspace-relative path with `/` separators.
 * @returns the `dsh-resource://file/session/<id>/<path>` address.
 */
function fileAddress(sessionId, path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}`
}
