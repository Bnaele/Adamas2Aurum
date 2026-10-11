import {
	usernameSignIn,
	usernameSignUp,
	googleSignIn,
	clearBridgeSession,
	requestPinReset,
	confirmPinReset,
} from './auth-client.js'
import { API_BASE } from './constants.js'
import { get_player_location } from './geolocation.js'
import { get_player_location_with_timeout } from './geolocation.js'
import { suggestEventOrder } from './graph.js'
import { redirectAfterLogin, updateAuthNav, logout } from './auth-helpers.js'
import { initFeedback } from './feedback.js'
import { initTermsGate, ensureTermsAccepted } from './terms.js'
import { eventState, eventPopupHTML, metaPillsHTML } from './event-status.js'
import {
	createCampusStyle,
	CAMPUS_CAMERA,
	CAMPUS_HOME,
	CAMPUS_MIN_ZOOM,
	CAMPUS_MAX_ZOOM,
	CAMPUS_MIN_PITCH,
	CAMPUS_MAX_PITCH,
	isInsideCampus,
	addGroundTexture,
	startDayNightCycle,
} from './campus-style.js'

let currentUser = null
let map = null
let playerMarker = null
let playerDotEl = null
let playerAccuracyEl = null

const originalGeolocationGetPos = navigator?.geolocation?.getCurrentPosition
let playerCoords = [...CAMPUS_HOME]
let playerAccuracyMeters = 0
let followMode = true
let demoMode = true // true until a real GPS fix arrives
let watchId = null
let lastInside = null // last geofence state: true/false/null (unknown)

// Avatar motion state: heading in degrees (0 = north), walk/idle visual,
// and a short trail of fading breadcrumb dots.
let playerHeading = 0
let lastMoveAt = 0
let walkTimer = null
let lastCrumbAt = null
const crumbs = []
const MAX_CRUMBS = 20

// Tracked stop markers for proximity glow + radius circles.
const stopMarkers = []
let pullbackTimer = null
const STEP_SIZE = 0.00008 // WASD step distance

// Dev-test simulated fixes (same coordinates as the v4 preview).
const SIM_ON_CAMPUS = [28.0345, -26.1875]
const SIM_OFF_CAMPUS = [28.0567, -26.1076] // e.g. Sandton — well outside

// ── Trivia result rendering helpers ───────────────────────────
const RARITY_STYLE = {
	COMMON: { bg: '#e5e7eb', fg: '#1f2937', label: 'Common' },
	UNCOMMON: { bg: '#bbf7d0', fg: '#14532d', label: 'Uncommon' },
	RARE: { bg: '#bfdbfe', fg: '#1e3a8a', label: 'Rare' },
	EPIC: { bg: '#e9d5ff', fg: '#581c87', label: 'Epic' },
	LEGENDARY: { bg: '#fde68a', fg: '#78350f', label: 'Legendary' },
}
function rarityBadge(rarity) {
	const s = RARITY_STYLE[rarity] || RARITY_STYLE.COMMON
	return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.5px;background:${s.bg};color:${s.fg};text-transform:uppercase;">${s.label}</span>`
}
function escapeHtml(str) {
	if (str == null) return ''
	return String(str).replace(
		/[&<>"']/g,
		(c) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			})[c]
	)
}

// Handle to the running trivia countdown, so a reuse of the modal for a
// new question clears any prior interval.
let activeTriviaTimer = null

/*
 * Completed events tracking
 */
const COMPLETED_EVENTS_KEY = 'wits-quest:completed-events'

function loadCompletedEventIds() {
	try {
		const raw = localStorage.getItem(COMPLETED_EVENTS_KEY)
		return new Set(raw ? JSON.parse(raw) : [])
	} catch {
		return new Set()
	}
}

const completedEventIds = loadCompletedEventIds()

function isEventCompleted(eventId) {
	return completedEventIds.has(String(eventId))
}

// Union of server truth (`completed` flag on GET /api/events for
// logged-in players) and local wins — same rule as the events page.
function isDoneEvent(dbEvent) {
	return dbEvent.completed === true || isEventCompleted(dbEvent.event_id)
}

function markEventCompleted(eventId) {
	completedEventIds.add(String(eventId))
	try {
		localStorage.setItem(
			COMPLETED_EVENTS_KEY,
			JSON.stringify([...completedEventIds])
		)
	} catch {
		// localStorage unavailable
	}
}

/*
 * Suggested route
 */
let suggestedOrder = []
let nextSuggestedEventId = null

function refreshNextSuggested() {
	const nextUp = suggestedOrder.find(
		(ev) => !isEventCompleted(ev.event_id)
	)
	nextSuggestedEventId = nextUp ? String(nextUp.event_id) : null
	applyNextSuggestedMarker()
}

function applyNextSuggestedMarker() {
	for (const stop of stopMarkers) {
		stop.pinEl.classList.toggle(
			'next-suggested',
			nextSuggestedEventId !== null &&
				String(stop.id) === nextSuggestedEventId
		)
	}
}

// Drop a finished stop immediately (no waiting for the 30s poll):
// remove its pin, re-halo the next one, rebuild the radius discs.
function removeStopPin(eventId) {
	const i = stopMarkers.findIndex((s) => String(s.id) === String(eventId))
	if (i < 0) return
	stopMarkers[i].marker.remove()
	stopMarkers.splice(i, 1)
	applyNextSuggestedMarker()
	renderProximityCircles(
		stopMarkers.map((s) => ({
			coordinates: [s.lng, s.lat],
			radius_meters: s.radius_meters,
		}))
	)
	refreshStopGlow()
}

let lastFlownNextSuggestedId = null

function flyToNextSuggested() {
	if (!map || nextSuggestedEventId === null) return
	if (nextSuggestedEventId === lastFlownNextSuggestedId) return

	const stop = suggestedOrder.find(
		(ev) => String(ev.event_id) === nextSuggestedEventId
	)
	if (!stop) return
	const lng = parseFloat(stop.longitude)
	const lat = parseFloat(stop.latitude)
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return

	lastFlownNextSuggestedId = nextSuggestedEventId
	followMode = false
	setStatusChip('demo', 'Showing next stop — 🎯 to follow GPS')
	map.flyTo({
		center: [lng, lat],
		zoom: Math.max(map.getZoom(), 17.5),
		pitch: 60,
		duration: 1200,
	})
}

/**
 * ACCURATE WITS BRAAMFONTEIN CAMPUS BUILDINGS
 */
