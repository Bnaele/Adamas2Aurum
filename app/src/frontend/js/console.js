// console.js - UNIFIED CONSOLE MANAGEMENT
import {
	EVENTS_API,
	showToast,
	toDatetimeLocal,
	toUtcIso,
	buildCardBody,
	esc,
	formatDT,
} from './utils.js'
import { API_BASE } from './constants.js'
import { updateAuthNav, isAdmin, isModerator, logout } from './auth-helpers.js'
import { consoleVisibleEvents } from './event-status.js'
import { correctAnswerPlaceholder } from './question-form.js'

const AUTH_API = `${API_BASE}/api/auth`
const CARDS_API = `${API_BASE}/api/cards`

// ── DOM REFS ──
// Auth
const elAccessDenied = document.getElementById('access-denied')
const elConsole = document.getElementById('console-content')
const elUserBadge = document.getElementById('user-badge')
const btnLogout = document.getElementById('btn-logout')
const btnLogoutDenied = document.getElementById('btn-logout-denied')

// Events
const elLoading = document.getElementById('loading')
const elEmpty = document.getElementById('empty')
const elListError = document.getElementById('list-error')
const elEventList = document.getElementById('event-list')
const elEventCount = document.getElementById('event-count')
const viewList = document.getElementById('view-list')
const viewForm = document.getElementById('view-form')
const formHeading = document.getElementById('form-heading')
const eventForm = document.getElementById('event-form')
const editIdInput = document.getElementById('edit-id')
const btnNew = document.getElementById('btn-new')
const btnCancel = document.getElementById('btn-cancel')
const btnSubmit = document.getElementById('btn-submit')

// Cards
const elCardList = document.getElementById('card-list')
const elCardCount = document.getElementById('card-count')
const elCardLoading = document.getElementById('card-loading')
const elCardEmpty = document.getElementById('card-empty')
const elCardListError = document.getElementById('card-list-error')
const cardViewList = document.getElementById('card-view-list')
const cardViewForm = document.getElementById('card-view-form')
const cardFormHeading = document.getElementById('card-form-heading')
const cardForm = document.getElementById('card-form')
const cardEditId = document.getElementById('card-edit-id')
const btnCardNew = document.getElementById('btn-card-new')
const btnCardCancel = document.getElementById('btn-card-cancel')
const btnCardSubmit = document.getElementById('btn-card-submit')

// Modal
const modalOverlay = document.getElementById('modal-overlay')
const modalBody = document.getElementById('modal-body')
const modalTitle = document.querySelector('.modal-title')
const modalCancel = document.getElementById('modal-cancel')
const modalConfirm = document.getElementById('modal-confirm')

// Tabs
const tabButtons = document.querySelectorAll('.tab-btn')
const tabEvents = document.getElementById('tab-events')
const tabCards = document.getElementById('tab-cards')
const tabCampaigns = document.getElementById('tab-campaigns')
const tabInsights = document.getElementById('tab-insights')
const tabModeration = document.getElementById('tab-moderation')
const tabFeedback = document.getElementById('tab-feedback')

// Sub-tabs (event edit view)
const editLayout = document.getElementById('event-edit-layout')
const subTabBtns = document.querySelectorAll('.sub-tab-btn')
const subtabDetails = document.getElementById('subtab-details')
const subtabQuestions = document.getElementById('subtab-questions')
const subtabPool = document.getElementById('subtab-pool')

// Card pool
const poolList = document.getElementById('pool-list')
const poolCount = document.getElementById('pool-count')
const poolLoading = document.getElementById('pool-loading')
const poolEmpty = document.getElementById('pool-empty')
const poolForm = document.getElementById('pool-form')
const poolSelect = document.getElementById('pool-card-select')
const poolWeight = document.getElementById('pool-weight')
const poolCopyLimit = document.getElementById('pool-copy-limit')
const poolSubmit = document.getElementById('pool-submit')
const poolModalOverlay = document.getElementById('pool-modal-overlay')
const poolModalBody = document.getElementById('pool-modal-body')
const poolModalCancel = document.getElementById('pool-modal-cancel')
const poolModalConfirm = document.getElementById('pool-modal-confirm')

// Toolbars
const eventToolbar = document.getElementById('event-toolbar')
const eventFilterChips = document.getElementById('event-filter-chips')
const eventSortSelect = document.getElementById('event-sort')
const togglePastPopups = document.getElementById('toggle-past-popups')
const elPastPopupsCount = document.getElementById('past-popups-count')
const cardToolbar = document.getElementById('card-toolbar')
const cardFilterChips = document.getElementById('card-filter-chips')
const cardSortSelect = document.getElementById('card-sort')

// Moderation
const modList = document.getElementById('mod-list')
const modCount = document.getElementById('mod-count')
const modLoading = document.getElementById('mod-loading')
const modEmpty = document.getElementById('mod-empty')
const modError = document.getElementById('mod-error')
const modActionsList = document.getElementById('mod-actions-list')
const modActionsLoading = document.getElementById('mod-actions-loading')
const modActionsEmpty = document.getElementById('mod-actions-empty')
const btnModRefresh = document.getElementById('btn-mod-refresh')
const modModalOverlay = document.getElementById('mod-modal-overlay')
const modModalTitle = document.getElementById('mod-modal-title')
const modModalBody = document.getElementById('mod-modal-body')
const modReason = document.getElementById('mod-reason')
const modDuration = document.getElementById('mod-duration')
const modDurationField = document.getElementById('mod-duration-field')
const modRecommended = document.getElementById('mod-recommended')
const modModalCancel = document.getElementById('mod-modal-cancel')
const modModalConfirm = document.getElementById('mod-modal-confirm')

const f = (id) => document.getElementById(id)
const cf = (id) => document.getElementById(id)

// ── STATE ──
let pendingDeleteId = null
let pendingCardDeleteId = null
let pendingPoolDeleteId = null
let allCards = []
let allEvents = []
let allCampaigns = []
let eventFilters = new Set([
	'draft',
	'in_review',
	'published',
	'active',
	'scheduled',
	'retired',
	'archived',
	'inactive',
	'expired',
])
let cardFilters = new Set(['LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON'])

// ── HELPERS ──
function hideAllConsoleUI() {
	elConsole.classList.add('hidden')
	elAccessDenied.classList.add('hidden')
	elUserBadge.classList.add('hidden')
	btnLogout.classList.add('hidden')
	btnLogoutDenied.classList.add('hidden')

	document.querySelectorAll('.tab-btn').forEach((t) =>
		t.classList.remove('tab-active')
	)
	tabEvents.classList.add('hidden')
	tabCards.classList.add('hidden')
	tabCampaigns?.classList.add('hidden')
	tabInsights?.classList.add('hidden')
	tabModeration?.classList.add('hidden')
	tabFeedback?.classList.add('hidden')

	if (editLayout) editLayout.classList.add('hidden')

	resetEventForm()
	resetCardForm()
	showEventList()
	showCardList()
}

function showEventList() {
	viewList.classList.remove('hidden')
	viewForm.classList.add('hidden')
}

function showEventForm() {
	viewList.classList.add('hidden')
	viewForm.classList.remove('hidden')
}

function showCardList() {
	cardViewList.classList.remove('hidden')
	cardViewForm.classList.add('hidden')
}

function showCardForm() {
	cardViewList.classList.add('hidden')
	cardViewForm.classList.remove('hidden')
}

function resetEventForm() {
	eventForm.reset()
	editIdInput.value = ''
	f('f-active').checked = true
	btnSubmit.disabled = false
	btnSubmit.textContent = 'Save Event'
}

function resetCardForm() {
	cardForm.reset()
	cardEditId.value = ''
	btnCardSubmit.disabled = false
	btnCardSubmit.textContent = 'Save Card'
}

// ── AUTH ──
btnLogout?.addEventListener('click', logout)
btnLogoutDenied?.addEventListener('click', logout)

async function checkAccess() {
	try {
		const res = await fetch(`${AUTH_API}/me`, {
			credentials: 'include',
		})
		if (!res.ok) throw new Error('Not authenticated')
		const user = await res.json()

		updateAuthNav(user)

		if (!isAdmin(user) && !isModerator(user)) {
			elAccessDenied.classList.remove('hidden')
			return
		}

		elConsole.classList.remove('hidden')
		updateFeedbackTabCount()

		// Per-tab access mirrors the backend role gates: without this
		// an EVENT_AUTHOR sees a Moderation tab that 403s on every
		// call, and a CARD_AUTHOR-only user lands on event authoring
		// they can never save. Hidden tabs stay hidden; the first
		// allowed tab becomes the landing tab.
		const hasRole = (...roles) =>
			(user?.roles || []).some((r) => roles.includes(r))
		const canAuthorEvents = hasRole('SUPER_ADMIN', 'EVENT_AUTHOR')
		const canAuthorCards = hasRole('SUPER_ADMIN', 'CARD_AUTHOR')
		const tabAllowed = {
			events: canAuthorEvents,
			campaigns: canAuthorEvents,
			placement: canAuthorEvents,
			insights: canAuthorEvents,
			cards: canAuthorCards,
			moderation: isModerator(user),
			feedback: true, // any console role may triage feedback
		}
		document.querySelectorAll('.tab-btn').forEach((btn) => {
			if (tabAllowed[btn.dataset.tab] === false)
				btn.classList.add('hidden')
		})

		// Activate events tab by default (or the first allowed tab when
		// events is hidden for this role). The tab click handler shows
		// the panel and loads its data, so nothing else is needed here.
		let landingTab = document.querySelector('[data-tab="events"]')
		if (!landingTab || landingTab.classList.contains('hidden')) {
			landingTab = document.querySelector(
				'.tab-btn:not(.hidden)'
			)
		}
		if (landingTab) landingTab.click()
	} catch (err) {
		console.warn('Auth check failed:', err)
		window.location.href = '../index.html'
	}
}

// ── TABS ──
tabButtons.forEach((btn) => {
	btn.addEventListener('click', () => {
		tabButtons.forEach((b) => b.classList.remove('tab-active'))
		btn.classList.add('tab-active')
		tabEvents.classList.add('hidden')
		tabCards.classList.add('hidden')
		tabCampaigns?.classList.add('hidden')
		tabInsights?.classList.add('hidden')
		tabModeration?.classList.add('hidden')
		tabFeedback?.classList.add('hidden')
		const tab = btn.dataset.tab
		if (tab === 'cards') {
			tabCards.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden')) loadCards()
		} else if (tab === 'campaigns') {
			tabCampaigns.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden'))
				loadCampaigns()
		} else if (tab === 'placement') {
			// placement-console.js shows #tab-placement itself; only the
			// other tabs are hidden here (falling through to the events
			// branch below used to leave Manage/Edit Event visible too).
		} else if (tab === 'insights') {
			tabInsights.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden')) {
				loadInsightsOverview()
				loadEngagement()
				loadDifficulty()
				loadDropRates()
				loadHardQuestions()
				loadStaleEvents()
			}
		} else if (tab === 'moderation') {
			tabModeration.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden')) {
				loadModerationQueue()
				loadModerationActions()
			}
		} else if (tab === 'feedback') {
			tabFeedback.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden')) {
				setFeedbackView(fbView)
				loadFeedback()
			}
		} else {
			tabEvents.classList.remove('hidden')
			if (!elConsole.classList.contains('hidden'))
				loadEvents()
		}
	})
})

// ── INSIGHTS / MODERATION SECTION NAV ──
// One section visible at a time so admins jump instead of scrolling.
// "All" restores the full stacked view. Null-safe: markup may vary.
function setInsightsView(view) {
	const panels = document.querySelectorAll('[data-insights-panel]')
	if (!panels.length) return
	document.querySelectorAll('#insights-sub-tabs .mini-tab-btn').forEach(
		(b) =>
			b.classList.toggle(
				'mini-tab-active',
				b.dataset.insightsView === view
			)
	)
	panels.forEach((p) => {
		p.classList.toggle(
			'hidden',
			view !== 'all' && p.dataset.insightsPanel !== view
		)
	})
}

function setModerationView(view) {
	const panels = document.querySelectorAll('[data-mod-panel]')
	if (!panels.length) return
	document.querySelectorAll('#mod-sub-tabs .mini-tab-btn').forEach((b) =>
		b.classList.toggle(
			'mini-tab-active',
			b.dataset.modView === view
		)
	)
	panels.forEach((p) => {
		p.classList.toggle(
			'hidden',
			view !== 'all' && p.dataset.modPanel !== view
		)
	})
}

function filterModerationQueue(query) {
	if (!modList) return
	const q = (query || '').trim().toLowerCase()
	let visible = 0
	;[...modList.children].forEach((li) => {
		const hit =
			!q || (li.textContent || '').toLowerCase().includes(q)
		li.classList.toggle('hidden', !hit)
		if (hit) visible += 1
	})
	if (modCount && q) {
		modCount.textContent = `${visible} of ${modQueue.length} flagged players match “${query.trim()}”`
	} else if (modCount && modQueue.length) {
		modCount.textContent = `${modQueue.length} flagged player${modQueue.length !== 1 ? 's' : ''} — sorted by lowest trust first`
	}
}

