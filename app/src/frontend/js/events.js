import { API_BASE } from './constants.js'
import { get_player_location } from './geolocation.js'
import { get_player_location_with_timeout } from './geolocation.js'
import { distance } from './general.js'
import { updateAuthNav, logout } from './auth-helpers.js'
import { get_location_for_challenge } from './qr-scanner.js'
import { esc } from './utils.js'
import { eventState, eventPopupHTML, metaPillsHTML } from './event-status.js'
import {
	createCampusStyle,
	CAMPUS_CAMERA,
	CAMPUS_MIN_ZOOM,
	CAMPUS_MAX_ZOOM,
	CAMPUS_MIN_PITCH,
	CAMPUS_MAX_PITCH,
	isInsideCampus,
	addGroundTexture,
	startDayNightCycle,
} from './campus-style.js'

const AUTH_API = `${API_BASE}/api/auth`
const EVENT_API = `${API_BASE}/api/events`

// ── Completed events ────────────────────────────────────────────
// The server is authoritative (a `completed` flag on GET /api/events
// for logged-in players). This localStorage mirror — same key as
// main.js — covers the instant after a win before the next fetch, and
// keeps the landing-page "next suggested" halo consistent.
const COMPLETED_EVENTS_KEY = 'wits-quest:completed-events'

function loadCompletedEventIds() {
	try {
		const raw = localStorage.getItem(COMPLETED_EVENTS_KEY)
		return new Set(raw ? JSON.parse(raw) : [])
	} catch {
		return new Set()
	}
}

function isEventCompletedLocal(eventId) {
	try {
		return loadCompletedEventIds().has(String(eventId))
	} catch {
		return false
	}
}

function markEventCompletedLocal(eventId) {
	try {
		const ids = loadCompletedEventIds()
		ids.add(String(eventId))
		localStorage.setItem(
			COMPLETED_EVENTS_KEY,
			JSON.stringify([...ids])
		)
	} catch {
		// localStorage unavailable — server flag still applies on next fetch
	}
}

function isEventDone(ev) {
	return ev.completed === true || isEventCompletedLocal(ev.event_id)
}

// ── DOM ───────────────────────────────────────────────────────
const btnLogout = document.getElementById('btn-logout')
const btnSignin = document.getElementById('btn-signin')
const btnRecenter = document.getElementById('btn-recenter')
const elLoading = document.getElementById('map-loading')
const elError = document.getElementById('map-error')
const elSidebar = document.getElementById('map-sidebar')

// ── Map ───────────────────────────────────────────────────────
// World gamified base map — CartoDB Voyager vector tiles (free, no key).
// Shared with the main page via createCampusStyle().
const map = new maplibregl.Map({
	container: 'map',
	style: createCampusStyle(),
	center: CAMPUS_CAMERA.center,
	zoom: CAMPUS_CAMERA.zoom,
	pitch: CAMPUS_CAMERA.pitch,
	bearing: CAMPUS_CAMERA.bearing,
	minZoom: CAMPUS_MIN_ZOOM,
	maxZoom: CAMPUS_MAX_ZOOM,
	// Same as main map: v3 clamps pitch to 60 unless told otherwise.
	minPitch: CAMPUS_MIN_PITCH,
	maxPitch: CAMPUS_MAX_PITCH,
	attributionControl: { compact: true },
})

map.addControl(
	new maplibregl.NavigationControl({ visualizePitch: true }),
	'bottom-right'
)

// ── Auth ──────────────────────────────────────────────────────
let currentUser = null

async function checkAuth() {
	let res
	try {
		res = await fetch(`${AUTH_API}/me`, {
			credentials: 'include',
		})
	} catch {
		// Backend unreachable — leave the nav alone and say so on the
		// map instead of silently treating the player as logged out.
		currentUser = null
		elLoading.classList.add('hidden')
		elError.textContent =
			'Could not reach the server — the map below may be stale. Refresh to retry.'
		elError.classList.remove('hidden')
		return
	}
	if (res.status === 401) {
		currentUser = null
		updateAuthNav(null)
		return
	}
	if (!res.ok) return
	currentUser = await res.json()
	updateAuthNav(currentUser)
}

btnLogout?.addEventListener('click', logout)

// ── Player location (same avatar as the main map) ───────────────
let playerMarker = null
let playerDotEl = null
let playerAccuracyEl = null
let playerLatLng = null
let playerAccuracyMeters = 0
let playerHeading = 0
let walkTimer = null
let followMode = true
let hasCenteredInitial = false
let geoWatchId = null

function metersPerPixel(lat, zoom) {
	return (
		(156543.03392 * Math.cos((lat * Math.PI) / 180)) /
		Math.pow(2, zoom)
	)
}