async function fetchCampusEvents() {
	try {
		// credentials: logged-in players get a per-event `completed`
		// flag; anonymous players get the plain list as before.
		const res = await fetch(`${API_BASE}/api/events`, {
			cache: 'no-store',
			credentials: 'include',
		})
		if (!res.ok) return []
		const dbEvents = await res.json()
		// Completed stops disappear — ordering, pins, and circles all
		// run on the undone list only.
		const todoEvents = dbEvents.filter((e) => !isDoneEvent(e))
		// Don't let a hanging GPS fix delay the pins: give it 2.5 s,
		// then order from campus home. Live proximity still corrects
		// itself on the first real fix.
		let coords = null
		try {
			coords = await get_player_location_with_timeout(2500) // returns [latitude, longitude]
		} catch {
			coords = null
		}
		const loc = coords
			? { latitude: coords[0], longitude: coords[1] }
			: {
					latitude: CAMPUS_HOME[1],
					longitude: CAMPUS_HOME[0],
				}
		const { order } = suggestEventOrder(todoEvents, loc)
		suggestedOrder = order
		refreshNextSuggested()
		if (Array.isArray(todoEvents) && todoEvents.length > 0) {
			return todoEvents
				.map((event) => ({
					id: event.event_id,
					name: event.title,
					campus: event.campus || 'Wits Campus',
					category: event.category || 'General',
					description: event.description || '',
					coordinates: [
						parseFloat(event.longitude),
						parseFloat(event.latitude),
					],
					radius_meters: event.radius_meters,
					ev: event, // raw row: status/range/points badges
					hasChallenge:
						event.point_reward > 0 ||
						event.hasChallenge,
				}))
				.filter(
					(bld) =>
						Number.isFinite(
							bld.coordinates[0]
						) &&
						Number.isFinite(
							bld.coordinates[1]
						)
				)
		}
	} catch (err) {
		console.warn('Backend API offline, no events to show:', err)
	}

	// No hardcoded fallback stops: markers come only from events
	// created in the admin console (via the backend API above).
	return []
}

// Popup + sidebar badges come from js/event-status.js (shared with
// pages/events.html): live/expired, in/out of range, distance/radius,
// points — and Attempt Challenge only when live AND in range.
function eventPopupFor(ev) {
	return eventPopupHTML(ev, eventState(ev, playerCoords), {
		onCampus: isInsideCampus(playerCoords[0], playerCoords[1]),
		onAttempt: 'handleChallengeAttempt',
	})
}

// Only one event popup may be visible at a time: tapping a new pin
// closes any previously opened popup instead of stacking them.
function closeOtherPopups(exceptPopup = null) {
	for (const s of stopMarkers) {
		if (s.popup !== exceptPopup && s.popup.isOpen()) {
			s.popup.remove()
		}
	}
}

function renderEventSidebar(stops) {
	const list = document.getElementById('sidebar-events')
	if (!list) return
	list.innerHTML = ''
	if (!stops.length) {
		list.innerHTML =
			'<div class="sidebar-event sidebar-empty">No live events right now — check back soon.</div>'
		return
	}
	for (const stop of stops) {
		const card = document.createElement('div')
		card.className = 'sidebar-event'
		card.dataset.id = stop.id
		card.innerHTML = `
			<div class="sidebar-event-title">${escapeHtml(stop.ev.title)}</div>
			<div class="sidebar-event-meta"></div>
		`
		card.addEventListener('click', () => {
			followMode = false
			map.flyTo({
				center: [stop.lng, stop.lat],
				zoom: Math.max(map.getZoom(), 18),
				duration: 600,
			})
			closeOtherPopups(stop.popup)
			if (!stop.popup.isOpen()) stop.marker.togglePopup()
			refreshEventStates()
		})
		list.appendChild(card)
	}
	refreshEventStates()
}

// Re-evaluate every stop against the player's position and the clock:
// sidebar badges always, the open popup if there is one.
function refreshEventStates() {
	for (const stop of stopMarkers) {
		const meta = document.querySelector(
			`#sidebar-events .sidebar-event[data-id="${stop.id}"] .sidebar-event-meta`
		)
		if (meta)
			meta.innerHTML = metaPillsHTML(
				stop.ev,
				eventState(stop.ev, playerCoords),
				{ rangeFirst: true }
			)
		if (stop.popup.isOpen())
			stop.popup.setHTML(eventPopupFor(stop.ev))
	}
	document.querySelectorAll('#sidebar-events .sidebar-event').forEach(
		(card) =>
			card.classList.toggle(
				'active',
				stopMarkers.some(
					(s) =>
						String(s.id) ===
							card.dataset.id &&
						s.popup.isOpen()
				)
			)
	)
}

function createBuildingPinElement(building) {
	const el = document.createElement('div')
	el.className = `pokestop ${building.hasChallenge ? 'gym' : ''}`
	el.title = building.name
	// PokéStop structure: floating cube on a slim pole over a ground ring.
	// .pokestop-bob carries the JS proximity scale; inner parts animate
	// independently via CSS.
	el.innerHTML = `<div class="pokestop-bob"><div class="stop-cube"><span>${building.hasChallenge ? '⚡' : '◈'}</span></div><div class="stop-pole"></div><div class="stop-ring"></div></div>`
	return el
}

// Approx meters between two [lng, lat] pairs (equirectangular — plenty for
// sub-kilometer game distances).
function distanceMeters(a, b) {
	const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
	const dx = (a[0] - b[0]) * kx
	const dy = (a[1] - b[1]) * 110540
	return Math.hypot(dx, dy)
}

function bearingBetween(a, b) {
	const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
	const dx = (b[0] - a[0]) * kx
	const dy = (b[1] - a[1]) * 110540
	return (Math.atan2(dx, dy) * 180) / Math.PI
}

function setHeading(deg) {
	playerHeading = ((deg % 360) + 360) % 360
	const wedge = playerDotEl?.querySelector('.pogo-wedge')
	if (wedge) wedge.style.transform = `rotate(${playerHeading}deg)`
}

function setWalking(on) {
	const dot = playerDotEl?.querySelector('.pogo-dot')
	if (!dot) return
	dot.classList.toggle('walking', on)
	dot.classList.toggle('idle', !on)
	if (on) {
		lastMoveAt = Date.now()
		clearTimeout(walkTimer)
		walkTimer = setTimeout(() => setWalking(false), 2500)
	}
}

function dropCrumb(lng, lat) {
	if (lastCrumbAt && distanceMeters(lastCrumbAt, [lng, lat]) < 10) return
	lastCrumbAt = [lng, lat]
	const el = document.createElement('div')
	el.className = 'crumb'
	const marker = new maplibregl.Marker({ element: el })
		.setLngLat([lng, lat])
		.addTo(map)
	crumbs.push(marker)
	while (crumbs.length > MAX_CRUMBS) crumbs.shift().remove()
	setTimeout(() => {
		const i = crumbs.indexOf(marker)
		if (i >= 0) crumbs.splice(i, 1)
		marker.remove()
	}, 25000)
}

// Scale/glow each stop by live proximity (full glow inside ~40m, fading to
// baseline past ~250m). Applied to the INNER bob element — MapLibre owns
// the outer marker element's transform for positioning, so touching it
// would teleport the pin.
function refreshStopGlow() {
	for (const { el, lng, lat } of stopMarkers) {
		const d = distanceMeters(playerCoords, [lng, lat])
		const t = Math.max(0, Math.min(1, 1 - (d - 40) / 210))
		el.style.transform = `scale(${(1 + 0.4 * t).toFixed(3)})`
		el.style.setProperty('--pg', t.toFixed(3))
	}
}

