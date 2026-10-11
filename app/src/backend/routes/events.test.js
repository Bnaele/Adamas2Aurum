import { jest } from '@jest/globals'

jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn(), getConnection: jest.fn() },
}))

const { default: pool } = await import('../utils/db.js')
const { default: eventsRouter } = await import('./events.js')
import express from 'express'
import { createServer } from 'http'

function makeApp(sessionUser = { user_id: 1 }) {
	const session = sessionUser ? { user: sessionUser } : {}
	const app = express()
	app.use(express.json())
	app.use((req, _res, next) => {
		req.session = session
		if (sessionUser) req.user = sessionUser
		else req.user = null
		next()
	})
	app.use('/api/events', eventsRouter)
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

describe('GET /api/events (public)', () => {
	beforeEach(() => pool.query.mockReset())
	test('public returns only PUBLISHED when curation column exists', async () => {
		// hasCurationColumn -> SHOW COLUMNS returns 1 row
		// then public SELECT returns filtered rows
		pool.query
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn
			.mockResolvedValueOnce([
				[{ event_id: 1, title: 'Pub' }],
			]) // public select
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].event_id).toBe(1)
		})
		// ensure curation filter was used (check SQL contains curation_status)
		const secondCall = pool.query.mock.calls[1][0]
		expect(secondCall).toMatch(/curation_status = 'PUBLISHED'/)
	})
	test('falls back when curation column missing', async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // hasCurationColumn false
			.mockResolvedValueOnce([[{ event_id: 2 }]])
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`)
			expect(res.status).toBe(200)
		})
		const sql = pool.query.mock.calls[1][0]
		expect(sql).not.toMatch(/curation_status/)
	})
	test('GET ?all=true requires auth', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events?all=true`)
			expect(res.status).toBe(401)
		})
	})
	test('GET ?all=true forbids non-author', async () => {
		pool.query.mockResolvedValueOnce([[]]) // roles check empty
		const app = makeApp({ user_id: 5 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events?all=true`)
			expect(res.status).toBe(403)
		})
	})
	test('anonymous list has no completion query and no flags', async () => {
		pool.query
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[{ event_id: 1, title: 'Pub' }],
			])
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0]).not.toHaveProperty('completed')
		})
		expect(pool.query).toHaveBeenCalledTimes(2)
	})
	test('logged-in list carries completed flags from verified wins', async () => {
		pool.query
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[
					{ event_id: 1, title: 'Done' },
					{ event_id: 2, title: 'Todo' },
				],
			])
			.mockResolvedValueOnce([
				[
					{
						event_id: 1,
						completed_at:
							'2026-09-01 10:00:00',
					},
				],
			])
		const app = makeApp({ user_id: 7 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0].completed).toBe(true)
			expect(body[0].completed_at).toBe('2026-09-01 10:00:00')
			expect(body[1].completed).toBe(false)
		})
		// completion query joins attempts to verified location checks only
		const completionSql = pool.query.mock.calls[2][0]
		expect(completionSql).toMatch(/location_check_log/)
		expect(completionSql).toMatch(/VERIFIED/)
		expect(completionSql).toMatch(/event_card_awards/)
	})
	test('logged-in list still 200 when completion query fails (fail-open)', async () => {
		pool.query
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[{ event_id: 1, title: 'Pub' }],
			])
			.mockRejectedValueOnce(new Error('no such table'))
		const app = makeApp({ user_id: 7 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})
	})
})

describe('POST /api/events', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'T',
					latitude: 1,
					longitude: 1,
					radius_meters: 50,
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('400 when required fields missing', async () => {
		// auth ok, author ok
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]]) // requireEventAuthor
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: '' }),
			})
			expect(res.status).toBe(400)
		})
	})
	test('400 for invalid curation_status', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'T',
					latitude: 1,
					longitude: 1,
					radius_meters: 50,
					curation_status: 'BAD',
				}),
			})
			expect(res.status).toBe(400)
		})
	})
	test('201 creates with DRAFT default, both columns present', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn
			.mockResolvedValueOnce([[{ Field: 'campaign_id' }]]) // hasCampaignColumn
			.mockResolvedValueOnce([{ insertId: 42 }]) // insert
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'T',
					latitude: 1,
					longitude: 1,
					radius_meters: 50,
				}),
			})
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.event_id).toBe(42)
		})
		const insertSql = pool.query.mock.calls[3][0]
		expect(insertSql).toMatch(/curation_status/)
		expect(insertSql).toMatch(/campaign_id/)
	})
})

describe('PUT /api/events/:id transition validation', () => {
	beforeEach(() => pool.query.mockReset())
	test('rejects invalid transition via PUT', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn first (validation)
			.mockResolvedValueOnce([[{ curation_status: 'DRAFT' }]]) // SELECT current
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn second
			.mockResolvedValueOnce([[{ Field: 'campaign_id' }]]) // hasCampaignColumn
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events/1`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'T',
					latitude: 1,
					longitude: 1,
					radius_meters: 50,
					curation_status: 'PUBLISHED',
				}),
			})
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toMatch(
				/Invalid transition DRAFT → PUBLISHED/
			)
		})
	})
	test('allows valid DRAFT→IN_REVIEW via PUT', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([[{ curation_status: 'DRAFT' }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([[{ Field: 'campaign_id' }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // update
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/events/1`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'T',
					latitude: 1,
					longitude: 1,
					radius_meters: 50,
					curation_status: 'IN_REVIEW',
				}),
			})
			expect(res.status).toBe(200)
		})
	})
})

describe('POST /api/events/:id/transition', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/1/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'IN_REVIEW',
					}),
				}
			)
			expect(res.status).toBe(401)
		})
	})
	test('400 for invalid target', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]]) // author
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/1/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({ to: 'BAD' }),
				}
			)
			expect(res.status).toBe(400)
		})
	})
	test('403 when not author', async () => {
		pool.query.mockResolvedValueOnce([[]]) // author fails
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/1/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'IN_REVIEW',
					}),
				}
			)
			expect(res.status).toBe(403)
		})
	})
	test('400 when curation not enabled', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[]]) // hasCurationColumn false
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/1/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'IN_REVIEW',
					}),
				}
			)
			expect(res.status).toBe(400)
		})
	})
	test('200 transitions DRAFT→IN_REVIEW', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn
			.mockResolvedValueOnce([[{ curation_status: 'DRAFT' }]]) // current
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // update
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'IN_REVIEW',
					}),
				}
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.message).toMatch(/DRAFT → IN_REVIEW/)
		})
	})
	test('400 invalid transition RETIRED→IN_REVIEW', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[{ curation_status: 'RETIRED' }],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'IN_REVIEW',
					}),
				}
			)
			expect(res.status).toBe(400)
		})
	})
	test('400 publishing without questions', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[{ curation_status: 'IN_REVIEW' }],
			])
			.mockResolvedValueOnce([[{ c: 0 }]]) // count questions
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						to: 'PUBLISHED',
					}),
				}
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toMatch(
				/without at least one question/
			)
		})
	})
	test('200 already in target returns message', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([[{ curation_status: 'DRAFT' }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/transition`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({ to: 'DRAFT' }),
				}
			)
			expect(res.status).toBe(200)
			expect((await res.json()).message).toMatch(
				/Already DRAFT/
			)
		})
	})
})

