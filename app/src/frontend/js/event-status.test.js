import {
	eventTimeStatus,
	eventState,
	eventPopupHTML,
	eventActionHTML,
	metaPillsHTML,
	formatDistance,
	isPastPopup,
	consoleVisibleEvents,
	DEFAULT_RADIUS_M,
} from './event-status.js'

const NOW = Date.parse('2026-09-27T09:00:00Z')
// ~Great Hall; 0.0009° latitude ≈ 100 m.
const EV = {
	event_id: 42,
	title: 'Pop-up Quest: <Great Hall>',
	description: 'Find the plaque',
	latitude: '-26.19089',
	longitude: '28.02710',
	radius_meters: 50,
	point_reward: 20,
	is_active: 1,
	starts_at: '2026-09-27T08:30:00.000Z',
	ends_at: '2026-09-27T09:30:00.000Z',
}
const AT_EVENT = [28.0271, -26.19089]
const FAR = [28.0271, -26.18999] // ~100 m north

describe('eventTimeStatus', () => {
	test('ACTIVE inside the window', () => {
		expect(eventTimeStatus(EV, NOW)).toBe('ACTIVE')
	})
	test('EXPIRED after ends_at (a pop-up can expire while the page is open)', () => {
		expect(
			eventTimeStatus(EV, Date.parse('2026-09-27T09:31:00Z'))
		).toBe('EXPIRED')
	})
	test('UPCOMING before starts_at', () => {
		expect(
			eventTimeStatus(EV, Date.parse('2026-09-27T08:00:00Z'))
		).toBe('UPCOMING')
	})
	test('EXPIRED when is_active is false/0', () => {
		expect(eventTimeStatus({ ...EV, is_active: 0 }, NOW)).toBe(
			'EXPIRED'
		)
	})
	test('open-ended events (no dates) are ACTIVE', () => {
		expect(
			eventTimeStatus(
				{
					is_active: 1,
					starts_at: null,
					ends_at: null,
				},
				NOW
			)
		).toBe('ACTIVE')
	})
})

describe('eventState', () => {
	test('at the event: in range and attemptable', () => {
		const s = eventState(EV, AT_EVENT, NOW)
		expect(s).toMatchObject({
			status: 'ACTIVE',
			inRange: true,
			canAttempt: true,
			radius: 50,
		})
		expect(s.distanceM).toBeLessThan(1)
	})
	test('~100 m away: out of range, not attemptable', () => {
		const s = eventState(EV, FAR, NOW)
		expect(s.inRange).toBe(false)
		expect(s.canAttempt).toBe(false)
		expect(s.distanceM).toBeGreaterThan(90)
	})
	test('in range but expired: not attemptable', () => {
		const s = eventState(
			EV,
			AT_EVENT,
			Date.parse('2026-09-28T00:00:00Z')
		)
		expect(s.inRange).toBe(true)
		expect(s.canAttempt).toBe(false)
	})
	test('no player fix: distance unknown, not in range', () => {
		const s = eventState(EV, null, NOW)
		expect(s.distanceM).toBeNull()
		expect(s.inRange).toBe(false)
	})
	test('missing radius falls back to the default', () => {
		expect(
			eventState(
				{ ...EV, radius_meters: null },
				AT_EVENT,
				NOW
			).radius
		).toBe(DEFAULT_RADIUS_M)
	})
})

describe('popup markup', () => {
	test('shows status, range, distance/radius and points', () => {
		const html = eventPopupHTML(EV, eventState(EV, FAR, NOW), {
			onCampus: true,
			onAttempt: 'go',
		})
		expect(html).toContain('Active')
		expect(html).toContain('Out of range')
		expect(html).toMatch(/📍 \d+m \/ 50m/)
		expect(html).toContain('⚡ 20 pts')
	})

	test('escapes the title', () => {
		const html = eventPopupHTML(EV, eventState(EV, FAR, NOW), {
			onCampus: true,
			onAttempt: 'go',
		})
		expect(html).toContain('&lt;Great Hall&gt;')
		expect(html).not.toContain('<Great Hall>')
	})

	test('Attempt Challenge button ONLY when active and in range', () => {
		const opts = {
			onCampus: true,
			onAttempt: 'handleChallengeAttempt',
		}
		expect(
			eventActionHTML(EV, eventState(EV, AT_EVENT, NOW), opts)
		).toContain('onclick="handleChallengeAttempt(42,this)"')
		expect(
			eventActionHTML(EV, eventState(EV, FAR, NOW), opts)
		).not.toContain('<button')
		expect(
			eventActionHTML(
				EV,
				eventState(
					EV,
					AT_EVENT,
					Date.parse('2026-09-28T00:00:00Z')
				),
				opts
			)
		).toContain('This event has ended.')
	})

	test('explains why: walk closer (with distance) on campus, campus gate off campus', () => {
		const state = eventState(EV, FAR, NOW)
		expect(
			eventActionHTML(EV, state, {
				onCampus: true,
				onAttempt: 'go',
			})
		).toMatch(/Walk closer.*You're \d+m away \(need 50m\)/)
		expect(
			eventActionHTML(EV, state, {
				onCampus: false,
				onAttempt: 'go',
			})
		).toContain('You need to be on Wits campus')
	})

	test('sidebar order keeps the range pill first', () => {
		const html = metaPillsHTML(EV, eventState(EV, FAR, NOW), {
			rangeFirst: true,
		})
		expect(html.indexOf('Out of range')).toBeLessThan(
			html.indexOf('Active')
		)
	})
})

describe('helpers', () => {
	test('formatDistance', () => {
		expect(formatDistance(42.4)).toBe('42m')
		expect(formatDistance(1530)).toBe('1.5km')
	})
})

describe('Manage Events: past pop-ups', () => {
	const live = {
		event_id: 1,
		is_procedural: 1,
		curation_status: 'PUBLISHED',
	}
	const retired = {
		event_id: 2,
		is_procedural: 1,
		curation_status: 'RETIRED',
	}
	const archived = {
		event_id: 3,
		is_procedural: true,
		curation_status: 'ARCHIVED',
	}
	const manualRetired = {
		event_id: 4,
		is_procedural: 0,
		curation_status: 'RETIRED',
	}
	const manualDraft = {
		event_id: 5,
		is_procedural: 0,
		curation_status: 'DRAFT',
	}
	const all = [live, retired, archived, manualRetired, manualDraft]

	test('isPastPopup: only procedural events that are retired or archived', () => {
		expect(all.map(isPastPopup)).toEqual([
			false,
			true,
			true,
			false,
			false,
		])
	})

	test('hidden by default; live pop-ups and hand-made events stay listed', () => {
		const { visible, pastCount } = consoleVisibleEvents(all)
		expect(visible.map((e) => e.event_id)).toEqual([1, 4, 5])
		expect(pastCount).toBe(2)
	})

	test('the toggle shows them again (nothing is removed from the data)', () => {
		const { visible, pastCount } = consoleVisibleEvents(all, {
			showPastPopups: true,
		})
		expect(visible).toHaveLength(5)
		expect(pastCount).toBe(2)
		expect(all).toHaveLength(5)
	})
})