// Translucent trigger-radius discs under each stop (event.radius_meters,
// 60m fallback) — transparency + gameplay in one visual.
function renderProximityCircles(stops) {
	if (!map) return
	const features = stops
		.filter((s) => Array.isArray(s.coordinates))
		.map((s) => ({
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [
					circleCoords(
						s.coordinates[0],
						s.coordinates[1],
						s.radius_meters || 60
					),
				],
			},
		}))
	if (map.getSource('event-radii')) {
		// Refresh data on repeat renders so edited/new events update.
		map.getSource('event-radii').setData({
			type: 'FeatureCollection',
			features,
		})
		return
	}
	if (!features.length) return
	map.addSource('event-radii', {
		type: 'geojson',
		data: { type: 'FeatureCollection', features },
	})
	map.addLayer({
		id: 'event-radii-fill',
		type: 'fill',
		source: 'event-radii',
		paint: {
			'fill-color': '#2F9DF0',
			'fill-opacity': 0.1,
		},
	})
	map.addLayer({
		id: 'event-radii-line',
		type: 'line',
		source: 'event-radii',
		paint: {
			'line-color': '#2F9DF0',
			'line-width': 1.5,
			'line-opacity': 0.35,
			'line-dasharray': [4, 3],
		},
	})
}

function circleCoords(lng, lat, radiusMeters, steps = 48) {
	const pts = []
	const kx = 111320 * Math.cos((lat * Math.PI) / 180)
	for (let i = 0; i <= steps; i++) {
		const a = (i / steps) * Math.PI * 2
		pts.push([
			lng + (Math.cos(a) * radiusMeters) / kx,
			lat + (Math.sin(a) * radiusMeters) / 110540,
		])
	}
	return pts
}

// ---- Off-campus ambient fact stops ("wild flavor", not quests) ----
// Sourced live from the already-loaded vector tiles (poi layer), so this
// works anywhere in the world with zero extra data pipeline. Only named
// POIs qualify — plain buildings get nothing, keeping density PoGO-sparse.
// Visuals stay deliberately lower-stakes: tiny static "i" dots, no pulse,
// no radius. Tapping shows tile facts only — no minigame, no card.
// (Tile fields are a subset of OSM tags, so deeper qualification like
// wikipedia/wikidata lookups is deferred; see report.)
const factMarkers = []
const MAX_FACT_STOPS = 12
const FACT_MIN_ZOOM = 15.5

function clearFactStops() {
	for (const m of factMarkers) m.remove()
	factMarkers.length = 0
}

function humanizeKind(v) {
	return String(v || '')
		.replace(/_/g, ' ')
		.trim()
}

function refreshFactStops() {
	if (!map) return
	// Quest markers rule on campus — ambient flavor is off-campus only.
	if (
		isInsideCampus(playerCoords[0], playerCoords[1]) ||
		map.getZoom() < FACT_MIN_ZOOM
	) {
		clearFactStops()
		return
	}
	let feats = []
	try {
		feats = map.querySourceFeatures('carto', {
			sourceLayer: 'poi',
			filter: ['has', 'name'],
		})
	} catch {
		return
	}
	const bounds = map.getBounds()
	const center = map.getCenter().toArray()
	const seen = new Set()
	const scored = []
	for (const f of feats) {
		const name = f.properties?.name
		const g = f.geometry
		if (!name || !g || g.type !== 'Point') continue
		const [lng, lat] = g.coordinates
		if (
			lng < bounds.getWest() ||
			lng > bounds.getEast() ||
			lat < bounds.getSouth() ||
			lat > bounds.getNorth()
		)
			continue
		const key = `${name}|${lng.toFixed(4)},${lat.toFixed(4)}`
		if (seen.has(key)) continue
		seen.add(key)
		scored.push({
			lng,
			lat,
			name,
			kind: f.properties.class,
			d: distanceMeters([lng, lat], center),
		})
	}
	scored.sort((a, b) => a.d - b.d)
	clearFactStops()
	for (const s of scored.slice(0, MAX_FACT_STOPS)) {
		const el = document.createElement('div')
		el.className = 'fact-dot'
		el.title = s.name
		el.textContent = 'i'
		const popup = new maplibregl.Popup({
			offset: 12,
		}).setHTML(
			`<div class="fact-card"><h3>${escapeHtml(s.name)}</h3>` +
				(s.kind
					? `<p class="fact-kind">${escapeHtml(humanizeKind(s.kind))}</p>`
					: '') +
				`<p class="fact-note">🚏 Off-campus flavor stop — explore, no challenge here.</p></div>`
		)
		factMarkers.push(
			new maplibregl.Marker({ element: el })
				.setLngLat([s.lng, s.lat])
				.setPopup(popup)
				.addTo(map)
		)
	}
}

// Compass fallback for facing: GPS bearing wins while moving; otherwise
// ease toward the device compass where the browser exposes one. (iOS
// requires a user-gesture permission prompt for motion data, so this stays
// best-effort — no permission flow is triggered here.)
function setupOrientation() {
	const handler = (e) => {
		if (Date.now() - lastMoveAt < 4000) return
		let heading = null
		if (typeof e.webkitCompassHeading === 'number') {
			heading = e.webkitCompassHeading
		} else if (
			typeof e.alpha === 'number' &&
			e.absolute !== false
		) {
			heading = 360 - e.alpha
		}
		if (heading !== null && Number.isFinite(heading)) {
			setHeading(heading)
		}
	}
	window.addEventListener('deviceorientationabsolute', handler, true)
	window.addEventListener('deviceorientation', handler, true)
}

// Soft camera pull-back toward campus after 25s idle far away. Only arms
// when free-looking (never while following GPS) and fires only if the
// camera is still outside the campus bbox when the timer lapses.
const PULLBACK_IDLE_MS = 25000

function clearPullback() {
	if (pullbackTimer) {
		clearTimeout(pullbackTimer)
		pullbackTimer = null
	}
}

function armPullback() {
	clearPullback()
	if (!map || followMode || document.hidden) return
	const c = map.getCenter()
	if (isInsideCampus(c.lng, c.lat)) return
	pullbackTimer = setTimeout(() => {
		pullbackTimer = null
		if (!map || followMode || document.hidden) return
		const now = map.getCenter()
		if (!isInsideCampus(now.lng, now.lat)) {
			map.easeTo({ ...CAMPUS_CAMERA, duration: 1200 })
		}
	}, PULLBACK_IDLE_MS)
}

/**
 * PLAYER DOT — Pokémon-GO blue dot + accuracy circle, with follow mode.
 */
function setStatusChip(mode, text) {
	const chip = document.getElementById('gps-status')
	if (!chip) return
	chip.dataset.mode = mode
	chip.querySelector('.gps-text').textContent = text
}

function metersPerPixel(lat, zoom) {
	return (
		(156543.03392 * Math.cos((lat * Math.PI) / 180)) /
		Math.pow(2, zoom)
	)
}