document.querySelectorAll('#insights-sub-tabs .mini-tab-btn').forEach((btn) => {
	btn.addEventListener('click', () =>
		setInsightsView(btn.dataset.insightsView)
	)
})
document.querySelectorAll('#mod-sub-tabs .mini-tab-btn').forEach((btn) => {
	btn.addEventListener('click', () =>
		setModerationView(btn.dataset.modView)
	)
})
document.getElementById('mod-search')?.addEventListener('input', (e) => {
	setModerationView('queue')
	filterModerationQueue(e.target.value)
})

// Apply single-section defaults on load so first paint isn't a long scroll.
setInsightsView('overview')
setModerationView('queue')

// ── EVENTS CRUD ──
const EVENT_SECTION_ORDER = [
	'draft',
	'in_review',
	'published',
	'active',
	'scheduled',
	'retired',
	'archived',
	'inactive',
	'expired',
]
const EVENT_SECTION_LABELS = {
	draft: 'Draft',
	in_review: 'In Review',
	published: 'Published',
	active: 'Active',
	scheduled: 'Scheduled',
	retired: 'Retired',
	archived: 'Archived',
	inactive: 'Inactive',
	expired: 'Expired',
}

function classifyEvent(ev) {
	// Curation status takes precedence if present (new workflow)
	if (ev.curation_status) {
		const s = String(ev.curation_status).toLowerCase()
		if (
			[
				'draft',
				'in_review',
				'published',
				'retired',
				'archived',
			].includes(s)
		)
			return s
	}
	const now = new Date()
	if (!ev.is_active) return 'inactive'
	if (ev.starts_at && new Date(ev.starts_at) > now) return 'scheduled'
	if (ev.ends_at && new Date(ev.ends_at) < now) return 'expired'
	return 'active'
}

async function loadEvents() {
	elLoading.classList.remove('hidden')
	elEmpty.classList.add('hidden')
	elListError.classList.add('hidden')
	elEventList.innerHTML = ''
	elEventCount.textContent = 'Loading…'
	eventToolbar.classList.add('hidden')

	try {
		const res = await fetch(`${EVENTS_API}?all=true`, {
			credentials: 'include',
		})
		if (!res.ok) {
			if (res.status === 401) {
				await checkAccess()
				return
			}
			throw new Error(`Server responded with ${res.status}`)
		}
		const data = await res.json()
		allEvents = data

		elLoading.classList.add('hidden')

		if (!data.length) {
			elEmpty.classList.remove('hidden')
			elEventCount.textContent = '0 events'
			return
		}

		eventToolbar.classList.remove('hidden')
		renderEvents()
	} catch (err) {
		elLoading.classList.add('hidden')
		elListError.textContent = `Could not load events — ${err.message}`
		elListError.classList.remove('hidden')
	}
}

function renderEvents() {
	elEventList.innerHTML = ''
	elEmpty.classList.add('hidden')

	// Retired/archived procedural pop-ups pile up every rotation; hide
	// them unless the author ticks "Show past pop-ups".
	const { visible: listable, pastCount } = consoleVisibleEvents(
		allEvents,
		{
			showPastPopups: !!togglePastPopups?.checked,
		}
	)
	if (elPastPopupsCount) elPastPopupsCount.textContent = pastCount

	const sortBy = eventSortSelect.value
	const sorted = [...listable].sort((a, b) => {
		switch (sortBy) {
			case 'oldest':
				return (
					new Date(a.created_at) -
					new Date(b.created_at)
				)
			case 'title':
				return a.title.localeCompare(b.title)
			case 'points':
				return (
					(b.point_reward ?? 0) -
					(a.point_reward ?? 0)
				)
			default:
				return (
					new Date(b.created_at) -
					new Date(a.created_at)
				)
		}
	})

	const groups = {}
	EVENT_SECTION_ORDER.forEach((k) => (groups[k] = []))
	sorted.forEach((ev) => {
		const key = classifyEvent(ev)
		if (!groups[key]) groups[key] = []
		groups[key].push(ev)
	})

	let visibleCount = 0
	EVENT_SECTION_ORDER.forEach((key) => {
		const items = groups[key]
		if (items.length === 0) return
		if (!eventFilters.has(key)) return

		visibleCount += items.length

		const details = document.createElement('details')
		details.className = 'list-section'
		details.open = true
		details.dataset.section = key

		const summary = document.createElement('summary')
		summary.innerHTML = `${EVENT_SECTION_LABELS[key]} <span class="section-count">${items.length}</span>`
		details.appendChild(summary)

		const ul = document.createElement('ul')
		ul.className = 'event-list'
		items.forEach((ev) => ul.appendChild(buildEventCard(ev)))
		details.appendChild(ul)

		elEventList.appendChild(details)
	})

	const total = allEvents.length
	if (visibleCount === total) {
		elEventCount.textContent = `${total} event${total !== 1 ? 's' : ''}`
	} else {
		elEventCount.textContent = `Showing ${visibleCount} of ${total} events`
	}
	if (!togglePastPopups?.checked && pastCount > 0) {
		elEventCount.textContent += ` · ${pastCount} past pop-up${pastCount !== 1 ? 's' : ''} hidden`
	}

	if (visibleCount === 0 && total > 0) {
		elEmpty.textContent =
			listable.length === 0
				? 'Only past pop-ups here — tick “Show past pop-ups” to see them.'
				: 'No events match the current filters.'
		elEmpty.classList.remove('hidden')
	}
}

function buildEventCard(ev) {
	const li = document.createElement('li')
	li.className = 'event-card'
	li.dataset.id = ev.event_id
	const status = ev.curation_status || 'DRAFT'
	let workflowBtn = ''
	if (status === 'DRAFT')
		workflowBtn = `<button class="btn btn-ghost btn-sm" data-action="transition" data-to="IN_REVIEW">Submit for review</button>`
	else if (status === 'IN_REVIEW')
		workflowBtn = `<button class="btn btn-primary btn-sm" data-action="transition" data-to="PUBLISHED">Publish</button> <button class="btn btn-ghost btn-sm" data-action="transition" data-to="DRAFT">Back to draft</button>`
	else if (status === 'PUBLISHED')
		workflowBtn = `<button class="btn btn-ghost btn-sm" data-action="transition" data-to="RETIRED" style="color:var(--danger)">Retire</button>`
	else if (status === 'RETIRED')
		workflowBtn = `<button class="btn btn-ghost btn-sm" data-action="transition" data-to="ARCHIVED">Archive</button> <button class="btn btn-primary btn-sm" data-action="transition" data-to="PUBLISHED">Republish</button>`

	li.innerHTML = `
        <div class="event-card-body">${buildCardBody(ev)}</div>
        <div class="event-card-actions">
            ${workflowBtn}
            <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-sm" data-action="delete" style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);">Delete</button>
        </div>
    `

	li.querySelector('[data-action="edit"]').addEventListener('click', () =>
		openEventEditForm(ev)
	)
	li.querySelector('[data-action="delete"]').addEventListener(
		'click',
		() => openEventModal(ev.title, ev.event_id)
	)
	li.querySelectorAll('[data-action="transition"]').forEach((b) => {
		b.addEventListener('click', async () => {
			const to = b.dataset.to
			b.disabled = true
			try {
				const res = await fetch(
					`${EVENTS_API}/${ev.event_id}/transition`,
					{
						method: 'POST',
						credentials: 'include',
						headers: {
							'Content-Type':
								'application/json',
						},
						body: JSON.stringify({ to }),
					}
				)
				const data = await res.json()
				if (!res.ok)
					throw new Error(
						data.error ||
							'Transition failed'
					)
				showToast(
					data.message || `Moved to ${to}`,
					'success'
				)
				loadEvents()
			} catch (err) {
				showToast(err.message, 'error')
				b.disabled = false
			}
		})
	})

	return li
}

btnNew.addEventListener('click', () => {
	resetEventForm()
	f('f-curation').value = 'DRAFT'
	f('f-campaign').value = ''
	renderCurationActions('DRAFT')
	populateCampaignSelect()
	formHeading.textContent = 'New Event'
	btnSubmit.textContent = 'Save Event'
	btnSubmit.disabled = false
	editLayout.classList.remove('hidden')
	document.getElementById('event-sub-tabs').style.display = ''
	resetSubTabs('details')
	setSubTabsEnabled(false)
	showEventForm()
})

async function populateCampaignSelect(selected = null) {
	const sel = f('f-campaign')
	if (!sel) return
	try {
		const res = await fetch(`${API_BASE}/api/campaigns?all=true`, {
			credentials: 'include',
		})
		if (!res.ok) return
		const data = await res.json()
		allCampaigns = data
		sel.innerHTML = '<option value="">— none —</option>'
		data.forEach((c) => {
			const o = document.createElement('option')
			o.value = c.campaign_id
			o.textContent = `${c.name} (${c.status}${c.term ? ' · ' + c.term : ''}${c.is_open_day ? ' · open day' : ''})`
			sel.appendChild(o)
		})
		if (selected) sel.value = selected
	} catch {}
}
f('f-curation')?.addEventListener('change', (e) =>
	renderCurationActions(e.target.value)
)
populateCampaignSelect()

btnCancel.addEventListener('click', () => {
	resetEventForm()
	editLayout.classList.add('hidden')
	showEventList()
	loadEvents()
})

async function openEventEditForm(ev) {
	resetEventForm()
	// The question/pool panels key off this — set it synchronously so
	// saves always target the open event, no matter which entry point
	// (event list, hard-question Repair, stale-event Edit) got here.
	currentEventId = ev.event_id
	formHeading.textContent = 'Edit Event'
	btnSubmit.textContent = 'Save Changes'
	btnSubmit.disabled = false

	editIdInput.value = ev.event_id
	f('f-title').value = ev.title ?? ''
	f('f-description').value = ev.description ?? ''
	f('f-latitude').value = ev.latitude ?? ''
	f('f-longitude').value = ev.longitude ?? ''
	f('f-radius').value = ev.radius_meters ?? ''
	f('f-threshold').value = ev.point_threshold ?? 0
	f('f-reward').value = ev.point_reward ?? 10
	f('f-cooldown').value = ev.attempt_cooldown_s ?? 86400
	f('f-max-attempts').value = ev.max_attempts_per_window ?? 1
	f('f-interval').value = ev.repeat_interval ?? ''
	f('f-active').checked = !!ev.is_active
	f('f-starts').value = toDatetimeLocal(ev.starts_at)
	f('f-ends').value = toDatetimeLocal(ev.ends_at)
	await populateCampaignSelect(ev.campaign_id ?? null)
	f('f-curation').value = ev.curation_status ?? 'DRAFT'
	renderCurationActions(ev.curation_status ?? 'DRAFT')

	showEventForm()
	editLayout.classList.remove('hidden')
	document.getElementById('event-sub-tabs').style.display = ''
	resetSubTabs('details')
	setSubTabsEnabled(true)
	// Load the question + card-pool panels for this event (previously
	// only the event-list click path did this, so Repair/stale-Edit
	// entries left the panels pointing at the wrong event).
	loadQuestions(ev.event_id)
	loadPool(ev.event_id)
	populatePoolCardSelect()
}

function renderCurationActions(status) {
	const el = document.getElementById('curation-actions')
	if (!el) return
	el.innerHTML = ''
	const s = status || 'DRAFT'
	const mk = (label, to, cls = 'btn-ghost') => {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = `btn ${cls} btn-sm`
		b.textContent = label
		b.addEventListener('click', async () => {
			const id = editIdInput.value
			if (!id) return showToast('Save event first', 'error')
			b.disabled = true
			try {
				const res = await fetch(
					`${EVENTS_API}/${id}/transition`,
					{
						method: 'POST',
						credentials: 'include',
						headers: {
							'Content-Type':
								'application/json',
						},
						body: JSON.stringify({ to }),
					}
				)
				const data = await res.json()
				if (!res.ok)
					throw new Error(data.error || 'Failed')
				showToast(data.message, 'success')
				f('f-curation').value = to
				renderCurationActions(to)
				loadEvents()
			} catch (e) {
				showToast(e.message, 'error')
				b.disabled = false
			}
		})
		el.appendChild(b)
	}
	if (s === 'DRAFT') mk('Submit for review → In Review', 'IN_REVIEW')
	else if (s === 'IN_REVIEW') {
		mk('Publish ✓', 'PUBLISHED', 'btn-primary')
		mk('Back to Draft', 'DRAFT')
	} else if (s === 'PUBLISHED') {
		mk('Retire', 'RETIRED')
		mk('Send back to Review', 'IN_REVIEW')
	} else if (s === 'RETIRED') {
		mk('Republish', 'PUBLISHED', 'btn-primary')
		mk('Archive', 'ARCHIVED')
	}
}

function resetSubTabs(active) {
	subTabBtns.forEach((b) => b.classList.remove('sub-tab-active'))
	const btn = document.querySelector(`[data-subtab="${active}"]`)
	if (btn) btn.classList.add('sub-tab-active')
	subtabDetails.classList.toggle('hidden', active !== 'details')
	subtabQuestions.classList.toggle('hidden', active !== 'questions')
	subtabPool.classList.toggle('hidden', active !== 'pool')
}

