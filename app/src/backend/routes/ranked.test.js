import { jest } from '@jest/globals'

jest.unstable_mockModule('../utils/db.js', () => ({
	default: {
		query: jest.fn(),
	},
}))

const { default: pool } = await import('../utils/db.js')
const {
	computeEloDelta,
	getActiveSeason,
	applyRatingUpdate,
	rolloverSeasonIfDue,
} = await import('../services/rating.js')

// ── Fixture state, mutated per-test ──────────────────────────

let state

function dispatch(sql, params) {
	const q = String(sql).trim().toLowerCase().replace(/\s+/g, ' ')

	if (q.startsWith('select * from seasons where is_active = true'))
		return [state.activeSeason ? [state.activeSeason] : []]

	if (
		q.startsWith(
			'select rating, wins, losses from leaderboard_entries'
		)
	) {
		const [seasonId, userId] = params
		const entry = state.entries?.[`${seasonId}:${userId}`]
		return [entry ? [entry] : []]
	}

	if (q.startsWith('insert into leaderboard_entries')) {
		state.inserts = state.inserts || []
		state.inserts.push(params)
		return [{ insertId: 1 }]
	}

	if (q.startsWith('update leaderboard_entries set rating')) {
		state.updates = state.updates || []
		state.updates.push(params)
		return [{}]
	}

	if (q.startsWith('update seasons set is_active = false')) {
		state.deactivated = params[0]
		return [{}]
	}

	if (q.startsWith('insert into seasons')) {
		state.newSeasonInsert = params
		return [{ insertId: 2 }]
	}

	if (
		q.startsWith(
			'select user_id, rating from leaderboard_entries where season_id'
		)
	)
		return [state.oldSeasonEntries || []]

	throw new Error(`Unexpected query: ${q}`)
}

beforeEach(() => {
	state = {}
	pool.query.mockReset()
	pool.query.mockImplementation(async (sql, params) =>
		dispatch(sql, params)
	)
})

// ── computeEloDelta — pure function ──────────────────────────

describe('computeEloDelta', () => {
	test('equal ratings, a win, moves by half the K-factor', () => {
		expect(computeEloDelta(1000, 1000, 1)).toBe(16)
	})

	test('equal ratings, a loss, moves down by half the K-factor', () => {
		expect(computeEloDelta(1000, 1000, 0)).toBe(-16)
	})

	test('equal ratings, a draw, moves by ~0', () => {
		expect(computeEloDelta(1000, 1000, 0.5)).toBe(0)
	})

	test('a big underdog winning gains close to the full K-factor', () => {
		const delta = computeEloDelta(800, 1200, 1)
		expect(delta).toBeGreaterThan(28)
		expect(delta).toBeLessThanOrEqual(32)
	})

	test('a big favourite winning gains very little', () => {
		const delta = computeEloDelta(1200, 800, 1)
		expect(delta).toBeGreaterThanOrEqual(0)
		expect(delta).toBeLessThan(4)
	})
})

// ── getActiveSeason ───────────────────────────────────────────

describe('getActiveSeason', () => {
	test('returns the active season row', async () => {
		state.activeSeason = { season_id: 1, name: 'Season 1' }
		await expect(getActiveSeason(pool)).resolves.toEqual(
			state.activeSeason
		)
	})

	test('returns null when there is none', async () => {
		state.activeSeason = null
		await expect(getActiveSeason(pool)).resolves.toBeNull()
	})
})

// ── applyRatingUpdate ─────────────────────────────────────────