function updateAccuracyCircle() {
	if (!playerAccuracyEl || !map) return
	const px = playerAccuracyMeters
		? Math.min(
				220,
				Math.max(
					18,
					(playerAccuracyMeters /
						metersPerPixel(
							playerCoords[1],
							map.getZoom()
						)) *
						2
				)
			)
		: 44
	playerAccuracyEl.style.width = `${px}px`
	playerAccuracyEl.style.height = `${px}px`
}

function ensurePlayerMarker() {
	if (playerMarker) return
	const el = document.createElement('div')
	el.className = 'pogo-player'
	el.innerHTML = `<div class="pogo-accuracy"></div><div class="pogo-wedge"></div><div class="pogo-dot idle"></div>`
	playerDotEl = el
	playerAccuracyEl = el.querySelector('.pogo-accuracy')
	playerMarker = new maplibregl.Marker({ element: el })
		.setLngLat(playerCoords)
		.addTo(map)
	updateAccuracyCircle()
	setHeading(playerHeading)
}

function movePlayerTo([lng, lat], { center = false, accuracy = 0 } = {}) {
	const prev = [...playerCoords]
	playerCoords = [lng, lat]
	if (accuracy > 0) playerAccuracyMeters = accuracy
	ensurePlayerMarker()
	playerMarker.setLngLat(playerCoords)
	updateAccuracyCircle()
	const moved = distanceMeters(prev, playerCoords)
	if (moved > 2) {
		setHeading(bearingBetween(prev, playerCoords))
		setWalking(true)
		dropCrumb(lng, lat)
		refreshStopGlow()
		refreshEventStates()
	}
	if (center) {
		map.easeTo({ center: playerCoords, duration: 400 })
	}
}

function setupMovementControls() {
	window.addEventListener('keydown', (e) => {
		if (!playerCoords) return
		if (
			['INPUT', 'TEXTAREA'].includes(
				document.activeElement.tagName
			)
		)
			return

		let deltaLng = 0
		let deltaLat = 0

		switch (e.key.toLowerCase()) {
			case 'w':
			case 'arrowup':
				deltaLat = STEP_SIZE
				break
			case 's':
			case 'arrowdown':
				deltaLat = -STEP_SIZE
				break
			case 'a':
			case 'arrowleft':
				deltaLng = -STEP_SIZE
				break
			case 'd':
			case 'arrowright':
				deltaLng = STEP_SIZE
				break
			default:
				return
		}

		e.preventDefault()
		// Keyboard walk = manual explore anywhere in the world: pause GPS
		// follow until recenter. Challenges stay campus-gated on tap.
		followMode = false
		setStatusChip('demo', 'Manual explore — 🎯 to follow GPS')
		movePlayerTo(
			[
				playerCoords[0] + deltaLng,
				playerCoords[1] + deltaLat,
			],
			{ center: true }
		)
	})
}

/**
 * GEOLOCATION — continuous watch (not one-shot), so the dot is actually live.
 */
function setBannerVisible(visible) {
	const banner = document.getElementById('offcampus-banner')
	if (banner) banner.style.display = visible ? 'block' : 'none'
}

/**
 * GPS FIX HANDLER — the single funnel for every position update, real or
 * simulated. The avatar + camera follow the player anywhere in the world;
 * the banner just says whether challenges are currently playable. The
 * campus gate is enforced when a stop is tapped, never on movement.
 */
function handleGpsFix(lng, lat, { accuracy = 0, source = 'real GPS' } = {}) {
	const inside = isInsideCampus(lng, lat)
	demoMode = false
	setBannerVisible(!inside)
	movePlayerTo([lng, lat], {
		center: followMode,
		accuracy,
	})
	const acc = Math.round(accuracy)
	if (inside) {
		setStatusChip(
			'live',
			`On campus (${source})${acc ? ` · ±${acc}m` : ''}`
		)
	} else {
		setStatusChip(
			'away',
			`Off campus (${source}) — visit Wits to play`
		)
	}
	lastInside = inside
}

function enterDemoMode(reason) {
	demoMode = true
	lastInside = true
	setBannerVisible(false)
	movePlayerTo([...CAMPUS_HOME], { center: true })
	setStatusChip(
		'demo',
		reason ?? 'GPS unavailable — demo at Great Hall (WASD to walk)'
	)
}

function startWatch() {
	if (watchId !== null) {
		navigator.geolocation.clearWatch(watchId)
		watchId = null
	}
	watchId = navigator.geolocation.watchPosition(
		(pos) => {
			handleGpsFix(
				pos.coords.longitude,
				pos.coords.latitude,
				{
					accuracy: pos.coords.accuracy ?? 0,
					source: 'real GPS',
				}
			)
		},
		(err) => {
			if (!demoMode && playerMarker) {
				// Had a fix and lost it: keep last dot, say so.
				setStatusChip(
					'demo',
					'GPS signal lost — showing last fix'
				)
				return
			}
			enterDemoMode(
				err.code === 1
					? 'Location blocked — demo at Great Hall (WASD to walk)'
					: 'GPS unavailable — demo at Great Hall (WASD to walk)'
			)
		},
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
	)
}

function initUserPosition() {
	setStatusChip('locating', 'Locating…')
	if (!('geolocation' in navigator)) {
		enterDemoMode(
			'No geolocation — demo at Great Hall (WASD to walk)'
		)
		return
	}
	startWatch()
}

// Dev-test panel (v4): real GPS vs simulated fixes.
function setupGeoPanel() {
	document.getElementById('btn-real-gps')?.addEventListener(
		'click',
		() => {
			if (!('geolocation' in navigator)) {
				setStatusChip(
					'away',
					'Geolocation not available — try a simulated fix'
				)
				return
			}
			navigator.geolocation.getCurrentPosition =
				originalGeolocationGetPos
			followMode = true
			setStatusChip(
				'locating',
				'Requesting location permission…'
			)
			startWatch()
		}
	)
	document.getElementById('btn-sim-oncampus')?.addEventListener(
		'click',
		() => {
			if (watchId !== null && 'geolocation' in navigator) {
				navigator.geolocation.clearWatch(watchId)
				watchId = null
			}
			followMode = true
			handleGpsFix(SIM_ON_CAMPUS[0], SIM_ON_CAMPUS[1], {
				source: 'simulated',
			})
			navigator.geolocation.getCurrentPosition = (
				handle,
				handleError
			) => {
				handle({
					coords: {
						latitude: playerCoords[1],
						longitude: playerCoords[0],
					},
				})
			}
		}
	)
	document.getElementById('btn-sim-offcampus')?.addEventListener(
		'click',
		() => {
			if (watchId !== null && 'geolocation' in navigator) {
				navigator.geolocation.clearWatch(watchId)
				watchId = null
			}
			handleGpsFix(SIM_OFF_CAMPUS[0], SIM_OFF_CAMPUS[1], {
				source: 'simulated',
			})
			navigator.geolocation.getCurrentPosition = (
				handle,
				handleError
			) => {
				handle({
					coords: {
						latitude: playerCoords[1],
						longitude: playerCoords[0],
					},
				})
			}
		}
	)
}

/**
 * Google sign-in failures come back as ?auth_error=<message> on the page
 * the backend redirected to. Show the message once and clean the URL.
 */
