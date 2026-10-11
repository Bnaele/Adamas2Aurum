import { jest } from '@jest/globals'
jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))
const { default: pool } = await import('../utils/db.js')
const {
	recommendTier,
	getFlaggedPlayers,
	getTrustScoreForUser,
	setTrustScore,
	computeTrustScore,
	FLAGGED_THRESHOLD,
	TIER_THRESHOLDS,
} = await import('./trust_score.js')

describe('recommendTier', () => {
	test('null when score is NaN or at/above the flagged threshold', () => {
		expect(recommendTier(NaN)).toBeNull()
		expect(recommendTier('not-a-number')).toBeNull()
		expect(recommendTier(FLAGGED_THRESHOLD)).toBeNull()
		expect(recommendTier(95)).toBeNull()
	})
	test('score < 25 always escalates to SUSPENSION', () => {
		expect(recommendTier(0)).toBe('SUSPENSION')
		expect(recommendTier(24.9)).toBe('SUSPENSION')
		// even with prior warnings, suspension stands
		expect(recommendTier(10, [{ action_type: 'WARNING' }])).toBe(
			'SUSPENSION'
		)
	})
	test('25 ≤ score < 50: RESTRICTION, escalating to SUSPENSION after a prior restriction', () => {
		expect(recommendTier(49)).toBe('RESTRICTION')
		expect(recommendTier(30)).toBe('RESTRICTION')
		expect(
			recommendTier(40, [{ action_type: 'RESTRICTION' }])
		).toBe('SUSPENSION')
		// prior warnings alone don't escalate this band
		expect(recommendTier(40, [{ action_type: 'WARNING' }])).toBe(
			'RESTRICTION'
		)
	})
	test('50 ≤ score < 70: WARNING, escalating per prior actions', () => {
		expect(recommendTier(69)).toBe('WARNING')
		expect(recommendTier(50)).toBe('WARNING')
		expect(recommendTier(60, [{ action_type: 'WARNING' }])).toBe(
			'RESTRICTION'
		)
		expect(
			recommendTier(60, [{ action_type: 'RESTRICTION' }])
		).toBe('SUSPENSION')
		// prior actions of other shapes are ignored
		expect(recommendTier(60, [{ action_type: 'NOTE' }])).toBe(
			'WARNING'
		)
	})
	test('thresholds are the documented rubric values', () => {
		expect(TIER_THRESHOLDS).toEqual({
			WARNING: 70,
			RESTRICTION: 50,
			SUSPENSION: 30,
		})
	})
})