function setSubTabsEnabled(enabled) {
	subTabBtns.forEach((b) => {
		if (b.dataset.subtab !== 'details') b.disabled = !enabled
	})
}

eventForm.addEventListener('submit', async (e) => {
	e.preventDefault()

	const id = editIdInput.value

	const title = f('f-title').value.trim()
	if (!title) {
		showToast('Title is required.', 'error')
		return
	}

	const lat = parseFloat(f('f-latitude').value)
	const lng = parseFloat(f('f-longitude').value)
	if (isNaN(lat) || isNaN(lng)) {
		showToast('Valid latitude and longitude are required.', 'error')
		return
	}

	const radius = parseInt(f('f-radius').value, 10)
	if (!radius || radius < 10) {
		showToast('Radius must be at least 10 metres.', 'error')
		return
	}

	const curation_status = f('f-curation')?.value || 'DRAFT'
	const campaign_id = f('f-campaign')?.value
		? parseInt(f('f-campaign').value, 10)
		: null
	const payload = {
		title: title,
		description: f('f-description').value.trim() || null,
		latitude: lat,
		longitude: lng,
		radius_meters: radius,
		point_threshold: parseInt(f('f-threshold').value, 10) || 0,
		point_reward: parseInt(f('f-reward').value, 10) || 10,
		attempt_cooldown_s:
			parseInt(f('f-cooldown').value, 10) || 86400,
		max_attempts_per_window:
			parseInt(f('f-max-attempts').value, 10) || 1,
		repeat_interval: f('f-interval').value
			? parseInt(f('f-interval').value, 10)
			: null,
		starts_at: toUtcIso(f('f-starts').value),
		ends_at: toUtcIso(f('f-ends').value),
		is_active: f('f-active').checked,
		curation_status,
		campaign_id,
	}

	btnSubmit.disabled = true
	btnSubmit.textContent = 'Saving…'

	try {
		const url = id ? `${EVENTS_API}/${id}` : EVENTS_API
		const method = id ? 'PUT' : 'POST'

		const res = await fetch(url, {
			method,
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})

		const data = await res.json()
		if (!res.ok) {
			if (res.status === 401) {
				showToast(
					'Session expired. Please login again.',
					'error'
				)
				setTimeout(() => {
					window.location.href = '../index.html'
				}, 1000)
				return
			}
			throw new Error(
				data.error || `Server error ${res.status}`
			)
		}

		if (id) {
			// Editing existing event — go back to list as before
			showToast('Event updated successfully.', 'success')
			resetEventForm()
			showEventList()
			loadEvents()
		} else {
			// New event just created — stay on the form and open the
			// questions panel so the author can add questions immediately
			const newEventId = data.event_id
			editIdInput.value = newEventId
			formHeading.textContent = 'Edit Event'
			btnSubmit.textContent = 'Save Changes'
			btnSubmit.disabled = false

			currentEventId = newEventId
			editLayout.classList.remove('hidden')
			document.getElementById(
				'event-sub-tabs'
			).style.display = ''
			resetSubTabs('details')
			setSubTabsEnabled(true)
			resetQuestionForm()
			loadQuestions(newEventId)
			loadPool(newEventId)
			populatePoolCardSelect()

			showToast(
				'Event created! Add questions or cards via the side tabs.',
				'success'
			)
		}
	} catch (err) {
		showToast(err.message, 'error')
		btnSubmit.disabled = false
		btnSubmit.textContent = id ? 'Save Changes' : 'Save Event'
	}
})

function openEventModal(title, id) {
	pendingDeleteId = id
	modalTitle.textContent = 'Delete this event?'
	modalBody.textContent = `"${title}" will be permanently removed from the map.`
	modalOverlay.classList.remove('hidden')
	modalConfirm.onclick = doEventDelete
}