function showAuthErrorFromUrl() {
	const params = new URLSearchParams(window.location.search)
	const message = params.get('auth_error')
	if (!message) return
	params.delete('auth_error')
	const qs = params.toString()
	history.replaceState(
		null,
		'',
		window.location.pathname +
			(qs ? `?${qs}` : '') +
			window.location.hash
	)
	alert(message)
}

/**
 * AUTHENTICATION SESSION CHECK
 */
/**
 * AUTH SESSION TRACKER
 * Asks the backend "is there a valid session for this browser?" via the
 * session cookie. Sets the module-level currentUser variable (used by
 * handleChallengeAttempt's auth gate) and updates the nav bar to show
 * either a login link or the logged-in user's name + logout button.
 */
async function checkAuthSession() {
	try {
		const res = await fetch(`${API_BASE}/api/me`, {
			method: 'GET',
			credentials: 'include',
		})

		if (res.ok) {
			const user = await res.json()
			currentUser = user
			updateAuthNav(user)
		} else {
			// 401 from the backend — no valid session.
			currentUser = null
			updateAuthNav(null)
		}
	} catch (err) {
		// Backend unreachable — treat the same as "not logged in" rather
		// than crashing the page.
		currentUser = null
		updateAuthNav(null)
	}

	const btnLogout = document.getElementById('btn-logout')
	if (btnLogout && !btnLogout.dataset.bound) {
		btnLogout.dataset.bound = 'true'
		btnLogout.addEventListener('click', handleLogout)
	}
}

async function handleLogout() {
	await logout()
}

/**
 * TRIVIA HANDLER — campus-gated on tap. Stops are visible and tappable
 * from anywhere in the world; attempting one requires being on campus.
 */
window.handleChallengeAttempt = async function (eventId) {
	if (!currentUser) {
		openAuthDrawer()
		return
	}

	if (!isInsideCampus(playerCoords[0], playerCoords[1])) {
		showGateModal()
		return
	}

	// Ask the browser for a fresh position fix for this attempt. If the
	// one-shot fix fails (flaky desktop GPS), fall back to the tracked
	// avatar position — the backend distance-checks honestly either way.
	let coords
	try {
		coords = await get_player_location() // returns [latitude, longitude]
	} catch (err) {
		coords = [playerCoords[1], playerCoords[0]]
	}
	const [lat, lng] = coords

	try {
		const res = await fetch(
			`${API_BASE}/api/trivia/event/${eventId}?lat=${lat}&lng=${lng}`,
			{
				credentials: 'include', // sends the session cookie so the backend's requireAuth check can identify who's asking
			}
		)
		if (res.status === 401) {
			// Session cookie expired or was invalidated server-side.
			openAuthDrawer()
			return
		}
		if (res.status === 403) {
			// Location check failed server-side — player is outside the
			// event's radius. Show them how far off they are.
			const data = await res.json()
			alert(
				`You're too far from this location to attempt the challenge. ` +
					`You're about ${data.distance_meters}m away (need to be within ${data.radius_meters}m).`
			)
			return
		}
		if (!res.ok)
			return alert(
				'No trivia challenges available for this location right now!'
			)

		const trivia = await res.json()
		showTriviaModal(eventId, trivia)
	} catch (err) {
		alert('Error connecting to challenge server.')
	}
}

function showGateModal() {
	let modal = document.getElementById('trivia-modal')
	if (!modal) {
		modal = document.createElement('div')
		modal.id = 'trivia-modal'
		modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000;`
		document.body.appendChild(modal)
	}

	modal.innerHTML = `
    <div style="background: #fff; padding: 24px; border-radius: 12px; max-width: 400px; width: 90%; text-align: center;">
      <div style="font-size: 2rem;">🏛️</div>
      <h3 style="margin: 8px 0;">On-campus challenge</h3>
      <p style="margin: 12px 0; color: #555;">You need to be on Wits campus to attempt this challenge. Come visit us to play!</p>
      <button style="margin-top: 4px; background: #2f9df0; color: #fff; border: none; border-radius: 6px; padding: 10px 24px; font-weight: bold; cursor: pointer;" onclick="document.getElementById('trivia-modal').remove()">Got it</button>
    </div>
  `
}

function showTriviaModal(eventId, trivia) {
	// Stop any countdown from a previous question if the modal is being
	// reused before its timer ran out.
	if (activeTriviaTimer) {
		clearInterval(activeTriviaTimer)
		activeTriviaTimer = null
	}

	const startedAt = Date.now()
	const timeLimitMs = (trivia.time_limit_s || 30) * 1000

	let modal = document.getElementById('trivia-modal')
	if (!modal) {
		// Reuse the same modal element across multiple challenge attempts
		// instead of creating a new one every time.
		modal = document.createElement('div')
		modal.id = 'trivia-modal'
		modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
      z-index: 10000;
    `
		document.body.appendChild(modal)
	}

	// Each button carries its option_id in a data attribute; an event
	// listener below wires it up so the click handler can compute the
	// real elapsed time (instead of a hardcoded value).
	// FILL_BLANK has no options (the server never sends its answer) — the
	// player types the answer instead and the server grades the text.
	const isFillBlank = trivia.format === 'FILL_BLANK'
	const optionsHtml = isFillBlank
		? `
    <form id="trivia-fill-form" style="display: flex; gap: 8px; margin: 8px 0;">
      <input id="trivia-fill-input" type="text" autocomplete="off" required
             placeholder="Type your answer" aria-label="Your answer"
             style="flex: 1; padding: 10px; border-radius: 4px; border: 1px solid #ccc;" />
      <button type="submit" class="trivia-option-btn"
              style="padding: 10px 16px; border-radius: 4px; border: 1px solid #ccc; cursor: pointer;">
        Submit
      </button>
    </form>
  `
		: trivia.options
				.map(
					(opt) => `
    <button data-opt-id="${opt.option_id}" class="trivia-option-btn"
            style="display: block; width: 100%; margin: 8px 0; padding: 10px; border-radius: 4px; border: 1px solid #ccc; cursor: pointer;">
      ${escapeHtml(opt.body)}
    </button>
  `
				)
				.join('')

	// If the player has ALREADY earned this event's card, show a clear
	// banner BEFORE they answer — replay is for practice, no new card.
	const elig = trivia.card_eligibility
	const earnedCardName = elig?.earned_card?.name
	const alreadyEarnedBanner = elig?.already_earned
		? `<div style="margin: 8px 0 12px; padding: 10px 12px; background: #fff8e1; border: 1px solid #ffd54f; border-left: 4px solid #ffb300; border-radius: 6px; color: #7a5c00; font-size: 0.85rem;">
         🎓 You've already earned ${earnedCardName ? `the <strong>${escapeHtml(earnedCardName)}</strong> ` : ''}card for this challenge — replay for practice? No new card will be awarded.
       </div>`
		: ''

	modal.innerHTML = `
    <div style="background: #fff; padding: 24px; border-radius: 8px; max-width: 400px; width: 90%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <h3 style="margin:0;">🎯 Campus Challenge</h3>
        <div id="trivia-timer-text" style="font-variant-numeric:tabular-nums;font-weight:600;font-size:0.85rem;color:#475569;"></div>
      </div>
      <div style="height:6px;border-radius:999px;background:#e5e7eb;margin-bottom:12px;overflow:hidden;">
        <div id="trivia-timer-bar" style="height:100%;background:#0c2461;border-radius:999px;transition:width 100ms linear,background-color 200ms;width:100%;"></div>
      </div>
      ${alreadyEarnedBanner}
      <p style="margin: 12px 0;"><strong>${escapeHtml(trivia.body)}</strong></p>
      <div id="trivia-options">${optionsHtml}</div>
      <div id="trivia-result" style="margin-top: 12px;"></div>
      <button id="trivia-close-btn" style="margin-top: 12px; background: none; border: none; color: #888; cursor: pointer; text-decoration: underline;">Close</button>
    </div>
  `

	// Wire option buttons via addEventListener — computes elapsed since
	// the question opened and disables the rest to prevent double-submit.
	let submitted = false
	const submit = async (optionId, timedOut, answerText = null) => {
		if (submitted) return
		submitted = true
		if (activeTriviaTimer) {
			clearInterval(activeTriviaTimer)
			activeTriviaTimer = null
		}
		const elapsed = Date.now() - startedAt
		modal.querySelectorAll('.trivia-option-btn').forEach(
			(b) => (b.disabled = true)
		)
		await window.submitTriviaAnswer(
			eventId,
			trivia.question_id,
			optionId,
			{
				timed_out: timedOut,
				elapsed_ms: elapsed,
				answer_text: answerText,
			}
		)
	}
	if (isFillBlank) {
		const fillInput = modal.querySelector('#trivia-fill-input')
		fillInput.focus()
		modal.querySelector('#trivia-fill-form').addEventListener(
			'submit',
			(e) => {
				e.preventDefault()
				const text = fillInput.value.trim()
				if (!text) return
				fillInput.disabled = true
				submit(null, false, text)
			}
		)
	} else {
		modal.querySelectorAll('.trivia-option-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				submit(Number(btn.dataset.optId), false)
			})
		})
	}
	modal.querySelector('#trivia-close-btn').addEventListener(
		'click',
		() => {
			if (activeTriviaTimer) {
				clearInterval(activeTriviaTimer)
				activeTriviaTimer = null
			}
			modal.remove()
		}
	)

	// Countdown bar — ticks every 100 ms, blue → amber (<10 s) → red
	// (<5 s), auto-submits as timed_out at zero.
	const barEl = modal.querySelector('#trivia-timer-bar')
	const textEl = modal.querySelector('#trivia-timer-text')
	const tick = () => {
		const elapsed = Date.now() - startedAt
		const remaining = Math.max(0, timeLimitMs - elapsed)
		const pct = (remaining / timeLimitMs) * 100
		barEl.style.width = pct + '%'
		textEl.textContent = Math.ceil(remaining / 1000) + 's'
		if (remaining < 5000) {
			barEl.style.background = '#dc2626'
			textEl.style.color = '#dc2626'
		} else if (remaining < 10000) {
			barEl.style.background = '#f59e0b'
			textEl.style.color = '#b45309'
		} else {
			barEl.style.background = '#0c2461'
			textEl.style.color = ''
		}
		if (remaining <= 0) {
			submit(null, true)
		}
	}
	tick()
	activeTriviaTimer = setInterval(tick, 100)
}

