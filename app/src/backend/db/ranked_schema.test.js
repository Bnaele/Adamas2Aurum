import { jest } from '@jest/globals'

jest.unstable_mockModule('../utils/db.js', () => ({
	default: {
		query: jest.fn(),
	},
}))

const { default: pool } = await import('../utils/db.js')
const { ensure_ranked_schema } = await import('./ranked_schema.js')

// ── Fixture state ─────────────────────────────────────────────

let state

function dispatch(sql) {
	const q = String(sql).trim().toLowerCase().replace(/\s+/g, ' ')

	if (q.startsWith('alter table leaderboard_entries')) {
		if (state.alterError) throw state.alterError
		return [{}]
	}
	if (
		q.startsWith(
			'select season_id from seasons where is_active = true'
		)
	)
		return [state.activeSeason ? [state.activeSeason] : []]
	if (
		q.startsWith(
			'select season_id from seasons order by starts_at desc'
		)
	)
		return [state.anySeason ? [state.anySeason] : []]
	if (q.startsWith('update seasons set is_active = true')) {
		state.reactivated = true
		return [{}]
	}
	if (q.startsWith('insert into seasons')) {
		state.inserted = true
		return [{ insertId: 1 }]
	}

	throw new Error(`Unexpected query: ${q}`)
}

beforeEach(() => {
	jest.spyOn(console, 'warn').mockImplementation(() => {})
	state = { activeSeason: { season_id: 1 } }
	pool.query.mockReset()
	pool.query.mockImplementation(async (sql) => dispatch(sql))
})

afterEach(() => {
	console.warn.mockRestore()
})

describe('ensure_ranked_schema', () => {
	test('runs the ALTER and does nothing further when a season is already active', async () => {
		await ensure_ranked_schema()
		expect(state.reactivated).toBeUndefined()
		expect(state.inserted).toBeUndefined()
		expect(console.warn).not.toHaveBeenCalled()
	})

	test('swallows a duplicate-column error silently', async () => {
		state.alterError = Object.assign(new Error('dup'), {
			code: 'ER_DUP_FIELDNAME',
		})
		await ensure_ranked_schema()
		expect(console.warn).not.toHaveBeenCalled()
	})

	test('swallows a duplicate-column error identified by errno', async () => {
		state.alterError = Object.assign(new Error('dup'), {
			errno: 1060,
		})
		await ensure_ranked_schema()
		expect(console.warn).not.toHaveBeenCalled()
	})

	test('warns on an unrelated ALTER failure but does not throw', async () => {
		state.alterError = new Error('connection refused')
		await expect(ensure_ranked_schema()).resolves.toBeUndefined()
		expect(console.warn).toHaveBeenCalledWith(
			'[ranked migration]',
			'connection refused'
		)
	})

	test('reactivates the most recent season when none is currently active', async () => {
		state.activeSeason = null
		state.anySeason = { season_id: 4 }
		await ensure_ranked_schema()
		expect(state.reactivated).toBe(true)
		expect(state.inserted).toBeUndefined()
	})

	test('creates Season 1 when there is no season at all', async () => {
		state.activeSeason = null
		state.anySeason = null
		await ensure_ranked_schema()
		expect(state.inserted).toBe(true)
	})
})
