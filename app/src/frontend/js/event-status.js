/**
 * Shared event status + popup/sidebar markup for the map pages
 * (index.html via main.js, pages/events.html via events.js), so both show
 * the same badges and the same "can I attempt this?" rule.
 *
 * Positions are [lng, lat] (MapLibre order), like playerCoords/playerLatLng.
 */
import { distance } from './general.js'
import { esc } from './utils.js'

export const DEFAULT_RADIUS_M = 60

export function eventRadius(ev) {
	return Number(ev.radius_meters) || DEFAULT_RADIUS_M
}

/** 'ACTIVE' | 'UPCOMING' | 'EXPIRED' from is_active + the time window. */
export function eventTimeStatus(ev, now = Date.now()) {
	const inactive =
		ev.is_active === false ||
		ev.is_active === 0 ||
		ev.is_active === '0'
	if (inactive) return 'EXPIRED'
	if (ev.ends_at && new Date(ev.ends_at).getTime() < now) return 'EXPIRED'
	if (ev.starts_at && new Date(ev.starts_at).getTime() > now)
		return 'UPCOMING'
	return 'ACTIVE'
}

/** Metres from the player to the event, or null with no player fix. */
export function eventDistanceMeters(ev, playerLngLat) {
	if (!playerLngLat) return null
	const lat = parseFloat(ev.latitude)
	const lng = parseFloat(ev.longitude)
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
	return distance(
		{ latitude: playerLngLat[1], longitude: playerLngLat[0] },
		{ latitude: lat, longitude: lng }
	)
}

/**
 * Everything the badges and the action need. canAttempt = the event is
 * live AND the player is inside its radius — the same checks the server
 * makes in /api/trivia/event (it re-verifies; this only drives the UI).
 */
export function eventState(ev, playerLngLat, now = Date.now()) {
	const status = eventTimeStatus(ev, now)
	const distanceM = eventDistanceMeters(ev, playerLngLat)
	const radius = eventRadius(ev)
	const inRange = distanceM !== null && distanceM <= radius
	return {
		status,
		distanceM,
		radius,
		inRange,
		canAttempt: status === 'ACTIVE' && inRange,
	}
}

const STATUS_PILL = {
	ACTIVE: '<span class="meta-pill active">Active</span>',
	UPCOMING: '<span class="meta-pill">Upcoming</span>',
	EXPIRED: '<span class="meta-pill inactive">Expired</span>',
}

export function statusPillHTML(status) {
	return STATUS_PILL[status] ?? STATUS_PILL.ACTIVE
}

export function rangePillHTML(inRange) {
	return inRange
		? '<span class="meta-pill active">✓ In range</span>'
		: '<span class="meta-pill">Out of range</span>'
}

export function formatDistance(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`
}

/** "📍 120m / 50m" with a fix, "📍 50m radius" without. */
export function distancePillHTML({ distanceM, radius }) {
	return distanceM === null
		? `<span class="meta-pill">📍 ${radius}m radius</span>`
		: `<span class="meta-pill">📍 ${formatDistance(distanceM)} / ${radius}m</span>`
}

export function pointsPillHTML(ev) {
	return `<span class="meta-pill gold">⚡ ${Number(ev.point_reward) || 0} pts</span>`
}

/** Status, range, distance/radius and points (rangeFirst: sidebar cards
 * lead with the range badge). */
export function metaPillsHTML(ev, state, { rangeFirst = false } = {}) {
	const pills = [
		statusPillHTML(state.status),
		rangePillHTML(state.inRange),
		distancePillHTML(state),
		pointsPillHTML(ev),
	]
	if (rangeFirst) [pills[0], pills[1]] = [pills[1], pills[0]]
	return pills.join('')
}

/**
 * The popup's call to action. The button only exists when canAttempt;
 * otherwise a short reason. onAttempt names a global function taking the
 * event id (each page has its own challenge flow).
 */
export function eventActionHTML(ev, state, { onCampus, onAttempt }) {
	if (state.status === 'EXPIRED')
		return `<p class="popup-out-of-range">This event has ended.</p>`
	if (state.status === 'UPCOMING')
		return `<p class="popup-out-of-range">This event hasn't started yet.</p>`
	if (state.canAttempt)
		// `this` is the tapped button itself, so the challenge flow
		// disables the right button even with several popups in the DOM.
		return `<button class="popup-challenge-btn" onclick="${onAttempt}(${Number(ev.event_id)},this)">⚡ Attempt Challenge</button>`
	if (!onCampus)
		return `<p class="popup-out-of-range">🏛️ You need to be on Wits campus to attempt this challenge.</p>`
	const away =
		state.distanceM === null
			? ''
			: ` You're ${formatDistance(state.distanceM)} away (need ${state.radius}m).`
	return `<p class="popup-out-of-range">Walk closer to attempt this challenge.${away}</p>`
}

export function eventPopupHTML(ev, state, opts) {
	return `
		<div class="popup-title">${esc(ev.title)}</div>
		<div class="popup-desc">${esc(ev.description || 'No description.')}</div>
		<div class="popup-meta">${metaPillsHTML(ev, state)}</div>
		${eventActionHTML(ev, state, opts)}
		<button class="popup-speak-btn" data-event-id="${Number(ev.event_id)}" aria-label="Read event aloud" title="Read aloud">
			🔊 Speak
		</button>
	`
}

// ── Authoring console (Manage Events) ─────────────────────────

/**
 * A procedural pop-up the rotation job has already retired (or an author
 * archived). They pile up every rotation, so the Manage Events list hides
 * them by default; the rows stay in the DB for history/analytics.
 */
export function isPastPopup(ev) {
	const procedural =
		ev.is_procedural === true || Number(ev.is_procedural) === 1
	const status = String(ev.curation_status || '').toUpperCase()
	return procedural && (status === 'RETIRED' || status === 'ARCHIVED')
}

/** Events to list in Manage Events, plus how many past pop-ups are hidden. */
export function consoleVisibleEvents(events, { showPastPopups = false } = {}) {
	const pastCount = events.filter(isPastPopup).length
	return {
		visible: showPastPopups
			? events
			: events.filter((ev) => !isPastPopup(ev)),
		pastCount,
	}
}