describe('getFlaggedPlayers', () => {
	beforeEach(() => pool.query.mockReset())
	test('enriches rows with prior actions, live evidence and recommendation', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ Field: 'moderation_status' }],
			]) // SHOW COLUMNS
			.mockResolvedValueOnce([
				[
					{
						user_id: 2,
						name: 'Bob',
						email: 'bob@example.com',
						avatar_url: null,
						points: 90,
						moderation_status: 'WARNED',
						moderation_expires_at: null,
						trust_score: 22.5,
						evidence: JSON.stringify([
							{
								type: 'SPOOFED_LOCATION',
							},
						]),
						reason: 'spoof',
						updated_at: '2026-01-04T10:00:00Z',
					},
				],
			]) // flagged query
			.mockResolvedValueOnce([
				[{ action_id: 1, action_type: 'RESTRICTION' }],
			]) // prior for user 2
			.mockResolvedValueOnce([
				[
					{
						check_id: 7,
						event_id: 1,
						distance_meters: '5',
						status: 'SPOOFED',
						travel_speed_ms: '1000',
						checked_at: '2026-01-04T09:00:00Z',
					},
				],
			]) // live evidence for user 2
		const players = await getFlaggedPlayers(pool)
		expect(players).toHaveLength(1)
		const p = players[0]
		expect(p.trust_score).toBe(22.5)
		expect(p.prior_count).toBe(1)
		expect(p.recommended_action).toBe('SUSPENSION') // 22.5 < 25
		// stored + live evidence merged, numbers converted
		expect(p.evidence).toEqual([
			{ type: 'SPOOFED_LOCATION' },
			{
				type: 'SPOOFED_LOCATION',
				check_id: 7,
				event_id: 1,
				distance_meters: 5,
				travel_speed_ms: 1000,
				status: 'SPOOFED',
				checked_at: '2026-01-04T09:00:00Z',
			},
		])
		// hasModerationCols=true → SELECT includes the moderation columns
		const flaggedSql = pool.query.mock.calls[1][0]
		expect(flaggedSql).toMatch(/u\.moderation_status/)
	})
	test('falls back to no-moderation-columns SELECT on pre-migration DBs', async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // SHOW COLUMNS: empty → no cols
			.mockResolvedValueOnce([
				[
					{
						user_id: 3,
						name: 'Cara',
						email: 'cara@example.com',
						avatar_url: null,
						points: 10,
						trust_score: 60,
						evidence: null,
						reason: null,
						updated_at: '2026-01-05T09:00:00Z',
					},
				],
			])
			.mockResolvedValueOnce([[]]) // prior
			.mockResolvedValueOnce([[]]) // live evidence
		const players = await getFlaggedPlayers(pool)
		expect(players).toHaveLength(1)
		expect(players[0].moderation_status).toBe('NONE')
		expect(players[0].evidence).toEqual([])
		expect(players[0].recommended_action).toBe('WARNING')
		const flaggedSql = pool.query.mock.calls[1][0]
		expect(flaggedSql).not.toMatch(/moderation_status/)
	})
	test('object evidence is wrapped into an array; malformed JSON dropped', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ Field: 'moderation_status' }],
			])
			.mockResolvedValueOnce([
				[
					{
						user_id: 4,
						name: 'Dan',
						email: 'dan@example.com',
						avatar_url: null,
						points: 5,
						moderation_status: 'NONE',
						moderation_expires_at: null,
						trust_score: 45,
						evidence: {
							type: 'OBJECT_EVIDENCE',
						}, // object, not string
						reason: null,
						updated_at: '2026-01-06T09:00:00Z',
					},
					{
						user_id: 5,
						name: 'Eve',
						email: 'eve@example.com',
						avatar_url: null,
						points: 5,
						moderation_status: 'NONE',
						moderation_expires_at: null,
						trust_score: 45,
						evidence: 'not-json{',
						reason: null,
						updated_at: '2026-01-06T09:00:00Z',
					},
				],
			])
			.mockResolvedValueOnce([[]]) // prior Dan
			.mockResolvedValueOnce([[]]) // live Dan
			.mockResolvedValueOnce([[]]) // prior Eve
			.mockResolvedValueOnce([[]]) // live Eve
		const players = await getFlaggedPlayers(pool)
		expect(players[0].evidence).toEqual([
			{ type: 'OBJECT_EVIDENCE' },
		])
		expect(players[1].evidence).toEqual([])
	})
	test('threshold and limit are passed through to the query (limit capped at 100)', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ Field: 'moderation_status' }],
			])
			.mockResolvedValueOnce([[]])
		await getFlaggedPlayers(pool, { threshold: 50, limit: 500 })
		const [sql, params] = pool.query.mock.calls[1]
		expect(sql).toMatch(/WHERE uts\.trust_score < \?/)
		expect(params).toEqual([50, 100])
	})
})

describe('getTrustScoreForUser / setTrustScore', () => {
	beforeEach(() => pool.query.mockReset())
	test('getTrustScoreForUser returns the row or null', async () => {
		const row = {
			trust_score: 42,
			evidence: '[]',
			reason: 'r',
			updated_at: '2026-01-01T00:00:00Z',
		}
		pool.query
			.mockResolvedValueOnce([[row]])
			.mockResolvedValueOnce([[]])
		expect(await getTrustScoreForUser(pool, 2)).toEqual(row)
		expect(await getTrustScoreForUser(pool, 99)).toBeNull()
		expect(pool.query.mock.calls[0][1]).toEqual([2])
	})
	test('setTrustScore upserts with JSON-serialised evidence', async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }])
		await setTrustScore(pool, 2, 42, [{ type: 'SPOOFED' }], 'why')
		const [sql, params] = pool.query.mock.calls[0]
		expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/)
		expect(params).toEqual([
			2,
			42,
			JSON.stringify([{ type: 'SPOOFED' }]),
			'why',
		])
		// null evidence → null, not the string "null"
		pool.query.mockReset()
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }])
		await setTrustScore(pool, 2, 42)
		expect(pool.query.mock.calls[0][1][2]).toBeNull()
	})
	test('computeTrustScore is a stub until the real scorer lands', async () => {
		expect(await computeTrustScore(pool, 1)).toBeNull()
	})
})