function updateAccuracyCircle() {
	if (!playerAccuracyEl || !map || !playerLatLng) return
	const px = playerAccuracyMeters
		? Math.min(
				220,
				Math.max(
					18,
					(playerAccuracyMeters /
						metersPerPixel(
							playerLatLng[1],
							map.getZoom()
						)) *
						2
				)
			)
		: 44
	playerAccuracyEl.style.width = `${px}px`
	playerAccuracyEl.style.height = `${px}px`
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
		clearTimeout(walkTimer)
		walkTimer = setTimeout(() => setWalking(false), 2500)
	}
}

function bearingBetween(a, b) {
	const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
	const dx = (b[0] - a[0]) * kx
	const dy = (b[1] - a[1]) * 110540
	return (Math.atan2(dx, dy) * 180) / Math.PI
}

function distanceMeters(a, b) {
	const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
	const dx = (a[0] - b[0]) * kx
	const dy = (a[1] - b[1]) * 110540
	return Math.hypot(dx, dy)
}

function startGeolocation() {
	if (!('geolocation' in navigator)) {
		elError.textContent =
			'Geolocation is not supported by your browser.'
		elError.classList.remove('hidden')
		return
	}

	if (geoWatchId !== null) {
		navigator.geolocation.clearWatch(geoWatchId)
		geoWatchId = null
	}

	geoWatchId = navigator.geolocation.watchPosition(
		(pos) => {
			const prev = playerLatLng
			playerLatLng = [
				pos.coords.longitude,
				pos.coords.latitude,
			]
			playerAccuracyMeters = pos.coords.accuracy ?? 0

			if (!playerMarker) {
				const el = document.createElement('div')
				el.className = 'pogo-player'
				el.innerHTML = `<div class="pogo-accuracy"></div><div class="pogo-wedge"></div><div class="pogo-dot idle"></div>`
				playerDotEl = el
				playerAccuracyEl =
					el.querySelector('.pogo-accuracy')
				playerMarker = new maplibregl.Marker({
					element: el,
				})
					.setLngLat(playerLatLng)
					.addTo(map)
				setHeading(playerHeading)
			} else {
				if (
					prev &&
					distanceMeters(prev, playerLatLng) > 2
				) {
					setHeading(
						bearingBetween(
							prev,
							playerLatLng
						)
					)
					setWalking(true)
				}
				playerMarker.setLngLat(playerLatLng)
			}
			updateAccuracyCircle()

			// First GPS fix: center on player position
			if (!hasCenteredInitial) {
				hasCenteredInitial = true
				map.flyTo({
					center: playerLatLng,
					zoom: Math.max(map.getZoom(), 18.5),
					pitch: CAMPUS_CAMERA.pitch,
					bearing: CAMPUS_CAMERA.bearing,
					duration: 900,
				})
			} else if (followMode) {
				map.easeTo({
					center: playerLatLng,
					duration: 400,
				})
			}

			refreshAllStopsProximity()
		},
		(err) => {
			console.warn('Geolocation:', err.message)
			if (err.code === 1 /* PERMISSION_DENIED */) {
				elError.textContent =
					'Location permission blocked — allow location to view nearby stops and play.'
				elError.classList.remove('hidden')
			}
		},
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
	)
}

btnRecenter?.addEventListener('click', () => {
	followMode = true
	if (playerLatLng) {
		map.flyTo({
			center: playerLatLng,
			zoom: Math.max(map.getZoom(), 18.5),
			pitch: CAMPUS_CAMERA.pitch,
			bearing: 0,
			duration: 800,
		})
	} else {
		map.flyTo({
			center: CAMPUS_CAMERA.center,
			zoom: CAMPUS_CAMERA.zoom,
			duration: 800,
		})
	}
})

// ── Event markers ─────────────────────────────────────────────
let activeMarkers = []
let activePopup = null
const stopRefs = []

function clearMarkers() {
	activeMarkers.forEach((m) => m.remove())
	activeMarkers = []
	stopRefs.length = 0
	if (activePopup) {
		activePopup.remove()
		activePopup = null
	}
	// Keep sidebar header, remove event cards + next-up banner
	const cards = elSidebar.querySelectorAll('.sidebar-event')
	cards.forEach((c) => c.remove())
	elSidebar.querySelector('#sidebar-next')?.remove()
}

function makeStopMarker(ev, inRange) {
	const el = document.createElement('div')
	el.className = `pokestop${inRange ? ' gym' : ''}`
	el.title = ev.title
	// Same floating-cube structure as the main map. .pokestop-bob carries
	// the JS proximity scale; cube/ring animate independently via CSS.
	el.innerHTML = `<div class="pokestop-bob"><div class="stop-cube"><span>${inRange ? '⚡' : '🏛️'}</span></div><div class="stop-pole"></div><div class="stop-ring"></div></div>`
	return el
}