async function doEventDelete() {
	if (!pendingDeleteId) return
	const id = pendingDeleteId
	closeModal()

	try {
		const res = await fetch(`${EVENTS_API}/${id}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok) {
			if (res.status === 401) {
				showToast(
					'Session expired. Please login again.',
					'error'
				)
				setTimeout(() => {
					window.location.href = '../index.html'
				}, 1000)
				return
			}
			throw new Error(
				data.error || `Server error ${res.status}`
			)
		}

		const card = elEventList.querySelector(`[data-id="${id}"]`)
		if (card) {
			const section = card.closest('.list-section')
			card.remove()

			if (section) {
				const remaining =
					section.querySelectorAll(
						'.event-card'
					).length
				const badge =
					section.querySelector('.section-count')
				if (badge) badge.textContent = remaining
				if (remaining === 0) section.remove()
			}
		}

		allEvents = allEvents.filter((e) => e.event_id !== id)
		const remaining = allEvents.length
		if (remaining === 0) {
			elEmpty.textContent =
				'No events yet — create the first one.'
			elEmpty.classList.remove('hidden')
			eventToolbar.classList.add('hidden')
		}
		elEventCount.textContent = `${remaining} event${remaining !== 1 ? 's' : ''}`

		showToast('Event deleted.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
}

// ── CARDS CRUD ──
async function loadCards() {
	elCardLoading.classList.remove('hidden')
	elCardEmpty.classList.add('hidden')
	elCardListError.classList.add('hidden')
	elCardList.innerHTML = ''
	elCardCount.textContent = 'Loading…'
	cardToolbar.classList.add('hidden')

	try {
		const res = await fetch(CARDS_API, { credentials: 'include' })
		if (!res.ok) {
			if (res.status === 401) {
				elCardLoading.classList.add('hidden')
				return
			}
			throw new Error(`Server responded with ${res.status}`)
		}
		const data = await res.json()
		allCards = data

		elCardLoading.classList.add('hidden')

		if (!data.length) {
			elCardEmpty.classList.remove('hidden')
			elCardCount.textContent = '0 cards'
			return
		}

		cardToolbar.classList.remove('hidden')
		renderCards()
	} catch (err) {
		elCardLoading.classList.add('hidden')
		elCardListError.textContent = `Could not load cards — ${err.message}`
		elCardListError.classList.remove('hidden')
	}
}

const CARD_SECTION_ORDER = ['LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON']
const RARITY_SORT_INDEX = {
	LEGENDARY: 0,
	EPIC: 1,
	RARE: 2,
	UNCOMMON: 3,
	COMMON: 4,
}

function renderCards() {
	elCardList.innerHTML = ''
	elCardEmpty.classList.add('hidden')

	const sortBy = cardSortSelect.value
	const sorted = [...allCards].sort((a, b) => {
		switch (sortBy) {
			case 'rarity': {
				const rd =
					(RARITY_SORT_INDEX[a.rarity] ?? 9) -
					(RARITY_SORT_INDEX[b.rarity] ?? 9)
				return rd !== 0
					? rd
					: a.name.localeCompare(b.name)
			}
			case 'category':
				return (
					a.category.localeCompare(b.category) ||
					a.name.localeCompare(b.name)
				)
			default:
				return a.name.localeCompare(b.name)
		}
	})

	const groups = {}
	CARD_SECTION_ORDER.forEach((r) => {
		groups[r] = []
	})
	sorted.forEach((card) => {
		if (groups[card.rarity]) groups[card.rarity].push(card)
		else groups[card.rarity] = [card]
	})

	let visibleCount = 0
	CARD_SECTION_ORDER.forEach((key) => {
		const items = groups[key]
		if (!items || items.length === 0) return
		if (!cardFilters.has(key)) return

		visibleCount += items.length

		const details = document.createElement('details')
		details.className = 'list-section'
		details.open = true
		details.dataset.section = key

		const summary = document.createElement('summary')
		const colour = RARITY_COLOURS[key] ?? 'inherit'
		summary.innerHTML = `<span style="color:${colour}">${key.charAt(0) + key.slice(1).toLowerCase()}</span> <span class="section-count">${items.length}</span>`
		details.appendChild(summary)

		const ul = document.createElement('ul')
		ul.className = 'event-list'
		items.forEach((card) => ul.appendChild(buildCardRow(card)))
		details.appendChild(ul)

		elCardList.appendChild(details)
	})

	const total = allCards.length
	if (visibleCount === total) {
		elCardCount.textContent = `${total} card${total !== 1 ? 's' : ''}`
	} else {
		elCardCount.textContent = `Showing ${visibleCount} of ${total} cards`
	}

	if (visibleCount === 0 && total > 0) {
		elCardEmpty.textContent = 'No cards match the current filters.'
		elCardEmpty.classList.remove('hidden')
	}
}

const RARITY_COLOURS = {
	COMMON: 'var(--text-muted)',
	UNCOMMON: '#27ae60',
	RARE: '#60a5fa',
	EPIC: '#a855f7',
	LEGENDARY: '#f59e0b',
}

function buildCardRow(card) {
	const li = document.createElement('li')
	li.className = 'event-card'
	li.dataset.id = card.card_id

	const rarityColour = RARITY_COLOURS[card.rarity] ?? 'inherit'

	li.innerHTML = `
        <div class="event-card-body">
            <div class="event-card-title">${card.name}</div>
            <div class="event-card-meta">
                <span style="color:${rarityColour};font-weight:600;">${card.rarity}</span>
                &nbsp;·&nbsp;
                <span>${card.category}</span>
                &nbsp;·&nbsp;
                <span>ATK ${card.stat_attack} &nbsp;LOC ${card.stat_location} &nbsp;INF ${card.stat_influence} &nbsp;LEG ${card.stat_legacy} &nbsp;ERA ${card.stat_era}</span>
            </div>
            ${card.flavour_text ? `<div class="event-card-desc" style="margin-top:0.25rem;font-style:italic;color:var(--text-muted);">"${card.flavour_text}"</div>` : ''}
        </div>
        <div class="event-card-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-sm" data-action="delete"
                style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);">
                Delete
            </button>
        </div>
    `

	li.querySelector('[data-action="edit"]').addEventListener('click', () =>
		openCardEditForm(card)
	)
	li.querySelector('[data-action="delete"]').addEventListener(
		'click',
		() => openCardModal(card.name, card.card_id)
	)

	return li
}

btnCardNew.addEventListener('click', () => {
	resetCardForm()
	cardFormHeading.textContent = 'New Card'
	btnCardSubmit.textContent = 'Save Card'
	btnCardSubmit.disabled = false
	showCardForm()
})

btnCardCancel.addEventListener('click', () => {
	resetCardForm()
	showCardList()
	loadCards()
})

function openCardEditForm(card) {
	resetCardForm()
	cardFormHeading.textContent = 'Edit Card'
	btnCardSubmit.textContent = 'Save Changes'
	btnCardSubmit.disabled = false

	cardEditId.value = card.card_id
	cf('cf-name').value = card.name ?? ''
	cf('cf-flavour').value = card.flavour_text ?? ''
	cf('cf-image').value = card.image_url ?? ''
	cf('cf-category').value = card.category ?? ''
	cf('cf-rarity').value = card.rarity ?? ''
	cf('cf-attack').value = card.stat_attack ?? 0
	cf('cf-location').value = card.stat_location ?? 0
	cf('cf-influence').value = card.stat_influence ?? 0
	cf('cf-legacy').value = card.stat_legacy ?? 100
	cf('cf-era').value = card.stat_era ?? 0
	cf('cf-ability-name').value = card.ability_name ?? ''
	cf('cf-ability-desc').value = card.ability_desc ?? ''

	showCardForm()
}

cardForm.addEventListener('submit', async (e) => {
	e.preventDefault()

	const id = cardEditId.value

	const name = cf('cf-name').value.trim()
	if (!name) {
		showToast('Name is required.', 'error')
		return
	}
	const category = cf('cf-category').value
	if (!category) {
		showToast('Category is required.', 'error')
		return
	}
	const rarity = cf('cf-rarity').value
	if (!rarity) {
		showToast('Rarity is required.', 'error')
		return
	}

	const payload = {
		name: name,
		flavour_text: cf('cf-flavour').value.trim() || null,
		image_url: cf('cf-image').value.trim() || null,
		category: category,
		rarity: rarity,
		stat_attack: parseInt(cf('cf-attack').value, 10) || 0,
		stat_location: parseInt(cf('cf-location').value, 10) || 0,
		stat_influence: parseInt(cf('cf-influence').value, 10) || 0,
		stat_legacy: parseInt(cf('cf-legacy').value, 10) || 100,
		stat_era: parseInt(cf('cf-era').value, 10) || 0,
		ability_name: cf('cf-ability-name').value.trim() || null,
		ability_desc: cf('cf-ability-desc').value.trim() || null,
	}

	btnCardSubmit.disabled = true
	btnCardSubmit.textContent = 'Saving…'

	try {
		const url = id ? `${CARDS_API}/${id}` : CARDS_API
		const method = id ? 'PUT' : 'POST'

		const res = await fetch(url, {
			method,
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})

		const data = await res.json()
		if (!res.ok) {
			if (res.status === 401) {
				showToast(
					'Session expired. Please login again.',
					'error'
				)
				setTimeout(() => {
					window.location.href = '../index.html'
				}, 1000)
				return
			}
			throw new Error(
				data.error || `Server error ${res.status}`
			)
		}

		showToast(
			id
				? 'Card updated successfully.'
				: 'Card created successfully.',
			'success'
		)
		resetCardForm()
		showCardList()
		loadCards()
	} catch (err) {
		showToast(err.message, 'error')
		btnCardSubmit.disabled = false
		btnCardSubmit.textContent = id ? 'Save Changes' : 'Save Card'
	}
})

function openCardModal(name, id) {
	pendingCardDeleteId = id
	modalTitle.textContent = 'Delete this card?'
	modalBody.textContent = `"${name}" will be permanently removed. This will fail if the card is still linked to an event pool or player collection.`
	modalOverlay.classList.remove('hidden')
	modalConfirm.onclick = doCardDelete
}

async function doCardDelete() {
	if (!pendingCardDeleteId) return
	const id = pendingCardDeleteId
	closeModal()

	try {
		const res = await fetch(`${CARDS_API}/${id}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		const row = elCardList.querySelector(`[data-id="${id}"]`)
		if (row) {
			const section = row.closest('.list-section')
			row.remove()

			if (section) {
				const remaining =
					section.querySelectorAll(
						'.event-card'
					).length
				const badge =
					section.querySelector('.section-count')
				if (badge) badge.textContent = remaining
				if (remaining === 0) section.remove()
			}
		}

		allCards = allCards.filter((c) => c.card_id !== id)
		const remaining = allCards.length
		if (remaining === 0) {
			elCardEmpty.textContent =
				'No cards yet — create the first one.'
			elCardEmpty.classList.remove('hidden')
			cardToolbar.classList.add('hidden')
		}
		elCardCount.textContent = `${remaining} card${remaining !== 1 ? 's' : ''}`

		showToast('Card deleted.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
}

// ── MODAL ──
function closeModal() {
	pendingDeleteId = null
	pendingCardDeleteId = null
	modalConfirm.onclick = null
	modalOverlay.classList.add('hidden')
}

modalCancel.addEventListener('click', closeModal)
modalOverlay.addEventListener('click', (e) => {
	if (e.target === modalOverlay) closeModal()
})

modalConfirm.addEventListener('click', async () => {
	if (!pendingDeleteId) return
	const id = pendingDeleteId
	closeModal()

	try {
		const res = await fetch(`${EVENTS_API}/${id}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		const card = elEventList.querySelector(`[data-id="${id}"]`)
		if (card) card.remove()

		const remaining =
			elEventList.querySelectorAll('.event-card').length
		elEventCount.textContent = `${remaining} event${remaining !== 1 ? 's' : ''}`
		if (!remaining) elEmpty.classList.remove('hidden')

		showToast('Event deleted.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
})

function resetForm() {
	eventForm.reset()
	editIdInput.value = ''
	f('f-active').checked = true
}

checkAccess()

// ============================================================
// User Story 6 — Question authoring panel.
//
// This entire section is ADDITIVE: it does not modify the event form,
// the event CRUD handlers, or any existing function above it. It hooks
// into the existing edit/new/cancel flow via additional (parallel)
// listeners so it merges cleanly with other in-progress branches.
// ============================================================
const qPanel = document.getElementById('questions-panel')
const qList = document.getElementById('question-list')
const qCount = document.getElementById('question-count')
const qLoading = document.getElementById('question-loading')
const qEmpty = document.getElementById('question-empty')
const qForm = document.getElementById('question-form')
const qEditIdInput = document.getElementById('q-edit-id')
const qTextInput = document.getElementById('q-text')
const qTypeSelect = document.getElementById('q-type')
const qCorrectInput = document.getElementById('q-correct')
const qOptionList = document.getElementById('q-option-list')
const qOptionsField = document.getElementById('q-options-field')
const qOptionsContainer = document.getElementById('q-options-container')
const qAddOptionBtn = document.getElementById('q-add-option')
const qCancelBtn = document.getElementById('q-cancel')
const qSubmitBtn = document.getElementById('q-submit')
const qModalOverlay = document.getElementById('q-modal-overlay')
const qModalBody = document.getElementById('q-modal-body')
const qModalCancel = document.getElementById('q-modal-cancel')
const qModalConfirm = document.getElementById('q-modal-confirm')

let currentEventId = null
let pendingQuestionDeleteId = null

function escapeHtml(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

// NOTE: no elEventList delegated listener is needed here —
// openEventEditForm sets currentEventId and loads the question/pool
// panels itself for every entry point. (A parallel listener used to do
// this on bubble, double-fetching on every Edit click and resolving
// out of order on rapid clicks.)

// Brand-new events have no id yet.
btnNew.addEventListener('click', () => {
	currentEventId = null
	resetQuestionForm()
})

// Leaving the edit view resets the question form.
btnCancel.addEventListener('click', () => {
	currentEventId = null
	resetQuestionForm()
})

async function loadQuestions(eventId) {
	qLoading.classList.remove('hidden')
	qEmpty.classList.add('hidden')
	qList.innerHTML = ''
	qCount.textContent = 'Loading…'

	try {
		const res = await fetch(
			`${API_BASE}/api/events/${eventId}/questions`,
			{ credentials: 'include' }
		)
		if (!res.ok)
			throw new Error(`Server responded with ${res.status}`)
		const data = await res.json()

		qLoading.classList.add('hidden')
		qCount.textContent = `${data.length} question${data.length !== 1 ? 's' : ''}`

		if (!data.length) {
			qEmpty.classList.remove('hidden')
			return
		}

		qList.append(...data.map(buildQuestionItem))
	} catch (err) {
		qLoading.classList.add('hidden')
		qCount.textContent = 'Could not load questions'
		showToast(err.message, 'error')
	}
}

function buildQuestionItem(q) {
	const li = document.createElement('li')
	li.className = 'q-item'
	li.dataset.id = q.id

	const typeLabel = String(q.type).replace(/_/g, ' ').toLowerCase()
	let meta = typeLabel
	if (q.type === 'MULTIPLE_CHOICE' && Array.isArray(q.options)) {
		meta += ` · ${q.options.length} options`
	}

	li.innerHTML = `
		<div>
			<div class="q-item-text">${escapeHtml(q.text)}</div>
			<div class="q-item-meta">${escapeHtml(meta)}</div>
		</div>
		<div class="q-item-actions">
			<button class="btn btn-ghost btn-sm" data-q-action="edit">Edit</button>
			<button class="btn btn-sm" data-q-action="delete"
				style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);">
				Delete
			</button>
		</div>
	`

	li.querySelector('[data-q-action="edit"]').addEventListener(
		'click',
		() => openQuestionEdit(q)
	)
	li.querySelector('[data-q-action="delete"]').addEventListener(
		'click',
		() => openQuestionDeleteModal(q)
	)

	return li
}

function collectOptions() {
	return [...qOptionsContainer.querySelectorAll('.q-option-row input')]
		.map((i) => i.value.trim())
		.filter((v) => v.length)
}

function refreshCorrectDatalist(type) {
	qOptionList.innerHTML = ''
	if (type === 'MULTIPLE_CHOICE') {
		collectOptions().forEach((v) => {
			const o = document.createElement('option')
			o.value = v
			qOptionList.appendChild(o)
		})
	} else if (type === 'TRUE_FALSE') {
		;['true', 'false'].forEach((v) => {
			const o = document.createElement('option')
			o.value = v
			qOptionList.appendChild(o)
		})
	}
}

function updateCorrectPlaceholder(type, opts) {
	qCorrectInput.placeholder = correctAnswerPlaceholder(type, opts)
}

function addOptionRow(value = '') {
	const row = document.createElement('div')
	row.className = 'q-option-row'

	const input = document.createElement('input')
	input.type = 'text'
	input.value = value
	input.placeholder = 'Option text'
	input.dataset.role = 'q-option-input'

	const removeBtn = document.createElement('button')
	removeBtn.type = 'button'
	removeBtn.className = 'btn btn-ghost btn-sm'
	removeBtn.textContent = '✕'
	removeBtn.dataset.role = 'q-option-remove'

	row.append(input, removeBtn)
	qOptionsContainer.appendChild(row)
}

// Delegated handlers for the dynamic option rows.
qOptionsContainer.addEventListener('input', (e) => {
	if (e.target.dataset.role !== 'q-option-input') return
	refreshCorrectDatalist('MULTIPLE_CHOICE')
})
qOptionsContainer.addEventListener('click', (e) => {
	if (e.target.dataset.role !== 'q-option-remove') return
	e.target.closest('.q-option-row')?.remove()
	refreshCorrectDatalist('MULTIPLE_CHOICE')
})

qAddOptionBtn.addEventListener('click', () => {
	addOptionRow()
	refreshCorrectDatalist('MULTIPLE_CHOICE')
})

qTypeSelect.addEventListener('change', () => {
	const type = qTypeSelect.value
	if (type === 'MULTIPLE_CHOICE') {
		qOptionsField.classList.remove('hidden')
		if (!qOptionsContainer.children.length) {
			addOptionRow()
			addOptionRow()
		}
	} else {
		qOptionsField.classList.add('hidden')
	}
	refreshCorrectDatalist(type)
	updateCorrectPlaceholder(type)
})

function syncOptionsForType(type, existing) {
	if (type === 'MULTIPLE_CHOICE') {
		qOptionsField.classList.remove('hidden')
		qOptionsContainer.innerHTML = ''
		const opts =
			Array.isArray(existing) && existing.length
				? existing
				: ['', '']
		opts.forEach((v) => addOptionRow(v))
	} else {
		qOptionsField.classList.add('hidden')
		qOptionsContainer.innerHTML = ''
	}
	refreshCorrectDatalist(type)
	updateCorrectPlaceholder(type)
}

function openQuestionEdit(q) {
	resetQuestionForm()
	qEditIdInput.value = q.id
	qTextInput.value = q.text ?? ''
	qTypeSelect.value = q.type
	// correctAnswer is intentionally NOT pre-filled: the list endpoint
	// deliberately omits it (kept hidden from players). The author
	// re-enters it on save.
	qCorrectInput.value = ''
	syncOptionsForType(q.type, q.options)
	updateCorrectPlaceholder(q.type, { editing: true })
	qSubmitBtn.textContent = 'Save Changes'
}

function resetQuestionForm() {
	qForm.reset()
	qEditIdInput.value = ''
	qOptionsContainer.innerHTML = ''
	qOptionList.innerHTML = ''
	qSubmitBtn.textContent = 'Save Question'
	// Default type is MULTIPLE_CHOICE (first <option>); seed two empty rows.
	syncOptionsForType('MULTIPLE_CHOICE', null)
}

qCancelBtn.addEventListener('click', resetQuestionForm)
// The HTML default only suits one type — set it from the actual select.
updateCorrectPlaceholder(qTypeSelect.value)

qForm.addEventListener('submit', async (e) => {
	e.preventDefault()

	const id = qEditIdInput.value
	const type = qTypeSelect.value
	const text = qTextInput.value.trim()
	const correctAnswer = qCorrectInput.value.trim()
	const options = type === 'MULTIPLE_CHOICE' ? collectOptions() : null

	if (!text) {
		showToast('Question text is required.', 'error')
		return
	}
	if (!correctAnswer) {
		showToast('Correct answer is required.', 'error')
		return
	}
	if (type === 'MULTIPLE_CHOICE') {
		if (!options.length) {
			showToast('Add at least one option.', 'error')
			return
		}
		if (!options.includes(correctAnswer)) {
			showToast(
				'Correct answer must match one of the options.',
				'error'
			)
			return
		}
	}
	if (
		type === 'TRUE_FALSE' &&
		!['true', 'false'].includes(correctAnswer.toLowerCase())
	) {
		showToast(
			'True/False answer must be "true" or "false".',
			'error'
		)
		return
	}
	if (!id && !currentEventId) {
		showToast(
			'Save the event first before adding questions.',
			'error'
		)
		return
	}

	qSubmitBtn.disabled = true
	qSubmitBtn.textContent = 'Saving…'

	try {
		const url = id
			? `${API_BASE}/api/questions/${id}`
			: `${API_BASE}/api/events/${currentEventId}/questions`
		const method = id ? 'PUT' : 'POST'

		const res = await fetch(url, {
			method,
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type,
				text,
				correctAnswer,
				options,
			}),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		showToast(
			id ? 'Question updated.' : 'Question created.',
			'success'
		)
		resetQuestionForm()
		loadQuestions(currentEventId)
	} catch (err) {
		showToast(err.message, 'error')
	} finally {
		qSubmitBtn.disabled = false
		qSubmitBtn.textContent = 'Save Question'
	}
})

function openQuestionDeleteModal(q) {
	pendingQuestionDeleteId = q.id
	qModalBody.textContent = `"${q.text}" will be permanently removed from this event.`
	qModalOverlay.classList.remove('hidden')
}

function closeQuestionDeleteModal() {
	pendingQuestionDeleteId = null
	qModalOverlay.classList.add('hidden')
}

qModalCancel.addEventListener('click', closeQuestionDeleteModal)
qModalOverlay.addEventListener('click', (e) => {
	if (e.target === qModalOverlay) closeQuestionDeleteModal()
})

qModalConfirm.addEventListener('click', async () => {
	if (!pendingQuestionDeleteId) return
	const id = pendingQuestionDeleteId
	closeQuestionDeleteModal()

	try {
		const res = await fetch(`${API_BASE}/api/questions/${id}`, {
			method: 'DELETE',
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		const item = qList.querySelector(`[data-id="${id}"]`)
		if (item) item.remove()

		const remaining = qList.querySelectorAll('.q-item').length
		qCount.textContent = `${remaining} question${remaining !== 1 ? 's' : ''}`
		if (!remaining) qEmpty.classList.remove('hidden')

		showToast('Question deleted.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
})

// ============================================================
// Sub-tab switching
// ============================================================
subTabBtns.forEach((btn) => {
	btn.addEventListener('click', () => {
		resetSubTabs(btn.dataset.subtab)
	})
})

// ============================================================
// Filter chips + sort controls
// ============================================================
function wireFilterChips(container, filterSet, allKeys, renderFn) {
	container.addEventListener('click', (e) => {
		const chip = e.target.closest('.filter-chip')
		if (!chip) return
		const key = chip.dataset.filter

		if (key === 'all') {
			const allActive = allKeys.every((k) => filterSet.has(k))
			if (allActive) {
				allKeys.forEach((k) => filterSet.delete(k))
			} else {
				allKeys.forEach((k) => filterSet.add(k))
			}
		} else {
			if (filterSet.has(key)) {
				filterSet.delete(key)
			} else {
				filterSet.add(key)
			}
		}

		container.querySelectorAll('.filter-chip').forEach((c) => {
			const k = c.dataset.filter
			if (k === 'all') {
				c.classList.toggle(
					'active',
					allKeys.every((k2) => filterSet.has(k2))
				)
			} else {
				c.classList.toggle('active', filterSet.has(k))
			}
		})

		renderFn()
	})
}

// inject missing curation filter chips dynamically
;(function ensureCurationChips() {
	if (!eventFilterChips) return
	const needed = [
		['draft', 'Draft'],
		['in_review', 'In Review'],
		['published', 'Published'],
		['retired', 'Retired'],
		['archived', 'Archived'],
	]
	needed.forEach(([key, label]) => {
		if (!eventFilterChips.querySelector(`[data-filter="${key}"]`)) {
			const b = document.createElement('button')
			b.type = 'button'
			b.className = 'meta-pill filter-chip active'
			b.dataset.filter = key
			b.textContent = label
			eventFilterChips.appendChild(b)
		}
	})
})()
wireFilterChips(
	eventFilterChips,
	eventFilters,
	[
		'draft',
		'in_review',
		'published',
		'active',
		'scheduled',
		'retired',
		'archived',
		'inactive',
		'expired',
	],
	renderEvents
)
wireFilterChips(
	cardFilterChips,
	cardFilters,
	['LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON'],
	renderCards
)

eventSortSelect.addEventListener('change', renderEvents)
togglePastPopups?.addEventListener('change', renderEvents)
cardSortSelect.addEventListener('change', renderCards)

// ============================================================
// Card Pool Management
// ============================================================
const POOL_API = (eventId) => `${EVENTS_API}/${eventId}/pool`

async function loadPool(eventId) {
	poolLoading.classList.remove('hidden')
	poolEmpty.classList.add('hidden')
	poolList.innerHTML = ''
	poolCount.textContent = 'Loading…'

	try {
		const res = await fetch(POOL_API(eventId), {
			credentials: 'include',
		})
		if (!res.ok)
			throw new Error(`Server responded with ${res.status}`)
		const data = await res.json()

		poolLoading.classList.add('hidden')
		poolCount.textContent = `${data.length} card${data.length !== 1 ? 's' : ''} in pool`

		if (!data.length) {
			poolEmpty.classList.remove('hidden')
			return
		}
		data.forEach((item) =>
			poolList.appendChild(buildPoolItem(item))
		)
	} catch (err) {
		poolLoading.classList.add('hidden')
		poolCount.textContent = 'Could not load pool'
		showToast(err.message, 'error')
	}
}

function buildPoolItem(item) {
	const li = document.createElement('li')
	li.className = 'pool-item'
	li.dataset.poolId = item.pool_id

	const rarityColour = RARITY_COLOURS[item.rarity] ?? 'inherit'

	const limitLabel =
		item.global_copy_limit != null
			? `${item.copies_awarded} / ${item.global_copy_limit} awarded`
			: `${item.copies_awarded} awarded (unlimited)`

	li.innerHTML = `
		<div>
			<div class="pool-item-name">${escapeHtml(item.name)}</div>
			<div class="pool-item-meta">
				<span style="color:${rarityColour};font-weight:600;">${escapeHtml(item.rarity)}</span>
				<span>&middot; ${escapeHtml(item.category)}</span>
				<span>&middot; Wt:</span>
				<input type="number" min="1" value="${item.weight}"
					class="pool-inline-field" data-field="weight" data-pool-id="${item.pool_id}" />
				<span>&middot; Limit:</span>
				<input type="number" min="1" value="${item.global_copy_limit ?? ''}"
					placeholder="∞"
					class="pool-inline-field" data-field="limit" data-pool-id="${item.pool_id}" />
				<span>&middot; ${escapeHtml(limitLabel)}</span>
			</div>
		</div>
		<div class="pool-item-actions">
			<button class="btn btn-ghost btn-sm" data-pool-action="save">Save</button>
			<button class="btn btn-sm" data-pool-action="remove"
				style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);">
				Remove
			</button>
		</div>
	`

	li.querySelector('[data-pool-action="save"]').addEventListener(
		'click',
		() => savePoolEntry(item.pool_id, li)
	)
	li.querySelector('[data-pool-action="remove"]').addEventListener(
		'click',
		() => openPoolDeleteModal(item.name, item.pool_id)
	)

	return li
}

async function savePoolEntry(poolId, li) {
	const weightInput = li.querySelector('[data-field="weight"]')
	const limitInput = li.querySelector('[data-field="limit"]')

	const weight = parseInt(weightInput.value, 10) || 1
	const limitVal = limitInput.value.trim()
	const global_copy_limit = limitVal ? parseInt(limitVal, 10) : null

	try {
		const res = await fetch(
			`${POOL_API(currentEventId)}/${poolId}`,
			{
				method: 'PUT',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					weight,
					global_copy_limit,
				}),
			}
		)
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)
		showToast('Pool entry updated.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
}

async function populatePoolCardSelect() {
	if (!allCards.length) {
		try {
			const res = await fetch(CARDS_API, {
				credentials: 'include',
			})
			if (res.ok) allCards = await res.json()
		} catch {
			/* ignore */
		}
	}

	poolSelect.innerHTML = '<option value="">-- pick a card --</option>'
	const sorted = [...allCards].sort((a, b) => {
		const rarityOrder = {
			COMMON: 0,
			UNCOMMON: 1,
			RARE: 2,
			EPIC: 3,
			LEGENDARY: 4,
		}
		const rd =
			(rarityOrder[a.rarity] ?? 0) -
			(rarityOrder[b.rarity] ?? 0)
		if (rd !== 0) return rd
		return a.name.localeCompare(b.name)
	})
	sorted.forEach((card) => {
		const opt = document.createElement('option')
		opt.value = card.card_id
		opt.textContent = `${card.name} (${card.rarity})`
		poolSelect.appendChild(opt)
	})
}

poolForm.addEventListener('submit', async (e) => {
	e.preventDefault()

	const cardId = poolSelect.value
	if (!cardId) {
		showToast('Please select a card.', 'error')
		return
	}
	if (!currentEventId) {
		showToast('Save the event first.', 'error')
		return
	}

	const weight = parseInt(poolWeight.value, 10) || 1
	const limitVal = poolCopyLimit.value.trim()
	const global_copy_limit = limitVal ? parseInt(limitVal, 10) : null

	poolSubmit.disabled = true
	poolSubmit.textContent = 'Adding…'

	try {
		const res = await fetch(POOL_API(currentEventId), {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				card_id: parseInt(cardId, 10),
				weight,
				global_copy_limit,
			}),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		showToast('Card added to pool.', 'success')
		poolForm.reset()
		loadPool(currentEventId)
	} catch (err) {
		showToast(err.message, 'error')
	} finally {
		poolSubmit.disabled = false
		poolSubmit.textContent = 'Add to Pool'
	}
})

function openPoolDeleteModal(name, poolId) {
	pendingPoolDeleteId = poolId
	poolModalBody.textContent = `"${name}" will be removed from this event's card pool.`
	poolModalOverlay.classList.remove('hidden')
}

function closePoolDeleteModal() {
	pendingPoolDeleteId = null
	poolModalOverlay.classList.add('hidden')
}

poolModalCancel.addEventListener('click', closePoolDeleteModal)
poolModalOverlay.addEventListener('click', (e) => {
	if (e.target === poolModalOverlay) closePoolDeleteModal()
})

poolModalConfirm.addEventListener('click', async () => {
	if (!pendingPoolDeleteId) return
	const poolId = pendingPoolDeleteId
	closePoolDeleteModal()

	try {
		const res = await fetch(
			`${POOL_API(currentEventId)}/${poolId}`,
			{
				method: 'DELETE',
				credentials: 'include',
			}
		)
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || `Server error ${res.status}`
			)

		const item = poolList.querySelector(
			`[data-pool-id="${poolId}"]`
		)
		if (item) item.remove()

		const remaining = poolList.querySelectorAll('.pool-item').length
		poolCount.textContent = `${remaining} card${remaining !== 1 ? 's' : ''} in pool`
		if (!remaining) poolEmpty.classList.remove('hidden')

		showToast('Card removed from pool.', 'success')
	} catch (err) {
		showToast(err.message, 'error')
	}
})

// ============================================================
// Campaigns CRUD
// ============================================================
const CAMPAIGNS_API = `${API_BASE}/api/campaigns`
const elCampList = document.getElementById('campaign-list')
const elCampCount = document.getElementById('campaign-count')
const elCampLoading = document.getElementById('campaign-loading')
const elCampEmpty = document.getElementById('campaign-empty')
const elCampError = document.getElementById('campaign-list-error')
const campViewList = document.getElementById('campaign-view-list')
const campViewForm = document.getElementById('campaign-view-form')
const campForm = document.getElementById('campaign-form')
const campHeading = document.getElementById('campaign-form-heading')
const campEditId = document.getElementById('campaign-edit-id')
const btnCampNew = document.getElementById('btn-campaign-new')
const btnCampCancel = document.getElementById('btn-campaign-cancel')
const btnCampSubmit = document.getElementById('btn-campaign-submit')

function showCampList() {
	campViewList?.classList.remove('hidden')
	campViewForm?.classList.add('hidden')
}
function showCampForm() {
	campViewList?.classList.add('hidden')
	campViewForm?.classList.remove('hidden')
}
function resetCampForm() {
	campForm?.reset()
	if (campEditId) campEditId.value = ''
	if (btnCampSubmit) {
		btnCampSubmit.disabled = false
		btnCampSubmit.textContent = 'Save Campaign'
	}
	document.getElementById('campaign-event-checkboxes').innerHTML = ''
}

async function loadCampaigns() {
	if (!elCampList) return
	elCampLoading?.classList.remove('hidden')
	elCampEmpty?.classList.add('hidden')
	elCampError?.classList.add('hidden')
	elCampList.innerHTML = ''
	elCampCount.textContent = 'Loading…'
	try {
		const res = await fetch(`${CAMPAIGNS_API}?all=true`, {
			credentials: 'include',
		})
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		allCampaigns = data
		populateCampaignSelect()
		elCampLoading?.classList.add('hidden')
		if (!data.length) {
			elCampEmpty?.classList.remove('hidden')
			elCampCount.textContent = '0 campaigns'
			return
		}
		elCampCount.textContent = `${data.length} campaign${data.length !== 1 ? 's' : ''}`
		data.forEach((c) =>
			elCampList.appendChild(buildCampaignCard(c))
		)
	} catch (err) {
		elCampLoading?.classList.add('hidden')
		if (elCampError) {
			elCampError.textContent = `Could not load — ${err.message}`
			elCampError.classList.remove('hidden')
		}
	}
}
function buildCampaignCard(c) {
	const li = document.createElement('li')
	li.className = 'event-card'
	li.dataset.id = c.campaign_id
	const statusMap = {
		DRAFT: '',
		SCHEDULED: 'gold',
		ACTIVE: 'active',
		ARCHIVED: 'inactive',
	}
	const termPill = c.term
		? `<span class="meta-pill">${esc(c.term)}</span>`
		: ''
	const openPill = c.is_open_day
		? `<span class="meta-pill gold">open day${c.open_day_label ? ': ' + esc(c.open_day_label) : ''}</span>`
		: ''
	const win = c.starts_at ? `From ${formatDT(c.starts_at)}` : 'No window'
	const end = c.ends_at
		? `<span class="meta-pill">${formatDT(c.ends_at)}</span>`
		: ''
	li.innerHTML = `<div class="event-card-body"><div class="event-card-title">${esc(c.name)}</div><div class="event-card-desc">${esc(c.description || 'No description.')}</div><div class="event-meta"><span class="meta-pill ${statusMap[c.status] || ''}">${esc(c.status)}</span>${termPill}${openPill}<span class="meta-pill">${win}</span>${end}</div></div><div class="event-card-actions"><button class="btn btn-ghost btn-sm" data-action="edit">Edit</button><button class="btn btn-sm" data-action="delete" style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);">Delete</button></div>`
	li.querySelector('[data-action="edit"]').addEventListener('click', () =>
		openCampaignEdit(c)
	)
	li.querySelector('[data-action="delete"]').addEventListener(
		'click',
		async () => {
			if (
				!confirm(
					`Delete campaign "${c.name}"? Events will be unlinked.`
				)
			)
				return
			const res = await fetch(
				`${CAMPAIGNS_API}/${c.campaign_id}`,
				{ method: 'DELETE', credentials: 'include' }
			)
			if (!res.ok) {
				const d = await res.json()
				return showToast(
					d.error || 'Delete failed',
					'error'
				)
			}
			showToast('Campaign deleted', 'success')
			loadCampaigns()
		}
	)
	return li
}
async function openCampaignEdit(c) {
	resetCampForm()
	campHeading.textContent = 'Edit Campaign'
	btnCampSubmit.textContent = 'Save Changes'
	showCampForm()
	campEditId.value = c.campaign_id
	document.getElementById('camp-name').value = c.name || ''
	document.getElementById('camp-desc').value = c.description || ''
	document.getElementById('camp-term').value = c.term || ''
	document.getElementById('camp-status').value = c.status || 'DRAFT'
	document.getElementById('camp-starts').value = toDatetimeLocal(
		c.starts_at
	)
	document.getElementById('camp-ends').value = toDatetimeLocal(c.ends_at)
	document.getElementById('camp-open-day').checked = !!c.is_open_day
	document.getElementById('camp-open-label').value =
		c.open_day_label || ''
	// load events for checkboxes
	try {
		const [evRes, linkRes] = await Promise.all([
			fetch(`${EVENTS_API}?all=true`, {
				credentials: 'include',
			}),
			fetch(`${CAMPAIGNS_API}/${c.campaign_id}`, {
				credentials: 'include',
			}),
		])
		const evs = evRes.ok ? await evRes.json() : []
		const detail = linkRes.ok
			? await linkRes.json()
			: { events: [] }
		const linked = new Set(
			(detail.events || []).map((e) => e.event_id)
		)
		const box = document.getElementById('campaign-event-checkboxes')
		box.innerHTML = ''
		if (!evs.length) box.textContent = 'No events exist yet.'
		else
			evs.forEach((ev) => {
				const id = `camp-ev-${ev.event_id}`
				const row = document.createElement('label')
				row.style.display = 'flex'
				row.style.gap = '0.5rem'
				row.style.alignItems = 'center'
				row.style.fontSize = '0.85rem'
				row.innerHTML = `<input type="checkbox" value="${ev.event_id}" ${linked.has(ev.event_id) ? 'checked' : ''} /> <span>${esc(ev.title)} <small style="color:var(--text-muted)">(${ev.curation_status || 'DRAFT'})</small></span>`
				box.appendChild(row)
			})
	} catch {}
}
btnCampNew?.addEventListener('click', async () => {
	resetCampForm()
	campHeading.textContent = 'New Campaign'
	btnCampSubmit.textContent = 'Save Campaign'
	showCampForm()
	try {
		const res = await fetch(`${EVENTS_API}?all=true`, {
			credentials: 'include',
		})
		const evs = res.ok ? await res.json() : []
		const box = document.getElementById('campaign-event-checkboxes')
		box.innerHTML = ''
		if (!evs.length) box.textContent = 'No events to link.'
		else
			evs.forEach((ev) => {
				const row = document.createElement('label')
				row.style.display = 'flex'
				row.style.gap = '0.5rem'
				row.style.alignItems = 'center'
				row.style.fontSize = '0.85rem'
				row.innerHTML = `<input type="checkbox" value="${ev.event_id}" /> <span>${esc(ev.title)}</span>`
				box.appendChild(row)
			})
	} catch {}
})
btnCampCancel?.addEventListener('click', () => {
	resetCampForm()
	showCampList()
	loadCampaigns()
})
campForm?.addEventListener('submit', async (e) => {
	e.preventDefault()
	const id = campEditId.value
	const name = document.getElementById('camp-name').value.trim()
	if (!name) return showToast('Name required', 'error')
	const payload = {
		name,
		description:
			document.getElementById('camp-desc').value.trim() ||
			null,
		term: document.getElementById('camp-term').value.trim() || null,
		status: document.getElementById('camp-status').value,
		starts_at: toUtcIso(
			document.getElementById('camp-starts').value
		),
		ends_at: toUtcIso(document.getElementById('camp-ends').value),
		is_open_day: document.getElementById('camp-open-day').checked,
		open_day_label:
			document
				.getElementById('camp-open-label')
				.value.trim() || null,
	}
	btnCampSubmit.disabled = true
	btnCampSubmit.textContent = 'Saving…'
	try {
		const url = id ? `${CAMPAIGNS_API}/${id}` : CAMPAIGNS_API
		const method = id ? 'PUT' : 'POST'
		const res = await fetch(url, {
			method,
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || 'Save failed')
		const campaignId = id || data.campaign_id
		// sync linked events
		const checked = [
			...document.querySelectorAll(
				'#campaign-event-checkboxes input:checked'
			),
		].map((i) => parseInt(i.value, 10))
		// fetch previous links to diff
		const detailRes = await fetch(
			`${CAMPAIGNS_API}/${campaignId}`,
			{ credentials: 'include' }
		)
		const detail = detailRes.ok
			? await detailRes.json()
			: { events: [] }
		const prev = new Set(
			(detail.events || []).map((e) => e.event_id)
		)
		const now = new Set(checked)
		// unlink removed
		for (const pid of prev) {
			if (!now.has(pid))
				await fetch(
					`${CAMPAIGNS_API}/${campaignId}/events/${pid}`,
					{
						method: 'DELETE',
						credentials: 'include',
					}
				)
		}
		// link new
		const toAdd = checked.filter((cid) => !prev.has(cid))
		if (toAdd.length)
			await fetch(`${CAMPAIGNS_API}/${campaignId}/events`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ event_ids: toAdd }),
			})
		showToast(
			id ? 'Campaign updated' : 'Campaign created',
			'success'
		)
		resetCampForm()
		showCampList()
		loadCampaigns()
		populateCampaignSelect()
	} catch (err) {
		showToast(err.message, 'error')
		btnCampSubmit.disabled = false
		btnCampSubmit.textContent = id
			? 'Save Changes'
			: 'Save Campaign'
	}
})