describe('POST /api/events/:id/retire', () => {
	beforeEach(() => pool.query.mockReset())
	test('retires event', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn
			.mockResolvedValueOnce([
				[{ curation_status: 'PUBLISHED' }],
			]) // select
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // update
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/retire`,
				{ method: 'POST' }
			)
			expect(res.status).toBe(200)
		})
		const sql = pool.query.mock.calls[3][0]
		expect(sql).toMatch(/RETIRED/)
	})
	test('404 when not found', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([[]]) // not found
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/999/retire`,
				{ method: 'POST' }
			)
			expect(res.status).toBe(404)
		})
	})
	test('400 when retiring a non-published event', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // author
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]]) // hasCurationColumn
			.mockResolvedValueOnce([[{ curation_status: 'DRAFT' }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/retire`,
				{ method: 'POST' }
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toMatch(/Only PUBLISHED/)
		})
		// No UPDATE issued for an invalid transition
		expect(pool.query).toHaveBeenCalledTimes(3)
	})
	test('200 idempotent when already retired', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ Field: 'curation_status' }]])
			.mockResolvedValueOnce([
				[{ curation_status: 'RETIRED' }],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/events/10/retire`,
				{ method: 'POST' }
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.message).toMatch(/Already RETIRED/)
		})
	})
})
