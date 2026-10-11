import { jest } from '@jest/globals'
jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))
const { default: pool } = await import('../utils/db.js')
const { default: analyticsRouter } = await import('./analytics.js')
import express from 'express'
import { createServer } from 'http'

function makeApp(sessionUser = { user_id: 1 }) {
	const session = sessionUser ? { user: sessionUser } : {}
	const app = express()
	app.use(express.json())
	app.use((req, _res, next) => {
		req.session = session
		req.user = sessionUser
		next()
	})
	app.use('/api/analytics', analyticsRouter)
	return app
}
async function withServer(app, fn) {
	const server = createServer(app)
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const { port } = server.address()
	try {
		await fn(`http://127.0.0.1:${port}`)
	} finally {
		await new Promise((r) => server.close(r))
	}
}

describe('GET /api/analytics/questions/hard', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/hard`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not author', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/hard`
			)
			expect(res.status).toBe(403)
		})
	})
	test('200 returns hard questions with options', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{
						id: 1,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Q?',
						event_title: 'E',
						attempts: '10',
						wrong: '8',
						correct: '2',
						failure_rate: '0.8',
					},
				],
			]) // main query
			.mockResolvedValueOnce([
				[
					{
						option_id: 1,
						body: 'A',
						is_correct: 1,
					},
					{
						option_id: 2,
						body: 'B',
						is_correct: 0,
					},
				],
			]) // options for q1
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/hard?threshold=0.6&min_attempts=5`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].failure_rate).toBe(0.8)
			expect(body[0].options).toHaveLength(2)
		})
	})
	test('empty when no hard questions', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/hard`
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		})
	})
})

describe('GET /api/analytics/events/stale', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/events/stale`
			)
			expect(res.status).toBe(401)
		})
	})
	test('200 returns stale list', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([
				[
					{
						event_id: 1,
						title: 'Old',
						curation_status: 'PUBLISHED',
						days_since_end: 45,
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/events/stale?days=30`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].event_id).toBe(1)
		})
	})
})

describe('GET /api/analytics/overview', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/overview`
			)
			expect(res.status).toBe(401)
		})
	})
	test('200 overview', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{ status: 'PUBLISHED', count: 5 },
					{ status: 'DRAFT', count: 2 },
				],
			]) // statusCounts
			.mockResolvedValueOnce([
				[{ status: 'ACTIVE', count: 1 }],
			]) // campaignCounts
			.mockResolvedValueOnce([[{ hard_questions: 3 }]]) // hard
			.mockResolvedValueOnce([[{ stale: 1 }]]) // stale
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/overview`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.hard_questions).toBe(3)
			expect(body.stale_events).toBe(1)
			expect(body.statusCounts).toHaveLength(2)
		})
	})
	test('best-effort rollups succeed when tables exist', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[{ status: 'PUBLISHED', count: 5 }],
			])
			.mockResolvedValueOnce([
				[{ status: 'ACTIVE', count: 1 }],
			])
			.mockResolvedValueOnce([[{ hard_questions: 3 }]])
			.mockResolvedValueOnce([[{ stale: 1 }]])
			.mockResolvedValueOnce([[{ easy_questions: 2 }]])
			.mockResolvedValueOnce([
				[{ total_attempts: 40, active_events: 7 }],
			])
			.mockResolvedValueOnce([[{ total_awards: 12 }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/overview`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.easy_questions).toBe(2)
			expect(body.total_attempts).toBe(40)
			expect(body.total_awards).toBe(12)
		})
	})
	test('best-effort rollups null out on old DBs (query throws)', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[{ status: 'PUBLISHED', count: 5 }],
			])
			.mockResolvedValueOnce([
				[{ status: 'ACTIVE', count: 1 }],
			])
			.mockResolvedValueOnce([[{ hard_questions: 3 }]])
			.mockResolvedValueOnce([[{ stale: 1 }]])
			.mockRejectedValueOnce(new Error('no table'))
			.mockRejectedValueOnce(new Error('no table'))
			.mockRejectedValueOnce(new Error('no table'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/overview`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.easy_questions).toBeNull()
			expect(body.total_attempts).toBeNull()
			expect(body.total_awards).toBeNull()
		})
	})
	test('500 when a required query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockRejectedValueOnce(new Error('boom'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/overview`
			)
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe('boom')
		})
	})
})