// ============================================================
// Insights: hard questions + stale events
// ============================================================
const elHardList = document.getElementById('hard-list'),
	elHardLoading = document.getElementById('hard-loading'),
	elHardEmpty = document.getElementById('hard-empty')
const elStaleList = document.getElementById('stale-list'),
	elStaleLoading = document.getElementById('stale-loading'),
	elStaleEmpty = document.getElementById('stale-empty')
const elOverview = document.getElementById('insights-overview')

async function loadInsightsOverview() {
	if (!elOverview) return
	try {
		const res = await fetch(`${API_BASE}/api/analytics/overview`, {
			credentials: 'include',
		})
		if (!res.ok) throw new Error('failed')
		const data = await res.json()
		elOverview.innerHTML = `
			<div style="flex:1;min-width:140px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Hard questions</div><div style="font-size:1.6rem;font-weight:800;color:var(--danger)">${data.hard_questions ?? 0}</div></div>
			<div style="flex:1;min-width:140px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Too-easy questions</div><div style="font-size:1.6rem;font-weight:800;color:var(--success, #27ae60)">${data.easy_questions ?? '—'}</div></div>
			<div style="flex:1;min-width:140px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Stale events</div><div style="font-size:1.6rem;font-weight:800;color:var(--accent)">${data.stale_events ?? 0}</div></div>
			<div style="flex:1;min-width:140px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Attempts logged</div><div style="font-size:1.6rem;font-weight:800">${data.total_attempts ?? '—'}</div></div>
			<div style="flex:1;min-width:140px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Cards issued</div><div style="font-size:1.6rem;font-weight:800">${data.total_awards ?? '—'}</div></div>
			<div style="flex:2;min-width:220px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;"><div style="font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Events by curation</div><div style="font-size:0.82rem;margin-top:0.25rem;">${(data.statusCounts || []).map((r) => `${esc(r.status)}: ${r.count}`).join(' · ') || '—'}</div></div>`
	} catch {
		elOverview.textContent = 'Could not load overview.'
	}
}
// ── User Story 10 — engagement view (attempts/visits per event, sortable) ──
const elEngagementList = document.getElementById('engagement-list')
const elEngagementLoading = document.getElementById('engagement-loading')
const elEngagementEmpty = document.getElementById('engagement-empty')
const elEngagementSort = document.getElementById('engagement-sort')