describe('applyRatingUpdate', () => {
	test('returns null when there is no active season', async () => {
		state.activeSeason = null
		const result = await applyRatingUpdate(pool, 10, 20)
		expect(result).toBeNull()
	})

	test('returns null for missing or equal participants', async () => {
		state.activeSeason = { season_id: 1 }
		expect(await applyRatingUpdate(pool, null, 20)).toBeNull()
		expect(await applyRatingUpdate(pool, 10, null)).toBeNull()
		expect(await applyRatingUpdate(pool, 10, 10)).toBeNull()
	})

	test('creates entries at the default rating when neither player has one yet', async () => {
		state.activeSeason = { season_id: 1 }
		state.entries = {}

		const result = await applyRatingUpdate(pool, 10, 20)

		expect(result.winner.user_id).toBe(10)
		expect(result.loser.user_id).toBe(20)
		expect(result.winner.rating).toBe(1000 + 16) // equal starting ratings
		expect(result.loser.rating).toBe(1000 - 16)
		expect(state.inserts.length).toBe(2) // one getOrCreateEntry insert per player
		expect(state.updates.length).toBe(2) // one rating UPDATE per player
	})

	test('updates existing entries and increments wins/losses', async () => {
		state.activeSeason = { season_id: 1 }
		state.entries = {
			'1:10': { rating: 1100, wins: 3, losses: 1 },
			'1:20': { rating: 1000, wins: 1, losses: 2 },
		}

		const result = await applyRatingUpdate(pool, 10, 20)

		expect(result.winner.rating).toBeGreaterThan(1100)
		expect(result.loser.rating).toBeLessThan(1000)

		// [newRating, winsIncrement, lossesIncrement, seasonId, userId]
		const winnerUpdate = state.updates.find((u) => u[4] === 10)
		const loserUpdate = state.updates.find((u) => u[4] === 20)
		expect(winnerUpdate[1]).toBe(1) // wins += 1
		expect(winnerUpdate[2]).toBe(0)
		expect(loserUpdate[1]).toBe(0)
		expect(loserUpdate[2]).toBe(1) // losses += 1
	})

	test('a draw increments neither wins nor losses', async () => {
		state.activeSeason = { season_id: 1 }
		state.entries = {
			'1:10': { rating: 1000, wins: 0, losses: 0 },
			'1:20': { rating: 1000, wins: 0, losses: 0 },
		}

		await applyRatingUpdate(pool, 10, 20, true)

		for (const update of state.updates) {
			expect(update[1]).toBe(0)
			expect(update[2]).toBe(0)
		}
	})

	test('rating never drops below zero', async () => {
		state.activeSeason = { season_id: 1 }
		state.entries = {
			'1:10': { rating: 1000, wins: 0, losses: 0 },
			'1:20': { rating: 5, wins: 0, losses: 0 },
		}

		const result = await applyRatingUpdate(pool, 10, 20)
		expect(result.loser.rating).toBeGreaterThanOrEqual(0)
	})
})

// ── rolloverSeasonIfDue ───────────────────────────────────────

describe('rolloverSeasonIfDue', () => {
	test('returns null when there is no active season', async () => {
		state.activeSeason = null
		await expect(rolloverSeasonIfDue(pool)).resolves.toBeNull()
	})

	test('returns null when the active season has not ended yet', async () => {
		const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5)
		state.activeSeason = {
			season_id: 1,
			name: 'Season 1',
			ends_at: future.toISOString(),
		}
		await expect(rolloverSeasonIfDue(pool)).resolves.toBeNull()
	})

	test('closes the old season and opens the next one, past its end date', async () => {
		const past = new Date(Date.now() - 1000 * 60 * 60)
		state.activeSeason = {
			season_id: 1,
			name: 'Season 1',
			ends_at: past.toISOString(),
		}
		state.oldSeasonEntries = [
			{ user_id: 10, rating: 1200 },
			{ user_id: 20, rating: 800 },
		]

		const newSeasonId = await rolloverSeasonIfDue(pool)

		expect(newSeasonId).toBe(2)
		expect(state.deactivated).toBe(1)
		expect(state.newSeasonInsert[0]).toBe('Season 2')
		// soft reset: compressed halfway back toward 1000
		expect(state.inserts[0]).toEqual([2, 10, 1100, 2, 20, 900])
	})

	test('names the next season "Season 2" when the previous name has no trailing number', async () => {
		const past = new Date(Date.now() - 1000)
		state.activeSeason = {
			season_id: 1,
			name: 'Preseason',
			ends_at: past.toISOString(),
		}
		state.oldSeasonEntries = []

		await rolloverSeasonIfDue(pool)
		expect(state.newSeasonInsert[0]).toBe('Season 2')
	})

	test('does nothing to leaderboard_entries when the old season had no entries', async () => {
		const past = new Date(Date.now() - 1000)
		state.activeSeason = {
			season_id: 1,
			name: 'Season 1',
			ends_at: past.toISOString(),
		}
		state.oldSeasonEntries = []

		await rolloverSeasonIfDue(pool)
		expect(state.inserts).toBeUndefined()
	})
})