describe('GET /api/analytics/engagement', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not author', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement`
			)
			expect(res.status).toBe(403)
		})
	})
	test('200 returns rows with numbers converted', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{
						event_id: 1,
						title: 'Origins',
						attempts: '10',
						unique_players: '4',
						correct: '7',
						correct_rate: '0.7',
						visits: '9',
						unique_visitors: '5',
					},
					{
						event_id: 2,
						title: 'Empty',
						attempts: '0',
						unique_players: '0',
						correct: '0',
						correct_rate: null,
						visits: '0',
						unique_visitors: '0',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].attempts).toBe(10)
			expect(body[0].correct_rate).toBe(0.7)
			expect(body[0].visits).toBe(9)
			expect(body[1].correct_rate).toBeNull()
		})
	})
	test('sort/order whitelist: known key and asc honoured', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement?sort=unique_players&order=asc`
			)
			expect(res.status).toBe(200)
			const sql = pool.query.mock.calls[1][0]
			expect(sql).toMatch(/ORDER BY unique_players ASC/)
		})
	})
	test('bogus sort key falls back to attempts DESC, limit capped at 200', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement?sort=evil;DROP TABLE users&order=sideways&limit=99999`
			)
			expect(res.status).toBe(200)
			const [sql, params] = pool.query.mock.calls[1]
			expect(sql).toMatch(/ORDER BY attempts DESC/)
			expect(sql).not.toMatch(/evil/)
			expect(params[0]).toBe(200)
		})
	})
	test('500 when query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockRejectedValueOnce(new Error('db down'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/engagement`
			)
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe('db down')
		})
	})
})