async function loadEngagement() {
	if (!elEngagementList) return
	const [sort = 'attempts', order = 'desc'] = (
		elEngagementSort?.value || 'attempts-desc'
	).split('-')
	elEngagementLoading?.classList.remove('hidden')
	elEngagementEmpty?.classList.add('hidden')
	elEngagementList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/analytics/engagement?sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(order)}&limit=50`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		elEngagementLoading?.classList.add('hidden')
		if (!data.length) {
			elEngagementEmpty?.classList.remove('hidden')
			return
		}
		data.forEach((ev) => {
			const li = document.createElement('li')
			li.className = 'event-card'
			const rate =
				ev.correct_rate == null
					? '—'
					: `${Math.round(ev.correct_rate * 100)}%`
			const ignored =
				ev.attempts === 0
					? ' <span class="meta-pill">ignored</span>'
					: ''
			li.innerHTML = `<div class="event-card-body"><div class="event-card-title">${esc(ev.title)}${ignored}</div><div class="event-card-desc">${ev.attempts} attempts · ${ev.unique_players} players · ${ev.visits} visits (${ev.unique_visitors} visitors) · ${rate} correct${ev.last_activity ? ` · last ${esc(formatDT(ev.last_activity) || ev.last_activity)}` : ' · never attempted'}</div></div><div class="event-card-actions"><span class="meta-pill ${ev.is_active ? 'active' : ''}">${esc(ev.curation_status || (ev.is_active ? 'active' : 'inactive'))}</span></div>`
			elEngagementList.appendChild(li)
		})
	} catch (err) {
		elEngagementLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}
elEngagementSort?.addEventListener('change', loadEngagement)

// ── User Story 10 — question difficulty (correct-rate, too easy + too hard) ──
const elDifficultyList = document.getElementById('difficulty-list')
const elDifficultyLoading = document.getElementById('difficulty-loading')
const elDifficultyEmpty = document.getElementById('difficulty-empty')
const elDifficultyFilter = document.getElementById('difficulty-filter')
const elDifficultySort = document.getElementById('difficulty-sort')

const DIFFICULTY_FLAG_STYLE = {
	TOO_HARD: 'color:var(--danger);font-weight:700',
	TOO_EASY: 'color:var(--success, #27ae60);font-weight:700',
	OK: 'color:var(--text-muted)',
	IGNORED: 'color:var(--text-muted);font-style:italic',
}

async function loadDifficulty() {
	if (!elDifficultyList) return
	const [sort = 'correct_rate', order = 'asc'] = (
		elDifficultySort?.value || 'correct_rate-asc'
	).split('-')
	const flag = elDifficultyFilter?.value || 'all'
	elDifficultyLoading?.classList.remove('hidden')
	elDifficultyEmpty?.classList.add('hidden')
	elDifficultyList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/analytics/questions/difficulty?min_attempts=0&flag=${encodeURIComponent(flag)}&sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(order)}&limit=50`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		elDifficultyLoading?.classList.add('hidden')
		if (!data.length) {
			elDifficultyEmpty?.classList.remove('hidden')
			return
		}
		data.forEach((q) => {
			const li = document.createElement('li')
			li.className = 'q-item'
			const rate =
				q.correct_rate == null
					? 'no attempts'
					: `${Math.round(q.correct_rate * 100)}% correct (${q.correct}/${q.attempts})`
			li.innerHTML = `<div><div class="q-item-text">${esc(q.text)}</div><div class="q-item-meta">${esc(q.event_title)} · ${esc(
				String(q.type || '')
					.replace('_', ' ')
					.toLowerCase()
			)} · ${q.attempts} attempts · ${esc(rate)} · <span style="${DIFFICULTY_FLAG_STYLE[q.flag] || ''}">${esc(q.flag.replace('_', ' '))}</span></div></div>`
			elDifficultyList.appendChild(li)
		})
	} catch (err) {
		elDifficultyLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}