window.submitTriviaAnswer = async function (
	eventId,
	questionId,
	optionId,
	opts = {}
) {
	const {
		timed_out: timedOut = false,
		elapsed_ms: elapsedMs = 0,
		answer_text: answerText = null,
	} = opts
	const optionsContainer = document.getElementById('trivia-options')
	const resultContainer = document.getElementById('trivia-result')

	// Disable all answer buttons immediately so the player can't click a
	// second option while the first request is still in flight.
	if (optionsContainer) {
		optionsContainer
			.querySelectorAll('button')
			.forEach((btn) => (btn.disabled = true))
	}

	// Get a fresh location fix for this submission specifically — if the
	// player wandered off after opening the question, this catches it. If
	// the one-shot fix fails (flaky desktop GPS), fall back to the tracked
	// avatar position so the submit always carries coordinates — the
	// backend still distance-checks honestly, so this can't sneak in a
	// far-away answer.
	let lat = null
	let lng = null
	try {
		;[lat, lng] = await get_player_location()
	} catch (err) {
		lat = playerCoords[1]
		lng = playerCoords[0]
		if (resultContainer) {
			resultContainer.innerHTML = `<p style="color: #b45309;">Live GPS fix failed (${escapeHtml(err.message)}) — submitting with your last known position; distance will still be checked.</p>`
		}
	}

	const body = {
		event_id: eventId,
		question_id: questionId,
		answer_time_ms: elapsedMs,
		timed_out: !!timedOut,
	}
	if (!timedOut && answerText !== null) body.answer_text = answerText
	else if (!timedOut) body.selected_option_id = optionId
	if (lat !== null) body.claimed_lat = lat
	if (lng !== null) body.claimed_lng = lng

	try {
		const res = await fetch(`${API_BASE}/api/trivia/submit`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(body),
		})

		if (res.status === 401) {
			alert('Your session has expired. Please log in again.')
			openAuthDrawer()
			return
		}

		const data = await res.json()

		if (!res.ok) {
			if (resultContainer) {
				resultContainer.innerHTML = `<p style="color: #c0392b;">${escapeHtml(data.error) || 'Something went wrong submitting your answer.'}</p>`
			}
			return
		}

		// ── Result view ───────────────────────────────────────
		if (resultContainer) {
			if (optionsContainer)
				optionsContainer.style.display = 'none'

			let statusIcon, statusText, statusColor
			if (data.timed_out) {
				statusIcon = '⏰'
				statusText = "Time's up!"
				statusColor = '#b45309'
			} else if (data.location_verified === false) {
				statusIcon = '📍'
				statusText =
					'Too far away — attempt did not count.'
				statusColor = '#b45309'
			} else if (data.is_correct) {
				statusIcon = '✅'
				statusText = 'Correct!'
				statusColor = '#16a34a'
				markEventCompleted(eventId)
				refreshNextSuggested()
				flyToNextSuggested()
				removeStopPin(eventId)
			} else {
				statusIcon = '❌'
				statusText = 'Incorrect.'
				statusColor = '#dc2626'
			}

			const elapsedSec = (
				(data.answer_time_ms || 0) / 1000
			).toFixed(1)
			const limitSec = data.time_limit_s || 30

			const correctHtml = data.correct_option_text
				? `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:#ecfdf5;border:1px solid #bbf7d0;font-size:0.85rem;color:#065f46;"><strong>Correct answer:</strong> ${escapeHtml(data.correct_option_text)}</div>`
				: ''

			let cardBlock = ''
			if (data.card_awarded && data.awarded_card) {
				const c = data.awarded_card
				cardBlock = `
					<div style="margin-top:12px;padding:10px 12px;border-radius:6px;background:#f8fafc;border:1px solid #e2e8f0;">
						<div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin-bottom:4px;">Card awarded</div>
						<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
							<div style="font-weight:600;color:#0f172a;">${escapeHtml(c.name)}</div>
							${rarityBadge(c.rarity)}
						</div>
					</div>`
			} else if (data.already_earned_card) {
				cardBlock = `<div style="margin-top:8px;font-size:0.8rem;color:#9ca3af;">You've already earned this event's card.</div>`
			}

			const replayHtml =
				data.is_correct && data.already_completed
					? `<div style="margin-top:8px;font-size:0.8rem;color:#9ca3af;">🎓 Practice run — you've already completed this event, no new points.</div>`
					: ''

			resultContainer.innerHTML = `
				<div style="text-align:center;margin:8px 0 12px;">
					<div style="font-size:2rem;line-height:1;">${statusIcon}</div>
					<div style="font-weight:700;font-size:1rem;color:${statusColor};margin-top:4px;">${statusText}</div>
				</div>
				${correctHtml}
				<div style="margin-top:12px;border-top:1px solid #e5e7eb;padding-top:8px;">
					<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.85rem;color:#475569;">
						<span>Time taken</span>
						<span style="font-variant-numeric:tabular-nums;font-weight:600;color:#0f172a;">${elapsedSec}s <span style="color:#9ca3af;font-weight:400;">/ ${limitSec}s</span></span>
					</div>
					<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.85rem;color:#475569;">
						<span>Points earned</span>
						<span style="font-weight:600;color:${data.points_awarded > 0 ? '#16a34a' : '#9ca3af'};">${data.points_awarded > 0 ? '+' + data.points_awarded : '0'}</span>
					</div>
				</div>
				${cardBlock}
				${replayHtml}
			`
		}
	} catch (err) {
		if (resultContainer) {
			resultContainer.innerHTML = `<p style="color: #c0392b;">Failed to submit answer. Ensure you are signed in.</p>`
		}
	}
}