// Scale/glow each stop by live proximity and update inRange state dynamically.
function refreshAllStopsProximity() {
	if (!playerLatLng) return
	const onCampus = isInsideCampus(playerLatLng[0], playerLatLng[1])

	for (const ref of stopRefs) {
		const d = distanceMeters(playerLatLng, [ref.lng, ref.lat])
		const t = Math.max(0, Math.min(1, 1 - (d - 40) / 210))
		ref.bobEl.style.transform = `scale(${(1 + 0.4 * t).toFixed(3)})`
		ref.bobEl.style.setProperty('--pg', t.toFixed(3))

		const state = eventState(ref.ev, playerLatLng)
		const inRange = state.inRange
		if (ref.inRange !== inRange) {
			ref.inRange = inRange
			ref.el.classList.toggle('gym', inRange)
			if (ref.cubeSpan) {
				ref.cubeSpan.textContent = inRange ? '⚡' : '🏛️'
			}
		}
		// Distance changes on every move, so refresh the card's badges.
		const meta = elSidebar.querySelector(
			`.sidebar-event[data-id="${ref.ev.event_id}"] .sidebar-event-meta`
		)
		if (meta)
			meta.innerHTML = metaPillsHTML(ref.ev, state, {
				rangeFirst: true,
			})

		if (
			activePopup &&
			activePopup === ref.popup &&
			ref.popup.isOpen()
		) {
			activePopup.setHTML(
				buildPopupHTML(ref.ev, inRange, onCampus)
			)
		}
	}
}