elDifficultyFilter?.addEventListener('change', loadDifficulty)
elDifficultySort?.addEventListener('change', loadDifficulty)

// ── User Story 10 — card drop-rate view (actual vs configured) ──
const elDropList = document.getElementById('droprate-list')
const elDropLoading = document.getElementById('droprate-loading')
const elDropEmpty = document.getElementById('droprate-empty')
const elDropSubtitle = document.getElementById('droprate-subtitle')
const btnDropRefresh = document.getElementById('btn-droprate-refresh')

async function loadDropRates() {
	if (!elDropList) return
	elDropLoading?.classList.remove('hidden')
	elDropEmpty?.classList.add('hidden')
	elDropList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/analytics/cards/drop-rates?limit=100`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		elDropLoading?.classList.add('hidden')
		if (elDropSubtitle)
			elDropSubtitle.textContent = `${data.total_awards} total awards · pool weight ${data.total_weight} — actual issuance rate per card vs configured pool weight / rarity.`
		const cards = data.cards || []
		if (!cards.length) {
			elDropEmpty?.classList.remove('hidden')
			return
		}
		cards.forEach((c) => {
			const li = document.createElement('li')
			li.className = 'event-card'
			const actual = `${(c.actual_rate * 100).toFixed(1)}%`
			const expected =
				c.expected_rate == null
					? 'not in any pool'
					: `${(c.expected_rate * 100).toFixed(1)}%`
			const drift =
				c.drift == null
					? ''
					: ` · drift ${c.drift > 0 ? '+' : ''}${(c.drift * 100).toFixed(1)}pp`
			li.innerHTML = `<div class="event-card-body"><div class="event-card-title">${esc(c.name)} <span class="meta-pill">${esc(c.rarity)}</span></div><div class="event-card-desc">issued ${c.times_awarded}× (${actual} actual vs ${expected} expected${drift}) · weight ${c.configured_weight}${c.sample_copy_limit != null ? ` · copy limit ${c.sample_copy_limit}` : ''}</div></div>`
			elDropList.appendChild(li)
		})
	} catch (err) {
		elDropLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}
btnDropRefresh?.addEventListener('click', loadDropRates)

async function loadHardQuestions() {
	if (!elHardList) return
	elHardLoading?.classList.remove('hidden')
	elHardEmpty?.classList.add('hidden')
	elHardList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/analytics/questions/hard?threshold=0.6&min_attempts=5&limit=20`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		elHardLoading?.classList.add('hidden')
		if (!data.length) {
			elHardEmpty?.classList.remove('hidden')
			return
		}
		data.forEach((q) => {
			const li = document.createElement('li')
			li.className = 'q-item'
			const pct = Math.round(q.failure_rate * 100)
			li.innerHTML = `<div><div class="q-item-text">${esc(q.text)}</div><div class="q-item-meta">${esc(q.event_title)} · ${esc(q.type.replace('_', ' ').toLowerCase())} · ${q.attempts} attempts · <span style="color:var(--danger);font-weight:700">${pct}% wrong</span> (${q.wrong} wrong / ${q.correct} correct)</div><div style="margin-top:0.35rem;display:flex;gap:0.35rem;flex-wrap:wrap;">${(q.options || []).map((o) => `<span class="meta-pill" style="${o.is_correct ? 'border-color:var(--success);color:var(--success)' : ''}">${esc(o.body)}${o.is_correct ? ' ✓' : ''}</span>`).join('')}</div></div><div class="q-item-actions"><button class="btn btn-ghost btn-sm" data-action="repair">Repair</button></div>`
			li.querySelector(
				'[data-action="repair"]'
			).addEventListener('click', () => {
				// jump to events tab and open the event's question panel
				const ev = allEvents.find(
					(e) => e.event_id === q.event_id
				)
				if (ev) {
					document.querySelector(
						'[data-tab="events"]'
					)?.click()
					setTimeout(
						() => openEventEditForm(ev),
						150
					)
					setTimeout(() => {
						resetSubTabs('questions') // also focus question
						const qEl =
							document.querySelector(
								`[data-id="${q.id}"]`
							)
						qEl?.scrollIntoView({
							behavior: 'smooth',
							block: 'center',
						})
					}, 400)
				} else {
					showToast(
						'Event not loaded — refresh events first',
						'error'
					)
				}
			})
			elHardList.appendChild(li)
		})
	} catch (err) {
		elHardLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}
async function loadStaleEvents() {
	if (!elStaleList) return
	elStaleLoading?.classList.remove('hidden')
	elStaleEmpty?.classList.add('hidden')
	elStaleList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/analytics/events/stale?days=30`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		elStaleLoading?.classList.add('hidden')
		if (!data.length) {
			elStaleEmpty?.classList.remove('hidden')
			return
		}
		data.forEach((ev) => {
			const li = document.createElement('li')
			li.className = 'event-card'
			li.innerHTML = `<div class="event-card-body"><div class="event-card-title">${esc(ev.title)}</div><div class="event-card-desc">${ev.ends_at ? `Ended ${formatDT(ev.ends_at)} · ${ev.days_since_end} days ago` : `Created ${formatDT(ev.created_at)} · ${ev.days_since_end} days ago`} · <span class="meta-pill ${ev.curation_status === 'PUBLISHED' ? 'active' : ''}">${esc(ev.curation_status)}</span></div></div><div class="event-card-actions"><button class="btn btn-ghost btn-sm" data-action="retire">Retire</button><button class="btn btn-ghost btn-sm" data-action="edit">Edit</button></div>`
			li.querySelector(
				'[data-action="retire"]'
			).addEventListener('click', async () => {
				const r = await fetch(
					`${EVENTS_API}/${ev.event_id}/retire`,
					{
						method: 'POST',
						credentials: 'include',
					}
				)
				const d = await r.json()
				if (!r.ok) return showToast(d.error, 'error')
				showToast('Event retired', 'success')
				loadStaleEvents()
				loadEvents()
			})
			li.querySelector(
				'[data-action="edit"]'
			).addEventListener('click', () => {
				const full =
					allEvents.find(
						(e) =>
							e.event_id ===
							ev.event_id
					) || ev
				document.querySelector(
					'[data-tab="events"]'
				)?.click()
				setTimeout(() => openEventEditForm(full), 150)
			})
			elStaleList.appendChild(li)
		})
	} catch (err) {
		elStaleLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}

// ============================================================
// Moderation queue (User Story 5) — graduated response
// ============================================================
let modQueue = []
let pendingModUser = null
let pendingModAction = null

function trustClass(score) {
	if (score < 30) return 'critical'
	if (score < 50) return 'warn'
	return 'low'
}
function tierLabel(tier) {
	if (!tier) return '—'
	return tier.charAt(0) + tier.slice(1).toLowerCase()
}
function initialsForMod(name) {
	if (!name || !name.trim()) return '?'
	const parts = name.trim().split(/\s+/)
	return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

async function loadModerationQueue() {
	if (!modList) return
	modLoading?.classList.remove('hidden')
	modEmpty?.classList.add('hidden')
	modError?.classList.add('hidden')
	modList.innerHTML = ''
	if (modCount) modCount.textContent = 'Loading…'
	try {
		const res = await fetch(`${API_BASE}/api/moderation/flagged`, {
			credentials: 'include',
		})
		if (!res.ok) {
			if (res.status === 401)
				throw new Error('Not authenticated')
			if (res.status === 403)
				throw new Error('Moderator role required')
			throw new Error(`Server ${res.status}`)
		}
		const data = await res.json()
		modQueue = data
		modLoading?.classList.add('hidden')
		if (!data.length) {
			modEmpty?.classList.remove('hidden')
			if (modCount) modCount.textContent = '0 flagged players'
			return
		}
		if (modCount)
			modCount.textContent = `${data.length} flagged player${data.length !== 1 ? 's' : ''} — sorted by lowest trust first`
		data.forEach((p) => modList.appendChild(buildModCard(p)))
	} catch (err) {
		modLoading?.classList.add('hidden')
		if (modError) {
			modError.textContent = `Could not load queue — ${err.message}`
			modError.classList.remove('hidden')
		}
		showToast(err.message, 'error')
	}
}

function buildModCard(p) {
	const li = document.createElement('li')
	li.className = 'mod-card'
	li.dataset.userId = p.user_id
	const tc = trustClass(p.trust_score)
	const reco = p.recommended_action
	const recoBadge = reco
		? `<span class="meta-pill" style="border-color:var(--accent);color:var(--accent);background:var(--accent-glow)">Recommended: ${esc(tierLabel(reco))}</span>`
		: ''
	const statusPill =
		p.moderation_status && p.moderation_status !== 'NONE'
			? `<span class="meta-pill ${p.moderation_status === 'SUSPENDED' ? 'inactive' : p.moderation_status === 'RESTRICTED' ? 'gold' : ''}">${esc(p.moderation_status)}${p.moderation_expires_at ? ` until ${esc(formatDT(p.moderation_expires_at))}` : ''}</span>`
			: '<span class="meta-pill">No active sanction</span>'
	const historyPill =
		p.prior_count > 0
			? `<span class="mod-history">History: ${p.prior_count} prior<span class="mod-history-badge">${p.prior_actions.map((a) => esc(a.action_type)).join(' → ')}</span></span>`
			: '<span class="mod-history">No prior actions</span>'

	const evidenceHtml = (p.evidence || []).length
		? p.evidence
				.map((ev) => {
					const type = esc(
						ev.type || ev.status || 'FLAG'
					)
					const detail = esc(
						ev.detail ||
							ev.reason ||
							ev.status ||
							JSON.stringify(
								ev
							).slice(0, 120)
					)
					const meta = []
					if (ev.distance_meters != null)
						meta.push(
							`${Math.round(ev.distance_meters)}m`
						)
					if (ev.travel_speed_ms != null)
						meta.push(
							`${ev.travel_speed_ms} m/s`
						)
					if (ev.event_id != null)
						meta.push(
							`event #${ev.event_id}`
						)
					if (ev.checked_at)
						meta.push(
							esc(
								formatDT(
									ev.checked_at
								) ||
									ev.checked_at
							)
						)
					const metaStr = meta.length
						? ` · ${esc(meta.join(' · '))}`
						: ''
					return `<div class="mod-evidence-item"><span class="mod-evidence-type">${type}</span><span>${detail}</span><span style="color:var(--text-muted);font-size:0.75rem">${metaStr}</span></div>`
				})
				.join('')
		: '<div class="mod-evidence-item"><span class="mod-evidence-type">NO EVIDENCE</span><span>No structured evidence — trust score only.</span></div>'

	const avatar = p.avatar_url
		? `<img src="${esc(p.avatar_url)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'" />`
		: `<div class="mod-avatar">${esc(initialsForMod(p.name))}</div>`

	li.innerHTML = `
		<div class="mod-card-top">
			<div class="mod-user">
				${avatar}
				<div>
					<div style="font-weight:700;color:var(--text)">${esc(p.name || 'Unknown')} <span style="font-weight:400;color:var(--text-muted);font-size:0.85rem">${esc(p.email || '')}</span></div>
					<div style="font-size:0.78rem;color:var(--text-muted)">ID ${p.user_id} · ${p.points ?? 0} pts · ${statusPill} ${recoBadge}</div>
					<div style="margin-top:0.25rem;font-size:0.78rem;color:var(--text-muted)">${esc(p.reason || 'Flagged for review')} · Updated ${esc(formatDT(p.updated_at) || p.updated_at || '—')}</div>
				</div>
			</div>
			<div style="text-align:right;display:grid;gap:0.35rem;justify-items:end">
				<div class="mod-trust ${tc}" title="Trust score (0-100, lower = more suspicious)">Trust ${Number(p.trust_score).toFixed(1)} / 100</div>
				<div class="mod-rec">${reco ? `System suggests: ${esc(tierLabel(reco))}` : 'No action suggested (trust ≥70)'}</div>
				${historyPill}
			</div>
		</div>
		<div class="mod-evidence">${evidenceHtml}</div>
		<div class="mod-actions">
			<button class="btn btn-ghost btn-sm" data-mod-action="WARNING" style="${reco === 'WARNING' ? 'border-color:var(--accent);color:var(--accent);background:var(--accent-glow)' : ''}">⚠️ Warning</button>
			<button class="btn btn-ghost btn-sm" data-mod-action="RESTRICTION" style="${reco === 'RESTRICTION' ? 'border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,0.1)' : ''}">⛔ Restrict 3d</button>
			<button class="btn btn-sm" data-mod-action="SUSPENSION" style="color:var(--danger);border-color:#5a2a2a;background:var(--danger-dim);${reco === 'SUSPENSION' ? 'box-shadow:0 0 0 2px rgba(239,68,68,0.25)' : ''}">🔒 Suspend 7d</button>
			<button class="btn btn-ghost btn-sm" data-mod-action="HISTORY">History</button>
		</div>
	`

	li.querySelectorAll('[data-mod-action]').forEach((btn) => {
		const action = btn.dataset.modAction
		if (action === 'HISTORY') {
			btn.addEventListener('click', async () => {
				try {
					const res = await fetch(
						`${API_BASE}/api/moderation/history/${p.user_id}`,
						{ credentials: 'include' }
					)
					const hist = await res.json()
					if (!hist.length)
						return showToast(
							'No history for this player',
							'success'
						)
					const lines = hist
						.map(
							(h) =>
								`${h.action_type} on ${formatDT(h.created_at) || h.created_at}${h.reason ? ': ' + h.reason : ''}${h.expires_at ? ' (until ' + formatDT(h.expires_at) + ')' : ''}`
						)
						.join('\n')
					showToast(
						`History for ${p.name}: ${lines.slice(0, 300)}`,
						'success'
					)
				} catch (e) {
					showToast(e.message, 'error')
				}
			})
			return
		}
		btn.addEventListener('click', () => openModModal(p, action))
	})

	return li
}