/**
 * INITIALIZE WITS MAP ENGINE — world gamified map, live GPS dot, event
 * stops always visible, challenge attempts campus-gated on tap.
 */
async function initializeApp() {
	// Auth first (fire-and-forget): resolve the header before the map and
	// GPS finish loading, so the nav never flashes the wrong state while
	// locating. The map-load handler below re-syncs once pins render.
	showAuthErrorFromUrl()
	checkAuthSession().catch(() => {})
	map = new maplibregl.Map({
		container: 'map',
		style: createCampusStyle(),
		center: CAMPUS_CAMERA.center,
		zoom: CAMPUS_CAMERA.zoom,
		pitch: CAMPUS_CAMERA.pitch,
		bearing: CAMPUS_CAMERA.bearing,
		minZoom: CAMPUS_MIN_ZOOM,
		maxZoom: CAMPUS_MAX_ZOOM,
		// NOTE: maxPitch must be set explicitly — MapLibre v3 defaults to
		// 60 and silently clamps anything steeper, which is why pitch 65
		// previously never visibly landed.
		minPitch: CAMPUS_MIN_PITCH,
		maxPitch: CAMPUS_MAX_PITCH,
		attributionControl: { compact: true },
	})

	map.addControl(
		new maplibregl.NavigationControl({ visualizePitch: true }),
		'bottom-right'
	)
	map.on('zoom', updateAccuracyCircle)
	// Dragging the map pauses follow (PoGo-style); 🎯 resumes it.
	map.on('dragstart', () => {
		if (!demoMode && followMode) {
			followMode = false
			setStatusChip('demo', 'Free look — 🎯 to follow GPS')
		}
	})

	// Soft pull-back: if the player free-looks far from campus and goes
	// idle, ease the camera home instead of stranding them elsewhere.
	clearPullback()
	map.on('movestart', clearPullback)
	map.on('moveend', armPullback)
	map.on('moveend', refreshFactStops)

	let tilted = true
	document.getElementById('btn-tilt')?.addEventListener('click', () => {
		tilted = !tilted
		map.easeTo({ pitch: tilted ? 72 : 60, duration: 600 })
	})
	document.getElementById('btn-reset')?.addEventListener('click', () => {
		tilted = true
		map.easeTo({ ...CAMPUS_CAMERA, duration: 700 })
	})

	map.on('load', async () => {
		// 0. Matte ground texture under the roads.
		addGroundTexture(map, 'water')
		// 1. Live GPS dot, geofenced (or clearly-labelled demo at Great Hall)
		setupMovementControls()
		setupGeoPanel()
		setupOrientation()
		startDayNightCycle(map)
		initUserPosition()

		// 2. Render Wits Campus Pins (and re-render periodically + when
		// the tab becomes visible, so console-created/edited events show
		// up without a manual page reload).
		const renderEventPins = async () => {
			// Don't yank markers while the player is mid-challenge or
			// reading a popup.
			if (
				document.getElementById('trivia-modal') ||
				document.querySelector('.maplibregl-popup')
			)
				return
			try {
				for (const s of stopMarkers) s.marker.remove()
				stopMarkers.length = 0
				const buildings = await fetchCampusEvents()
				buildings.forEach((bld) => {
					const pinElement =
						createBuildingPinElement(bld)
					const popup = new maplibregl.Popup({
						offset: 25,
					}).setHTML(eventPopupFor(bld.ev))
					// Rebuild on open so status/range are current.
					// Close any other open popup first — one tap = one event.
					popup.on('open', () => {
						closeOtherPopups(popup)
						popup.setHTML(
							eventPopupFor(bld.ev)
						)
						refreshEventStates()
					})
					popup.on('close', refreshEventStates)

					const marker = new maplibregl.Marker({
						element: pinElement,
						anchor: 'bottom',
					})
						.setLngLat(bld.coordinates)
						.setPopup(popup)
						.addTo(map)
					stopMarkers.push({
						marker,
						popup,
						ev: bld.ev,
						el: pinElement.querySelector(
							'.pokestop-bob'
						),
						pinEl: pinElement,
						id: bld.id,
						lng: bld.coordinates[0],
						lat: bld.coordinates[1],
						radius_meters:
							bld.radius_meters,
					})
				})
				applyNextSuggestedMarker()
				renderEventSidebar(stopMarkers)
				renderProximityCircles(buildings)
				refreshStopGlow()
				refreshFactStops()
			} catch (err) {
				console.error('Building pin error:', err)
			}
		}
		await renderEventPins()
		setInterval(renderEventPins, 30000)
		// Pop-ups expire on a timer; keep badges honest between reloads
		// (renderEventPins skips while a popup is open).
		setInterval(refreshEventStates, 15000)
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) renderEventPins()
		})

		// 2b. (World tiles render their own buildings; stops are the
		// tappable gameplay layer and are always rendered above.)

		// 3. Re-sync auth (the early check already resolved the header)
		await checkAuthSession().catch(() => {})
		// 3b. Terms gate: Google sign-ins land without an acceptance
		// record — block until accepted (PIN signups accept inline).
		if (currentUser) {
			await ensureTermsAccepted().catch(() => false)
		}

		// 4. 🎯 resumes GPS follow and flies to the player, wherever
		// they are in the world.
		document.getElementById('recenter-btn')?.addEventListener(
			'click',
			() => {
				followMode = true
				ensurePlayerMarker()
				map.flyTo({
					center: playerCoords,
					zoom: Math.max(map.getZoom(), 18.5),
					pitch: 72,
					bearing: 0,
					duration: 900,
				})
				if (!demoMode)
					setStatusChip(
						'live',
						'📍 Following GPS'
					)
			}
		)
	})
}