function openStopPopup(ref) {
	const onCampus = playerLatLng
		? isInsideCampus(playerLatLng[0], playerLatLng[1])
		: false
	const d = playerLatLng
		? distanceMeters(playerLatLng, [ref.lng, ref.lat])
		: Infinity
	const inRange = d <= (ref.ev.radius_meters || 60)

	ref.popup.setHTML(buildPopupHTML(ref.ev, inRange, onCampus))
	activePopup?.remove()
	ref.popup.setLngLat([ref.lng, ref.lat]).addTo(map)
	activePopup = ref.popup

	// Highlight sidebar card
	document.querySelectorAll('.sidebar-event').forEach((c) =>
		c.classList.remove('active')
	)
	document.querySelector(
		`.sidebar-event[data-id="${ref.ev.event_id}"]`
	)?.classList.add('active')
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

// Translucent trigger-radius discs under each stop (same as main map).
// Re-renders on every load so discs for newly-completed events disappear.
function renderProximityCircles(events) {
	if (!map) return
	const features = events
		.filter((ev) => {
			const lng = parseFloat(ev.longitude)
			const lat = parseFloat(ev.latitude)
			return !isNaN(lng) && !isNaN(lat)
		})
		.map((ev) => ({
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [
					circleCoords(
						parseFloat(ev.longitude),
						parseFloat(ev.latitude),
						ev.radius_meters || 60
					),
				],
			},
		}))
	const collection = { type: 'FeatureCollection', features }
	const existing = map.getSource('event-radii')
	if (existing) {
		existing.setData(collection)
		return
	}
	if (!features.length) return
	map.addSource('event-radii', {
		type: 'geojson',
		data: collection,
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

// Popup markup is shared with the main map (js/event-status.js): live
// status, range, distance/radius, points — and the Attempt button only
// when the event is live AND the player is inside its radius.
function buildPopupHTML(ev, inRange, onCampus = false) {
	return eventPopupHTML(ev, eventState(ev, playerLatLng), {
		onCampus,
		onAttempt: 'window._challenge',
	})
}

// ── Next-up banner ────────────────────────────────────────────
// Points the player at the nearest event they haven't done yet.
function formatDistance(meters) {
	if (meters == null || isNaN(meters)) return ''
	if (meters < 1000) return `${Math.round(meters)}m away`
	return `${(meters / 1000).toFixed(1)}km away`
}

function renderNextUp(undoneEvents, playerLoc, doneCount = 0) {
	const header = elSidebar.querySelector('.sidebar-header')
	if (!header) return
	const banner = document.createElement('div')
	banner.id = 'sidebar-next'

	if (!undoneEvents.length) {
		banner.className = 'sidebar-next done'
		banner.innerHTML = `
			<div class="sidebar-next-title">🎉 All caught up!</div>
			<div class="sidebar-next-sub">You've completed every active event — new ones will appear here.</div>
		`
		header.after(banner)
		return
	}

	const progress =
		doneCount > 0
			? `<div class="sidebar-next-progress">${doneCount} completed · ${undoneEvents.length} to go</div>`
			: ''

	let next = undoneEvents[0]
	let nextDist = null
	if (playerLoc) {
		let best = Infinity
		for (const ev of undoneEvents) {
			const lat = parseFloat(ev.latitude)
			const lng = parseFloat(ev.longitude)
			if (isNaN(lat) || isNaN(lng)) continue
			const d = distance(
				{
					latitude: playerLoc[0],
					longitude: playerLoc[1],
				},
				{ latitude: lat, longitude: lng }
			)
			if (d < best) {
				best = d
				next = ev
			}
		}
		nextDist = best === Infinity ? null : best
	}

	banner.className = 'sidebar-next'
	banner.innerHTML = `
		<div class="sidebar-next-title">➡️ Next up: ${esc(next.title)}</div>
		<div class="sidebar-next-sub">${nextDist != null ? `${esc(formatDistance(nextDist))} · ` : ''}⚡ ${esc(String(next.point_reward))} pts · 📍 ${esc(String(next.radius_meters))}m — tap to go</div>
		${progress}
	`
	banner.addEventListener('click', () => {
		const lng = parseFloat(next.longitude)
		const lat = parseFloat(next.latitude)
		if (isNaN(lng) || isNaN(lat)) return
		map.flyTo({ center: [lng, lat], zoom: 18, duration: 600 })
		const ref = stopRefs.find(
			(r) => Number(r.ev.event_id) === Number(next.event_id)
		)
		if (ref) openStopPopup(ref)
	})
	header.after(banner)
}

// ── Load events ───────────────────────────────────────────────
// Completed events are hidden; the banner points at what's left.
async function loadEvents({ force = false } = {}) {
	// Don't yank markers while the player is reading a popup or
	// mid-challenge — rebuilding here closed the tapped popup and
	// re-added every pin, which looked like many events flashing by.
	// The post-win reload passes force:true so a counted win still
	// hides immediately even with the result modal open.
	if (
		!force &&
		(document.getElementById('trivia-overlay') ||
			document.getElementById('result-overlay') ||
			document.getElementById('qr-overlay') ||
			document.querySelector('.maplibregl-popup'))
	)
		return
	clearMarkers()
	elError.classList.add('hidden')

	try {
		// credentials: logged-in players get a per-event `completed`
		// flag; anonymous players get the plain list as before.
		const res = await fetch(EVENT_API, {
			cache: 'no-store',
			credentials: 'include',
		})
		if (!res.ok)
			throw new Error(`Server responded with ${res.status}`)
		const events = await res.json()

		elLoading.classList.add('hidden')

		if (!events.length) {
			elError.textContent =
				'No active events right now — check back later.'
			elError.classList.remove('hidden')
			return
		}

		const undone = events.filter((ev) => !isEventDone(ev))
		const doneCount = events.length - undone.length

		if (!undone.length) {
			renderProximityCircles([])
			renderNextUp([], null)
			return
		}

		// Try player location for range check: prefer live coordinates if available.
		// Give GPS 2.5 s so markers never wait out the full fix timeout.
		let playerLoc = playerLatLng
			? [playerLatLng[1], playerLatLng[0]]
			: null
		if (!playerLoc) {
			try {
				playerLoc =
					await get_player_location_with_timeout(
						2500
					)
			} catch {
				/* fine */
			}
		}

		// Campus gate for taps: off-campus (or no fix) players see the
		// stops but get the gate message instead of a challenge button.
		const onCampus = playerLoc
			? isInsideCampus(playerLoc[1], playerLoc[0])
			: false

		for (const ev of undone) {
			const lng = parseFloat(ev.longitude)
			const lat = parseFloat(ev.latitude)
			if (isNaN(lng) || isNaN(lat)) continue

			const inRange = playerLoc
				? distance(
						{
							latitude: playerLoc[0],
							longitude: playerLoc[1],
						},
						{
							latitude: lat,
							longitude: lng,
						}
					) <= ev.radius_meters
				: false

			// Pokéstop marker
			const el = makeStopMarker(ev, inRange)

			const marker = new maplibregl.Marker({
				element: el,
				anchor: 'bottom',
			})
				.setLngLat([lng, lat])
				.addTo(map)

			const popup = new maplibregl.Popup({
				offset: 25,
				closeButton: true,
			})
			// If the player closes the popup via the X button, forget it
			// so proximity refreshes don't rewrite a dead popup.
			popup.on('close', () => {
				if (activePopup === popup) activePopup = null
			})

			const ref = {
				marker,
				popup,
				el,
				bobEl: el.querySelector('.pokestop-bob'),
				cubeSpan: el.querySelector('.stop-cube span'),
				ev,
				lng,
				lat,
				inRange,
			}
			stopRefs.push(ref)

			el.addEventListener('click', (e) => {
				// Stop this reaching the map: MapLibre closes popups on
				// any map click (closeOnClick), so without this the popup
				// opens and shuts in the same tick and the tap looks dead.
				e.stopPropagation()
				openStopPopup(ref)
			})

			activeMarkers.push(marker)
			addSidebarCard(ev, inRange, lng, lat)
		}

		renderProximityCircles(undone)
		refreshAllStopsProximity()
		renderNextUp(undone, playerLoc, doneCount)
	} catch (err) {
		elLoading.classList.add('hidden')
		elError.textContent = `Could not load events — ${err.message}`
		elError.classList.remove('hidden')
	}
}

function addSidebarCard(ev, inRange, lng, lat) {
	const card = document.createElement('div')
	card.className = 'sidebar-event'
	card.dataset.id = ev.event_id

	card.innerHTML = `
		<div class="sidebar-event-title">${esc(ev.title)}</div>
		<div class="sidebar-event-meta">${metaPillsHTML(
			ev,
			{ ...eventState(ev, playerLatLng), inRange },
			{ rangeFirst: true }
		)}</div>
	`

	card.addEventListener('click', () => {
		map.flyTo({ center: [lng, lat], zoom: 18, duration: 600 })
		document.querySelectorAll('.sidebar-event').forEach((c) =>
			c.classList.remove('active')
		)
		card.classList.add('active')
		const ref = stopRefs.find(
			(r) => Number(r.ev.event_id) === Number(ev.event_id)
		)
		if (ref) openStopPopup(ref)
	})

	elSidebar.appendChild(card)
}

// ── Voice-guide bridge ────────────────────────────────────────
// The popup speaker button carries only the event id, so the voice
// handler in events.html looks the full event row and the current
// player position up through these two globals.
window.__a2a_get_event = (eventId) =>
	stopRefs.find((r) => Number(r.ev.event_id) === Number(eventId))?.ev ??
	null
window.__a2a_get_player_lnglat = () => playerLatLng

// QR proof for the currently open challenge, keyed by event id. The GET
// side of the QR fallback passes location_check_id as a query param, but
// the submit side never forwarded it — so QR-verified players fell into
// the GPS branch and got 'Location is required'. Stashed here when the
// challenge opens, consumed (once) on submit.
const pendingQrByEvent = new Map()

// Running countdown of the open trivia modal, if any. A re-challenge
// must stop the previous timer first — otherwise the old interval keeps
// ticking and submits a stale question after the new one opens.
let activeTriviaTimer = null

// ── Challenge handler ─────────────────────────────────────────
window._challenge = async function (eventId, btnEl) {
	if (!currentUser) {
		// The session check may have failed on a network blip — retry
		// once before treating the player as logged out.
		await checkAuth()
		if (!currentUser) {
			window.location.href = '/'
			return
		}
	}

	// Disable the tapped button itself (passed as `this` from the popup
	// markup) — not the first challenge button in the document, which
	// may belong to a different event's popup.
	const btn =
		btnEl instanceof Element
			? btnEl
			: document.querySelector('.popup-challenge-btn')
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Verifying location…'
	}

	let location = null
	try {
		// If live GPS tracking already has an accurate fix (<= 50m), use it directly
		if (
			playerLatLng &&
			playerAccuracyMeters > 0 &&
			playerAccuracyMeters <= 50
		) {
			location = {
				mode: 'gps',
				lat: playerLatLng[1],
				lng: playerLatLng[0],
				accuracy: Math.round(playerAccuracyMeters),
			}
		} else {
			location = await get_location_for_challenge(eventId)
		}
	} catch {
		location = null
	}

	if (!location) {
		if (btn) {
			btn.disabled = false
			btn.textContent = '⚡ Attempt Challenge'
		}
		return
	}

	const locationParams =
		location.mode === 'gps'
			? `lat=${location.lat}&lng=${location.lng}&accuracy=${location.accuracy}`
			: `qr_verified=true&location_check_id=${location.location_check_id}`

	// Remember QR proof for the submit call (cleared on submit). A GPS
	// challenge for the same event drops any stale QR proof.
	if (location.mode === 'gps') {
		pendingQrByEvent.delete(Number(eventId))
	} else {
		pendingQrByEvent.set(
			Number(eventId),
			location.location_check_id
		)
	}

	try {
		const res = await fetch(
			`${API_BASE}/api/trivia/event/${eventId}?${locationParams}`,
			{ credentials: 'include' }
		)

		if (res.status === 401) {
			window.location.href = '/'
			return
		}

		const data = await res.json()

		if (data.fallback_required) {
			alert(
				`GPS accuracy too poor (${data.reported_accuracy_m}m). Please scan the QR code at this location.`
			)
			return
		}

		if (!res.ok) {
			alert(
				data.error ||
					'No trivia challenge available for this event right now.'
			)
			return
		}

		activePopup?.remove()
		showTriviaModal(eventId, data)
	} catch {
		alert('Error connecting to the challenge server.')
	} finally {
		if (btn) {
			btn.disabled = false
			btn.textContent = '⚡ Attempt Challenge'
		}
	}
}

// ── Trivia modal ──────────────────────────────────────────────
function showTriviaModal(eventId, trivia) {
	// Stop any previous countdown before replacing the modal, so a
	// re-challenge can't be answered by the old timer's stale submit.
	if (activeTriviaTimer) {
		clearInterval(activeTriviaTimer)
		activeTriviaTimer = null
	}
	document.getElementById('trivia-overlay')?.remove()

	const timeLimit = trivia.time_limit_s || 30
	const startTime = Date.now()
	// Exactly one submit per modal: a tap landing on the same tick as
	// the timeout (or a fast double-tap) must not fire two requests.
	let submitted = false

	// FILL_BLANK: no options are sent — the player types the answer.
	const isFillBlank = trivia.format === 'FILL_BLANK'
	const fillBlankHtml = `
		<form id="trivia-fill-form" style="display:flex;gap:8px;margin:6px 0;">
			<input id="trivia-fill-input" type="text" autocomplete="off" required
				placeholder="Type your answer" aria-label="Your answer"
				style="flex:1;padding:10px 14px;border-radius:var(--radius);border:1px solid var(--border);
					background:var(--surface-2);color:var(--text);font-family:var(--font-body);font-size:0.875rem;" />
			<button type="submit" class="trivia-option-btn"
				style="padding:10px 14px;border-radius:var(--radius);border:1px solid var(--border);
					background:var(--surface-2);color:var(--text);cursor:pointer;font-family:var(--font-body);">
				Submit
			</button>
		</form>
	`
	const optionsHtml = isFillBlank
		? fillBlankHtml
		: trivia.options
				.map(
					(opt) => `
		<button data-option-id="${opt.option_id}" class="trivia-option-btn"
			style="display:block;width:100%;margin:6px 0;padding:10px 14px;
				border-radius:var(--radius);border:1px solid var(--border);
				background:var(--surface-2);color:var(--text);
				cursor:pointer;font-size:0.875rem;text-align:left;
				font-family:var(--font-body);transition:border-color 180ms ease,background 180ms ease;"
			onmouseover="this.style.borderColor='#0c2461';this.style.background='#f0f4ff'"
			onmouseout="this.style.borderColor='';this.style.background=''">
			${opt.body}
		</button>
	`
				)
				.join('')

	const overlay = document.createElement('div')
	overlay.id = 'trivia-overlay'
	overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.45);
		display:flex;align-items:center;justify-content:center;z-index:10000;`

	overlay.innerHTML = `
		<div style="background:var(--surface);border:1px solid var(--border);
			border-radius:var(--radius-lg);padding:1.75rem;max-width:420px;width:90%;
			box-shadow:0 8px 30px rgba(0,0,0,0.15);font-family:var(--font-body);">
			<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
				<div style="font-family:var(--font-display);font-weight:700;font-size:1.05rem;color:var(--text);">
					🎯 Campus Challenge
				</div>
				<div id="trivia-timer" style="font-weight:700;font-size:1rem;color:var(--accent);min-width:2.5rem;text-align:right;">
					${timeLimit}s
				</div>
			</div>
			<div style="height:4px;background:var(--border);border-radius:2px;margin-bottom:1rem;overflow:hidden;">
				<div id="trivia-timer-bar" style="height:100%;width:100%;background:var(--accent);transition:width 1s linear;border-radius:2px;"></div>
			</div>
			<p style="font-size:0.875rem;color:var(--text-dim);margin-bottom:1rem;line-height:1.5;">${trivia.body}</p>
			<div id="trivia-options">${optionsHtml}</div>
			<button id="trivia-close-btn"
				style="margin-top:1rem;background:none;border:none;color:var(--text-muted);
					cursor:pointer;font-size:0.8rem;text-decoration:underline;font-family:var(--font-body);">
				Close
			</button>
		</div>
	`

	document.body.appendChild(overlay)

	// Single funnel for every submit path below (option tap, fill-blank
	// form, timeout): first call wins, the rest are ignored.
	const submitOnce = (optionId, elapsed, answerText = null) => {
		if (submitted) return
		submitted = true
		if (activeTriviaTimer) {
			clearInterval(activeTriviaTimer)
			activeTriviaTimer = null
		}
		overlay.querySelectorAll('.trivia-option-btn').forEach(
			(b) => (b.disabled = true)
		)
		window._submitAnswer(
			eventId,
			trivia.question_id,
			optionId,
			elapsed,
			answerText
		)
	}

	overlay.querySelector('#trivia-close-btn').addEventListener(
		'click',
		() => {
			if (activeTriviaTimer) {
				clearInterval(activeTriviaTimer)
				activeTriviaTimer = null
			}
			overlay.remove()
		}
	)

	overlay.querySelector('#trivia-fill-form')?.addEventListener(
		'submit',
		(e) => {
			e.preventDefault()
			const input =
				overlay.querySelector('#trivia-fill-input')
			const text = input.value.trim()
			if (!text) return
			input.disabled = true
			submitOnce(null, Date.now() - startTime, text)
		}
	)

	overlay.querySelector('#trivia-options').addEventListener(
		'click',
		(e) => {
			if (isFillBlank) return // handled by the form's submit
			const btn = e.target.closest('.trivia-option-btn')
			if (!btn) return
			const optionId = parseInt(btn.dataset.optionId, 10)
			if (!optionId) return
			submitOnce(optionId, Date.now() - startTime)
		}
	)

	let remaining = timeLimit
	const timerEl = overlay.querySelector('#trivia-timer')
	const timerBar = overlay.querySelector('#trivia-timer-bar')

	activeTriviaTimer = setInterval(() => {
		// The modal may already be gone (answered + removed) while this
		// tick was queued — never submit twice.
		if (submitted || !document.body.contains(overlay)) {
			clearInterval(activeTriviaTimer)
			activeTriviaTimer = null
			return
		}
		remaining--
		timerEl.textContent = `${remaining}s`
		timerBar.style.width = `${(remaining / timeLimit) * 100}%`
		if (remaining <= 10) {
			timerEl.style.color = 'var(--danger)'
			timerBar.style.background = 'var(--danger)'
		}
		if (remaining <= 0) {
			submitOnce(null, timeLimit * 1000)
		}
	}, 1000)
}

// ── Submit + result modal ─────────────────────────────────────
window._submitAnswer = async function (
	eventId,
	questionId,
	optionId,
	answerTimeMs,
	answerText = null
) {
	if (!optionId && !answerText) {
		document.getElementById('trivia-overlay')?.remove()
		showResultModal({
			is_correct: false,
			timed_out: true,
			points_awarded: 0,
			answer_time_ms: answerTimeMs,
		})
		return
	}

	try {
		// Always attach coordinates: prefer the live watch position, fall
		// back to a fresh one-shot fix. Without them the backend 400s
		// ('Location is required to submit an answer.').
		let lat = playerLatLng ? playerLatLng[1] : null
		let lng = playerLatLng ? playerLatLng[0] : null
		if (lat === null) {
			try {
				;[lat, lng] = await get_player_location()
			} catch {
				/* backend will 400 with a clear message */
			}
		}
		const body = {
			event_id: eventId,
			question_id: questionId,
			answer_time_ms: answerTimeMs ?? 1500,
		}
		if (answerText) body.answer_text = answerText
		else body.selected_option_id = optionId
		// QR-verified challenge: forward the proof so the backend takes
		// the FALLBACK_QR branch instead of demanding GPS coordinates.
		const qrCheckId = pendingQrByEvent.get(Number(eventId))
		pendingQrByEvent.delete(Number(eventId))
		if (qrCheckId) {
			body.qr_verified = true
			body.location_check_id = qrCheckId
		}
		if (lat !== null) body.claimed_lat = lat
		if (lng !== null) body.claimed_lng = lng
		const res = await fetch(`${API_BASE}/api/trivia/submit`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (res.status === 401) {
			window.location.href = '../index.html'
			return
		}
		const data = await res.json()
		document.getElementById('trivia-overlay')?.remove()
		showResultModal({ ...data, answer_time_ms: answerTimeMs })
		// Counted win: hide this event and point at the next one.
		// (location_verified matters — a correct-but-too-far answer
		// does not count and must not hide the event.)
		if (data.is_correct && data.location_verified) {
			markEventCompletedLocal(eventId)
			loadEvents({ force: true })
		}
	} catch {
		alert('Failed to submit answer.')
	}
}

function showResultModal(data) {
	document.getElementById('result-overlay')?.remove()

	// Backend rejection (e.g. 400 'Location is required…') arrives as
	// { error } with no grading fields — show the real message instead of
	// a misleading 'Not quite!'.
	if (data && data.error && data.is_correct === undefined) {
		const overlay = document.createElement('div')
		overlay.id = 'result-overlay'
		overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);
			display:flex;align-items:center;justify-content:center;z-index:10001;`
		overlay.innerHTML = `
			<div style="background:var(--surface);border:1px solid var(--border);
				border-radius:var(--radius-lg);max-width:400px;width:90%;
				box-shadow:0 8px 30px rgba(0,0,0,0.18);font-family:var(--font-body);overflow:hidden;">
				<div style="background:#fef2f2;border-bottom:1px solid #fca5a5;padding:1.1rem 1.25rem;text-align:center;">
					<div style="font-size:2rem;">⚠️</div>
					<div style="font-weight:800;font-size:1.05rem;color:#991b1b;">Couldn't submit</div>
				</div>
				<div style="padding:1.25rem;text-align:center;">
					<p style="font-size:0.9rem;color:var(--text);margin:0 0 1rem;">${data.error}</p>
					<button id="result-close" class="btn btn-primary" style="width:100%;">Continue</button>
				</div>
			</div>`
		document.body.appendChild(overlay)
		overlay.querySelector('#result-close').addEventListener(
			'click',
			() => overlay.remove()
		)
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) overlay.remove()
		})
		return
	}

	const {
		is_correct,
		timed_out,
		points_awarded = 0,
		correct_option_text,
		card_awarded,
		awarded_card,
		already_earned_card,
		already_completed,
		answer_time_ms,
	} = data

	const timeSecs = answer_time_ms
		? (answer_time_ms / 1000).toFixed(1)
		: null
	const headerBg = is_correct ? '#f0fdf4' : '#fef2f2'
	const headerBorder = is_correct ? '#86efac' : '#fca5a5'
	const headerIcon = timed_out ? '⏱️' : is_correct ? '✅' : '❌'
	const headerText = timed_out
		? "Time's up!"
		: is_correct
			? 'Correct!'
			: 'Not quite!'
	const headerColor = is_correct ? '#166534' : '#991b1b'

	const pointsHtml =
		points_awarded > 0
			? `<div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;
				background:#fefce8;border:1px solid #fde047;border-radius:8px;
				padding:0.6rem 1rem;margin-bottom:0.75rem;">
				<span style="font-size:1.1rem;">⚡</span>
				<span style="font-weight:700;color:#854d0e;font-size:1rem;">+${points_awarded} points earned</span>
				${timeSecs ? `<span style="font-size:0.78rem;color:#a16207;margin-left:0.25rem;">in ${timeSecs}s</span>` : ''}
			</div>`
			: ''

	const correctHtml = correct_option_text
		? `<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">
				Correct answer: <strong style="color:var(--text);">${correct_option_text}</strong>
			</div>`
		: ''

	let cardHtml = ''
	if (card_awarded && awarded_card) {
		const rarityColours = {
			COMMON: '#64748b',
			RARE: '#2563eb',
			LEGENDARY: '#d97706',
		}
		const rc = rarityColours[awarded_card.rarity] ?? '#64748b'
		cardHtml = `
			<div style="border:2px solid ${rc};border-radius:10px;padding:0.85rem;
				margin-bottom:0.75rem;background:linear-gradient(135deg,#fff,#f8faff);">
				<div style="font-size:0.7rem;font-weight:700;letter-spacing:0.1em;
					text-transform:uppercase;color:${rc};margin-bottom:0.3rem;">🃏 New card earned!</div>
				<div style="display:flex;align-items:center;gap:0.75rem;">
					${
						awarded_card.image_url
							? `<img src="${awarded_card.image_url}" style="width:48px;height:48px;border-radius:6px;object-fit:cover;" />`
							: `<div style="width:48px;height:48px;border-radius:6px;background:var(--border);
							display:flex;align-items:center;justify-content:center;
							font-size:1.3rem;font-weight:700;color:var(--text-muted);">
							${(awarded_card.name || '?').charAt(0)}</div>`
					}
					<div>
						<div style="font-weight:700;font-size:0.95rem;color:var(--text);">${awarded_card.name}</div>
						<div style="font-size:0.78rem;font-weight:600;color:${rc};">${awarded_card.rarity} · ${awarded_card.category ?? ''}</div>
					</div>
				</div>
			</div>`
	} else if (already_earned_card) {
		cardHtml = `<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">
			🃏 You've already earned this event's card.
		</div>`
	}

	const replayHtml =
		is_correct && already_completed
			? `<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">
			🎓 Practice run — you've already completed this event, no new points.
		</div>`
			: ''

	const overlay = document.createElement('div')
	overlay.id = 'result-overlay'
	overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);
		display:flex;align-items:center;justify-content:center;z-index:10001;`

	overlay.innerHTML = `
		<div style="background:var(--surface);border:1px solid var(--border);
			border-radius:var(--radius-lg);max-width:400px;width:90%;
			box-shadow:0 8px 30px rgba(0,0,0,0.18);font-family:var(--font-body);overflow:hidden;">
			<div style="background:${headerBg};border-bottom:1px solid ${headerBorder};
				padding:1.25rem 1.5rem;text-align:center;">
				<div style="font-size:2rem;margin-bottom:0.25rem;">${headerIcon}</div>
				<div style="font-weight:800;font-size:1.15rem;color:${headerColor};">${headerText}</div>
				${
					timeSecs && !timed_out
						? `<div style="font-size:0.78rem;color:${headerColor};opacity:0.75;margin-top:0.2rem;">Answered in ${timeSecs}s</div>`
						: ''
				}
			</div>
			<div style="padding:1.25rem 1.5rem;">
				${pointsHtml}${correctHtml}${cardHtml}${replayHtml}
				<button id="result-close" style="width:100%;background:var(--accent);color:#fff;
					border:none;border-radius:var(--radius);padding:0.6rem 1rem;
					font-size:0.875rem;font-weight:600;cursor:pointer;font-family:var(--font-body);">
					Continue
				</button>
			</div>
		</div>`

	document.body.appendChild(overlay)
	overlay.querySelector('#result-close').addEventListener('click', () =>
		overlay.remove()
	)
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) overlay.remove()
	})
}

// ── Boot ──────────────────────────────────────────────────────
await checkAuth()
startGeolocation()

// Wait for map to load before adding markers
map.on('load', () => {
	addGroundTexture(map)
	startDayNightCycle(map)
	loadEvents()
})
map.on('zoom', updateAccuracyCircle)
map.on('dragstart', () => {
	followMode = false
})

window.addEventListener('beforeunload', () => {
	if (geoWatchId !== null && 'geolocation' in navigator) {
		navigator.geolocation.clearWatch(geoWatchId)
		geoWatchId = null
	}
})

setInterval(loadEvents, 30000)
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) loadEvents()
})