function openModModal(player, actionType) {
	pendingModUser = player
	pendingModAction = actionType
	const tierName = tierLabel(actionType)
	modModalTitle.textContent = `${tierName} — ${player.name || player.email}`
	modModalBody.textContent = `Apply a ${tierName.toLowerCase()} to ${player.name || player.email} (trust ${Number(player.trust_score).toFixed(1)}). Evidence: ${player.reason || ' flagged'}. This is tier ${['WARNING', 'RESTRICTION', 'SUSPENSION'].indexOf(actionType) + 1}/3 — graduated so bans are not instant.`
	if (modRecommended) {
		if (
			player.recommended_action &&
			player.recommended_action !== actionType
		) {
			modRecommended.textContent = `System recommends ${tierLabel(player.recommended_action)} for this trust score + history — you chose ${tierName}. Proceed?`
		} else if (player.recommended_action === actionType) {
			modRecommended.textContent = `✓ Matches system recommendation (${tierName}).`
		} else {
			modRecommended.textContent = ''
		}
	}
	if (modReason) modReason.value = ''
	if (modDurationField) {
		if (actionType === 'WARNING') {
			modDurationField.classList.add('hidden')
			if (modDuration) modDuration.value = ''
		} else {
			modDurationField.classList.remove('hidden')
			if (modDuration)
				modDuration.value =
					actionType === 'SUSPENSION' ? '7' : '3'
		}
	}
	modModalOverlay?.classList.remove('hidden')
}

function closeModModal() {
	pendingModUser = null
	pendingModAction = null
	modModalOverlay?.classList.add('hidden')
	if (modReason) modReason.value = ''
}

async function doModAction() {
	if (!pendingModUser || !pendingModAction) return
	const userId = pendingModUser.user_id
	const actionType = pendingModAction
	const reason = modReason?.value.trim() || null
	let duration = null
	if (actionType !== 'WARNING' && modDuration?.value.trim()) {
		duration = parseInt(modDuration.value.trim(), 10)
		if (!Number.isInteger(duration) || duration < 1) {
			showToast(
				'Duration must be a positive integer',
				'error'
			)
			return
		}
	}
	const btn = modModalConfirm
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Applying…'
	}
	try {
		const res = await fetch(`${API_BASE}/api/moderation/action`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				target_user_id: userId,
				action_type: actionType,
				reason,
				duration_days: duration,
				evidence: pendingModUser.evidence || null,
			}),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(data.error || `Server ${res.status}`)
		showToast(data.message || `${actionType} applied`, 'success')
		if (data.graduated_hint)
			showToast(data.graduated_hint, 'success')
		closeModModal()
		loadModerationQueue()
		loadModerationActions()
	} catch (err) {
		showToast(err.message, 'error')
	} finally {
		if (btn) {
			btn.disabled = false
			btn.textContent = 'Confirm'
		}
	}
}

async function loadModerationActions() {
	if (!modActionsList) return
	modActionsLoading?.classList.remove('hidden')
	modActionsEmpty?.classList.add('hidden')
	modActionsList.innerHTML = ''
	try {
		const res = await fetch(
			`${API_BASE}/api/moderation/actions?limit=20`,
			{ credentials: 'include' }
		)
		if (!res.ok) throw new Error(`Server ${res.status}`)
		const data = await res.json()
		modActionsLoading?.classList.add('hidden')
		if (!data.length) {
			modActionsEmpty?.classList.remove('hidden')
			return
		}
		data.forEach((a) => {
			const li = document.createElement('li')
			li.className = 'event-card'
			const tierColor =
				a.action_type === 'SUSPENSION'
					? 'color:var(--danger)'
					: a.action_type === 'RESTRICTION'
						? 'color:#f59e0b'
						: 'color:var(--accent)'
			li.innerHTML = `<div class="event-card-body"><div class="event-card-title"><span style="${tierColor};font-weight:700">${esc(a.action_type)}</span> → ${esc(a.target_name || a.target_email || 'user #' + a.target_user_id)} <span style="font-weight:400;color:var(--text-muted);font-size:0.85rem">by ${esc(a.moderator_name || 'mod #' + a.moderator_id)}</span></div><div class="event-card-desc">${esc(a.reason || 'No reason given')} · ${esc(formatDT(a.created_at) || a.created_at)}${a.expires_at ? ` · until ${esc(formatDT(a.expires_at))}` : ''}</div></div>`
			modActionsList.appendChild(li)
		})
	} catch (err) {
		modActionsLoading?.classList.add('hidden')
		showToast(err.message, 'error')
	}
}

btnModRefresh?.addEventListener('click', () => {
	loadModerationQueue()
	loadModerationActions()
})
modModalCancel?.addEventListener('click', closeModModal)
modModalOverlay?.addEventListener('click', (e) => {
	if (e.target === modModalOverlay) closeModModal()
})
modModalConfirm?.addEventListener('click', doModAction)

// ============================================================
// Player feedback inbox (Help & feedback reports)
// ============================================================
const fbList = document.getElementById('fb-list')
const fbCount = document.getElementById('fb-count')
const fbLoading = document.getElementById('fb-loading')
const fbEmpty = document.getElementById('fb-empty')
const fbError = document.getElementById('fb-error')
const fbSearch = document.getElementById('fb-search')
const btnFbRefresh = document.getElementById('btn-fb-refresh')

let feedbackReports = []
let fbView = 'NEW'

const FB_STATUS_LABEL = {
	NEW: 'New',
	ACKNOWLEDGED: 'Acknowledged',
	RESOLVED: 'Resolved',
}

function setFeedbackView(view) {
	fbView = view
	document.querySelectorAll('#fb-sub-tabs .mini-tab-btn').forEach((b) =>
		b.classList.toggle('mini-tab-active', b.dataset.fbView === view)
	)
}

function filterFeedback() {
	if (!fbList) return
	const q = (fbSearch?.value || '').trim().toLowerCase()
	let visible = 0
	;[...fbList.children].forEach((li) => {
		const hit =
			!q || (li.textContent || '').toLowerCase().includes(q)
		li.classList.toggle('hidden', !hit)
		if (hit) visible += 1
	})
	if (fbCount && q) {
		fbCount.textContent = `${visible} of ${feedbackReports.length} reports match “${fbSearch.value.trim()}”`
	} else if (fbCount && feedbackReports.length) {
		fbCount.textContent =
			`${feedbackReports.length} ${FB_STATUS_LABEL[fbView]?.toLowerCase() || ''} report${feedbackReports.length !== 1 ? 's' : ''}`.trim()
	}
}

async function loadFeedback() {
	if (!fbList) return
	fbLoading?.classList.remove('hidden')
	fbEmpty?.classList.add('hidden')
	fbError?.classList.add('hidden')
	fbList.innerHTML = ''
	if (fbCount) fbCount.textContent = 'Loading…'
	try {
		const url =
			fbView === 'ALL'
				? `${API_BASE}/api/feedback`
				: `${API_BASE}/api/feedback?status=${fbView}`
		const res = await fetch(url, { credentials: 'include' })
		if (!res.ok) {
			if (res.status === 401)
				throw new Error('Not authenticated')
			if (res.status === 403)
				throw new Error('Admin role required')
			throw new Error(`Server ${res.status}`)
		}
		feedbackReports = await res.json()
		fbLoading?.classList.add('hidden')
		if (!feedbackReports.length) {
			fbEmpty?.classList.remove('hidden')
			if (fbCount)
				fbCount.textContent =
					`0 ${FB_STATUS_LABEL[fbView]?.toLowerCase() || ''} reports`.trim()
			return
		}
		if (fbCount)
			fbCount.textContent =
				`${feedbackReports.length} ${FB_STATUS_LABEL[fbView]?.toLowerCase() || ''} report${feedbackReports.length !== 1 ? 's' : ''}`.trim()
		feedbackReports.forEach((r) =>
			fbList.appendChild(buildFeedbackCard(r))
		)
		filterFeedback()
	} catch (err) {
		fbLoading?.classList.add('hidden')
		if (fbError) {
			fbError.textContent = `Could not load feedback — ${err.message}`
			fbError.classList.remove('hidden')
		}
		showToast(err.message, 'error')
	}
}

function buildFeedbackCard(r) {
	const li = document.createElement('li')
	li.className = 'mod-card'
	li.dataset.reportId = r.report_id
	const catColor =
		r.category === 'BUG'
			? 'color:#ef4444'
			: r.category === 'LOCATION'
				? 'color:#f59e0b'
				: 'color:var(--accent)'
	const statusPill =
		r.status === 'RESOLVED'
			? '<span class="meta-pill">Resolved</span>'
			: r.status === 'ACKNOWLEDGED'
				? '<span class="meta-pill gold">Acknowledged</span>'
				: '<span class="meta-pill" style="border-color:var(--accent);color:var(--accent);background:var(--accent-glow)">New</span>'
	li.innerHTML = `<div class="mod-card-top"><div class="mod-user"><span class="mod-avatar">${esc((r.name || r.email || '?').trim().charAt(0).toUpperCase())}</span><div><div style="font-weight:700">${esc(r.title)}</div><div class="mod-history">${esc(r.name || r.email || 'unknown player')} · <span style="${catColor};font-weight:700">${esc(r.category)}</span> · ${esc(formatDT(r.created_at) || r.created_at)}</div></div></div><div>${statusPill}</div></div><div class="mod-evidence"><div class="mod-evidence-item"><span>${esc(r.body)}</span></div>${r.admin_note ? `<div class="mod-evidence-item"><span class="mod-evidence-type">Note</span><span>${esc(r.admin_note)}</span></div>` : ''}</div><div class="mod-actions"></div>`
	const actions = li.querySelector('.mod-actions')
	if (r.status === 'NEW') {
		const ack = document.createElement('button')
		ack.type = 'button'
		ack.className = 'btn btn-ghost btn-sm'
		ack.textContent = 'Acknowledge'
		ack.addEventListener('click', () =>
			triageFeedback(r.report_id, 'ACKNOWLEDGED', ack)
		)
		actions.appendChild(ack)
	}
	if (r.status !== 'RESOLVED') {
		const resolve = document.createElement('button')
		resolve.type = 'button'
		resolve.className = 'btn btn-primary btn-sm'
		resolve.textContent = 'Resolve'
		resolve.addEventListener('click', () =>
			triageFeedback(r.report_id, 'RESOLVED', resolve)
		)
		actions.appendChild(resolve)
	}
	return li
}

async function triageFeedback(reportId, status, btn) {
	const original = btn?.textContent
	try {
		if (btn) {
			btn.disabled = true
			btn.textContent = 'Saving…'
		}
		const res = await fetch(
			`${API_BASE}/api/feedback/${reportId}`,
			{
				method: 'PATCH',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status }),
			}
		)
		const data = await res.json().catch(() => ({}))
		if (!res.ok)
			throw new Error(data.error || `Server ${res.status}`)
		showToast(`Report marked ${status.toLowerCase()}.`, 'success')
		loadFeedback()
		updateFeedbackTabCount()
	} catch (err) {
		showToast(err.message, 'error')
		if (btn) {
			btn.disabled = false
			btn.textContent = original
		}
	}
}

document.querySelectorAll('#fb-sub-tabs .mini-tab-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		setFeedbackView(btn.dataset.fbView)
		loadFeedback()
	})
})
fbSearch?.addEventListener('input', filterFeedback)
btnFbRefresh?.addEventListener('click', loadFeedback)

// ============================================================
// Feedback tab unread count (NEW reports). Plain text count on the
// tab — no icons, matching the console's text-only style.
// ============================================================
const feedbackTabCount = document.getElementById('feedback-tab-count')

async function updateFeedbackTabCount() {
	if (!feedbackTabCount) return
	try {
		const res = await fetch(`${API_BASE}/api/feedback?status=NEW`, {
			credentials: 'include',
		})
		if (!res.ok) return
		const reports = await res.json()
		if (!reports.length) {
			feedbackTabCount.classList.add('hidden')
		} else {
			feedbackTabCount.textContent =
				reports.length > 99
					? '99+'
					: String(reports.length)
			feedbackTabCount.classList.remove('hidden')
		}
	} catch {
		// Count just stays hidden when offline.
	}
}