describe('GET /api/analytics/questions/difficulty', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not author', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty`
			)
			expect(res.status).toBe(403)
		})
	})
	test('200 flags every bucket: TOO_HARD, TOO_EASY, OK, IGNORED', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{
						id: 1,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Hard one',
						event_title: 'E',
						attempts: '10',
						correct: '2',
						wrong: '8',
						correct_rate: '0.2',
						failure_rate: '0.8',
					},
					{
						id: 2,
						event_id: 1,
						type: 'TRUE_FALSE',
						text: 'Easy one',
						event_title: 'E',
						attempts: '10',
						correct: '9',
						wrong: '1',
						correct_rate: '0.9',
						failure_rate: '0.1',
					},
					{
						id: 3,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Fine one',
						event_title: 'E',
						attempts: '10',
						correct: '5',
						wrong: '5',
						correct_rate: '0.5',
						failure_rate: '0.5',
					},
					{
						id: 4,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Never answered',
						event_title: 'E',
						attempts: '0',
						correct: '0',
						wrong: '0',
						correct_rate: null,
						failure_rate: null,
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			const flags = Object.fromEntries(
				body.map((q) => [q.text, q.flag])
			)
			expect(flags['Hard one']).toBe('TOO_HARD')
			expect(flags['Easy one']).toBe('TOO_EASY')
			expect(flags['Fine one']).toBe('OK')
			expect(flags['Never answered']).toBe('IGNORED')
			expect(
				body.find((q) => q.text === 'Never answered')
					.correct_rate
			).toBeNull()
		})
	})
	test('flag=too_hard filters to that bucket only', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{
						id: 1,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Hard one',
						event_title: 'E',
						attempts: '10',
						correct: '2',
						wrong: '8',
						correct_rate: '0.2',
						failure_rate: '0.8',
					},
					{
						id: 2,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Easy one',
						event_title: 'E',
						attempts: '10',
						correct: '9',
						wrong: '1',
						correct_rate: '0.9',
						failure_rate: '0.1',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty?flag=too_hard`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].flag).toBe('TOO_HARD')
		})
	})
	test('unknown flag value returns all rows unfiltered', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([
				[
					{
						id: 1,
						event_id: 1,
						type: 'MULTIPLE_CHOICE',
						text: 'Q',
						event_title: 'E',
						attempts: '10',
						correct: '2',
						wrong: '8',
						correct_rate: '0.2',
						failure_rate: '0.8',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty?flag=nonsense`
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toHaveLength(1)
		})
	})
	test('defaults: sort correct_rate ASC, min_attempts floors at 0, limit capped at 200', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/questions/difficulty?min_attempts=-5&limit=99999&sort=DROP TABLE`
			)
			expect(res.status).toBe(200)
			const [sql, params] = pool.query.mock.calls[1]
			expect(sql).toMatch(/ORDER BY correct_rate ASC/)
			expect(sql).not.toMatch(/DROP TABLE/)
			expect(params[0]).toBe(0)
			expect(params[1]).toBe(200)
		})
	})
})

describe('GET /api/analytics/cards/drop-rates', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not author', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates`
			)
			expect(res.status).toBe(403)
		})
	})
	test('400 when event_id is not an integer', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]]) // author
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates?event_id=abc`
			)
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/integer/)
		})
	})
	test('200 global view (no event_id): drift math over all awards', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ total: 10 }]]) // total awards
			.mockResolvedValueOnce([[{ total_weight: 20 }]]) // total weight
			.mockResolvedValueOnce([
				[
					{
						card_id: 1,
						name: 'Gold Rhino',
						rarity: 'LEGENDARY',
						category: 'RELIC',
						configured_weight: '5',
						sample_copy_limit: 2,
						pool_copies_awarded: '1',
						times_awarded: '3',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.total_awards).toBe(10)
			expect(body.total_weight).toBe(20)
			expect(body.event_id).toBeNull()
			const card = body.cards[0]
			expect(card.times_awarded).toBe(3)
			expect(card.actual_rate).toBe(0.3)
			expect(card.expected_rate).toBe(0.25)
			expect(card.drift).toBe(0.05)
			// no event_id → aggregate SQL has no per-event filters
			const rowsSql = pool.query.mock.calls[3][0]
			expect(rowsSql).not.toMatch(/eca\.event_id = \?/)
		})
	})
	test('200 per-event view: event filters applied and passed as params', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ total: 4 }]])
			.mockResolvedValueOnce([[{ total_weight: 8 }]])
			.mockResolvedValueOnce([
				[
					{
						card_id: 2,
						name: 'Silver Key',
						rarity: 'COMMON',
						category: 'TOOL',
						configured_weight: '8',
						sample_copy_limit: null,
						pool_copies_awarded: '0',
						times_awarded: '4',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates?event_id=7&limit=500`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.event_id).toBe(7)
			expect(body.cards[0].expected_rate).toBe(1)
			// event-scoped queries pass the event id
			expect(pool.query.mock.calls[1][1]).toEqual([7])
			const rowsSql = pool.query.mock.calls[3][0]
			expect(rowsSql).toMatch(/p\.event_id = \?/)
			expect(rowsSql).toMatch(/eca\.event_id = \?/)
			expect(pool.query.mock.calls[3][1]).toEqual([7, 7, 500])
		})
	})
	test('zero totals: rates 0 / expected+drift null (unconfigured pool)', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ total: 0 }]])
			.mockResolvedValueOnce([[{ total_weight: 0 }]])
			.mockResolvedValueOnce([
				[
					{
						card_id: 1,
						name: 'Ghost Card',
						rarity: 'COMMON',
						category: 'RELIC',
						configured_weight: '0',
						sample_copy_limit: null,
						pool_copies_awarded: '0',
						times_awarded: '0',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates`
			)
			expect(res.status).toBe(200)
			const card = (await res.json()).cards[0]
			expect(card.actual_rate).toBe(0)
			expect(card.expected_rate).toBeNull()
			expect(card.drift).toBeNull()
		})
	})
	test('500 when a query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockRejectedValueOnce(new Error('boom'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/analytics/cards/drop-rates`
			)
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe('boom')
		})
	})
})