window.openAuthDrawer = () => {
	document.getElementById('auth-overlay')?.classList.add('open')
	document.getElementById('auth-drawer')?.classList.add('open')
}

window.closeAuthDrawer = () => {
	document.getElementById('auth-overlay')?.classList.remove('open')
	document.getElementById('auth-drawer')?.classList.remove('open')
}

// ---------------------------------------------------------------------------
// AUTH SIDE DRAWER FUNCTIONS
// These open/close the auth drawer, handle tab switching, and wire up the
// login/signup forms. Attached to `window` because they're called from
// inline onclick="" attributes in the drawer HTML (index.html).
// ---------------------------------------------------------------------------

function showDrawerStatus(message, isError) {
	const el = document.getElementById('auth-drawer-status')
	if (!el) return
	el.textContent = message
	el.className = `auth-status visible ${isError ? 'error' : 'success'}`
}

function showForgotPinStatus(message, isError) {
	const el = document.getElementById('forgot-pin-status')
	if (!el) return
	el.textContent = message
	el.className = `auth-status visible ${isError ? 'error' : 'success'}`
}

window.switchAuthTab = function (tab) {
	const loginPanel = document.getElementById('login-panel')
	const signupPanel = document.getElementById('signup-panel')
	const tabs = document.querySelectorAll('.auth-tab')

	if (tab === 'login') {
		loginPanel?.classList.add('active')
		signupPanel?.classList.remove('active')
		tabs[0]?.classList.add('active')
		tabs[1]?.classList.remove('active')
	} else {
		signupPanel?.classList.add('active')
		loginPanel?.classList.remove('active')
		tabs[1]?.classList.add('active')
		tabs[0]?.classList.remove('active')
	}
}

window.handleDrawerGoogleAuth = async function () {
	showDrawerStatus('Redirecting to Google...', false)
	const { error } = await googleSignIn()
	if (error) {
		showDrawerStatus('Google auth failed: ' + error.message, true)
	}
}

function setupAuthDrawerHandlers() {
	// Username + PIN login form
	const loginPinForm = document.getElementById('drawer-login-pin-form')
	if (loginPinForm) {
		loginPinForm.addEventListener('submit', async (e) => {
			e.preventDefault()
			const username = document
				.getElementById('drawer-login-username')
				.value.trim()
			const pin =
				document.getElementById(
					'drawer-login-pin'
				).value

			showDrawerStatus('Signing in...', false)
			const { data, error } = await usernameSignIn(
				username,
				pin
			)

			if (error) {
				showDrawerStatus(
					'Login failed: ' + error.message,
					true
				)
			} else {
				showDrawerStatus('Signed in!', false)
				closeAuthDrawer()
				redirectAfterLogin(data)
			}
		})
	}

	// Username + PIN signup form
	const signupPinForm = document.getElementById('drawer-signup-pin-form')
	if (signupPinForm) {
		signupPinForm.addEventListener('submit', async (e) => {
			e.preventDefault()
			const name = document
				.getElementById('drawer-signup-pin-name')
				.value.trim()
			const username = document
				.getElementById('drawer-signup-username')
				.value.trim()
			const pin =
				document.getElementById(
					'drawer-signup-pin'
				).value
			const confirm = document.getElementById(
				'drawer-signup-pin-confirm'
			).value

			if (pin !== confirm) {
				showDrawerStatus('PINs do not match.', true)
				return
			}
			const agreed = document.getElementById(
				'drawer-signup-terms'
			)?.checked
			if (!agreed) {
				showDrawerStatus(
					'Please accept the Terms of Use & Privacy Policy to create an account.',
					true
				)
				return
			}

			showDrawerStatus('Creating account...', false)
			const { data, error } = await usernameSignUp(
				name,
				username,
				pin,
				true
			)

			if (error) {
				showDrawerStatus(
					'Sign up failed: ' + error.message,
					true
				)
			} else {
				showDrawerStatus('Account created!', false)
				closeAuthDrawer()
				redirectAfterLogin(data)
			}
		})
	}

	// Forgot PIN: request a reset token (returned in-body in demo mode)
	const forgotPinForm = document.getElementById('drawer-forgot-pin-form')
	if (forgotPinForm) {
		forgotPinForm.addEventListener('submit', async (e) => {
			e.preventDefault()
			const username = document
				.getElementById('drawer-forgot-username')
				.value.trim()
			if (!username) {
				showForgotPinStatus(
					'Enter your username first.',
					true
				)
				return
			}
			showForgotPinStatus('Sending reset token...', false)
			const { data, error } = await requestPinReset(username)
			if (error) {
				showForgotPinStatus(
					'Reset request failed: ' +
						error.message,
					true
				)
			} else if (data?.reset_token) {
				showForgotPinStatus(
					'Reset token (demo mode — normally emailed): ' +
						data.reset_token +
						' — paste it below with a new PIN.',
					false
				)
			} else {
				showForgotPinStatus(
					data?.message ||
						'If that username exists, a reset token was created.',
					false
				)
			}
		})
	}

	// Reset PIN: consume the token and set the new PIN
	const resetPinForm = document.getElementById('drawer-reset-pin-form')
	if (resetPinForm) {
		resetPinForm.addEventListener('submit', async (e) => {
			e.preventDefault()
			const username = document
				.getElementById('drawer-forgot-username')
				.value.trim()
			const token = document
				.getElementById('drawer-reset-token')
				.value.trim()
			const newPin = document.getElementById(
				'drawer-reset-new-pin'
			).value
			if (!username || !token || !newPin) {
				showForgotPinStatus(
					'Enter your username, the reset token and a new PIN.',
					true
				)
				return
			}
			showForgotPinStatus('Setting new PIN...', false)
			const { error } = await confirmPinReset(
				username,
				token,
				newPin
			)
			if (error) {
				showForgotPinStatus(
					'Reset failed: ' + error.message,
					true
				)
			} else {
				showForgotPinStatus(
					'PIN updated — you can log in now.',
					false
				)
			}
		})
	}
}

document.addEventListener('DOMContentLoaded', () => {
	setupAuthDrawerHandlers()
	initTermsGate({ onDecline: () => handleLogout() })
	initFeedback({
		getUser: () => currentUser,
		openAuth: () => window.openAuthDrawer(),
	})
	if (new URLSearchParams(window.location.search).has('feedback'))
		window.openFeedbackDrawer?.()
	initializeApp()
})
