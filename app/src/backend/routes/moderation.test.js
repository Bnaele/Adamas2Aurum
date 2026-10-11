import { jest } from '@jest/globals'
jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn(), getConnection: jest.fn() },
}))
const { default: pool } = await import('../utils/db.js')
const { default: moderationRouter } = await import('./moderation.js')
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
	app.use('/api/moderation', moderationRouter)
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

describe('GET /api/moderation/flagged', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/flagged`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not moderator', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/flagged`
			)
			expect(res.status).toBe(403)
		})
	})
	test('200 returns flagged sorted by trust_score ASC with evidence', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator check
			.mockResolvedValueOnce([
				[{ moderation_status: 'NONE' }],
			]) // SHOW COLUMNS for hasModerationCols
			.mockResolvedValueOnce([
				[
					{
						user_id: 2,
						name: 'Bob',
						email: 'bob@example.com',
						avatar_url: null,
						points: 90,
						moderation_status: 'NONE',
						moderation_expires_at: null,
						trust_score: 22.5,
						evidence: JSON.stringify([
							{
								type: 'SPOOFED_LOCATION',
								detail: 'spoof',
							},
						]),
						reason: 'spoof',
						updated_at: '2026-01-04T10:00:00Z',
					},
					{
						user_id: 4,
						name: 'Player',
						email: 'player@example.com',
						avatar_url: null,
						points: 10,
						moderation_status: 'WARNED',
						moderation_expires_at: null,
						trust_score: 44,
						evidence: JSON.stringify([]),
						reason: 'velocity',
						updated_at: '2026-01-05T09:00:00Z',
					},
				],
			]) // flagged query
			.mockResolvedValueOnce([[]]) // prior for 2
			.mockResolvedValueOnce([[]]) // live evidence for 2
			.mockResolvedValueOnce([[]]) // prior for 4
			.mockResolvedValueOnce([[]]) // live evidence for 4

		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/flagged`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0].trust_score).toBe(22.5)
			expect(body[1].trust_score).toBe(44)
			// sorted lowest first
			expect(body[0].user_id).toBe(2)
			expect(body[0].evidence).toBeDefined()
			expect(body[0].recommended_action).toBe('SUSPENSION')
			expect(body[1].recommended_action).toBe('RESTRICTION')
		})
	})
})

describe('POST /api/moderation/action', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(401)
		})
	})
	test('400 when invalid tier', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'BAN',
					}),
				}
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toMatch(/must be one of/)
		})
	})
	test('400 when moderating self', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 1,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(
				/cannot moderate yourself/i
			)
		})
	})
	test('201 applies graduated action (warning → restriction → suspension)', async () => {
		// mock moderator check
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]])
		// target exists
		pool.query.mockResolvedValueOnce([[{ user_id: 2 }]])
		// prior actions
		pool.query.mockResolvedValueOnce([[]])
		// trust_score
		pool.query.mockResolvedValueOnce([[{ trust_score: 22.5 }]])
		// transaction getConnection
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 10 }]) // INSERT action
				.mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE users
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)

		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
						reason: 'First warning',
					}),
				}
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.action_type).toBe('WARNING')
			expect(body.target_user_id).toBe(2)
		})
		pool.getConnection.mockReset()
	})
	test('400 when fields missing', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						reason: 'no ids',
					}),
				}
			)
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/required/)
		})
	})
	test('400 when target_user_id is not an integer', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 'abc',
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/integer/)
		})
	})
	test('404 when target user not found', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([[]]) // target lookup: no rows
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 99,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(404)
			expect((await res.json()).error).toMatch(/not found/i)
		})
	})
	test('RESTRICTION defaults to 3 days and computes a UTC expiry', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator
			.mockResolvedValueOnce([[{ user_id: 2 }]]) // target
			.mockResolvedValueOnce([[]]) // prior
			.mockResolvedValueOnce([[{ trust_score: 22.5 }]]) // trust
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 11 }])
				.mockResolvedValueOnce([{ affectedRows: 1 }]),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'RESTRICTION',
					}),
				}
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.duration_days).toBe(3)
			expect(body.expires_at).toMatch(
				/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
			)
			// users.moderation_status set to RESTRICTED with same expiry
			const updateCall = mockConn.query.mock.calls[1]
			expect(updateCall[0]).toMatch(
				/UPDATE users SET moderation_status/
			)
			expect(updateCall[1][0]).toBe('RESTRICTED')
			expect(updateCall[1][1]).toBe(body.expires_at)
		})
		pool.getConnection.mockReset()
	})
	test('explicit duration_days honoured; out-of-range values rejected', async () => {
		// valid explicit duration
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 2 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ trust_score: 22.5 }]])
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 12 }])
				.mockResolvedValueOnce([{ affectedRows: 1 }]),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'SUSPENSION',
						duration_days: 30,
					}),
				}
			)
			expect(res.status).toBe(201)
			expect((await res.json()).duration_days).toBe(30)
		})
		pool.getConnection.mockReset()

		// 0 and 91 are outside the 1–90 window
		for (const bad of [0, 91]) {
			pool.query.mockReset()
			pool.query
				.mockResolvedValueOnce([[{ 1: 1 }]])
				.mockResolvedValueOnce([[{ user_id: 2 }]])
				.mockResolvedValueOnce([[]])
				.mockResolvedValueOnce([
					[{ trust_score: 22.5 }],
				])
			await withServer(
				makeApp({ user_id: 1 }),
				async (base) => {
					const res = await fetch(
						`${base}/api/moderation/action`,
						{
							method: 'POST',
							headers: {
								'Content-Type':
									'application/json',
							},
							body: JSON.stringify({
								target_user_id: 2,
								action_type:
									'RESTRICTION',
								duration_days:
									bad,
							}),
						}
					)
					expect(res.status).toBe(400)
					expect(
						(await res.json()).error
					).toMatch(/1-90/)
				}
			)
		}
	})
	test('WARNING forces duration/expiry to null even when duration_days passed', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 2 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ trust_score: 75 }]]) // above threshold → no recommendation
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 13 }])
				.mockResolvedValueOnce([{ affectedRows: 1 }]),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
						duration_days: 10,
					}),
				}
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.duration_days).toBeNull()
			expect(body.expires_at).toBeNull()
			expect(body.recommended_action).toBeNull()
		})
		pool.getConnection.mockReset()
	})
	test('graduated_hint when applied tier exceeds recommendation', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 2 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ trust_score: 45 }]]) // → recommends RESTRICTION
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 14 }])
				.mockResolvedValueOnce([{ affectedRows: 1 }]),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'SUSPENSION',
					}),
				}
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.recommended_action).toBe('RESTRICTION')
			expect(body.graduated_hint).toMatch(/RESTRICTION/)
			expect(body.duration_days).toBe(7) // SUSPENSION default
		})
		pool.getConnection.mockReset()
	})
	test('Unknown-column UPDATE failure is swallowed; action still recorded', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 2 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ trust_score: 22.5 }]])
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ insertId: 15 }])
				.mockRejectedValueOnce(
					new Error(
						"Unknown column 'moderation_status' in 'field list'"
					)
				),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(201)
			expect(mockConn.commit).toHaveBeenCalled()
			expect(mockConn.rollback).not.toHaveBeenCalled()
		})
		pool.getConnection.mockReset()
	})
	test('INSERT failure rolls back the transaction and returns 500', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 2 }]])
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([[{ trust_score: 22.5 }]])
		const mockConn = {
			beginTransaction: jest.fn(),
			query: jest
				.fn()
				.mockRejectedValueOnce(
					new Error('insert failed')
				),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
		}
		pool.getConnection = jest.fn().mockResolvedValue(mockConn)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe('insert failed')
			expect(mockConn.rollback).toHaveBeenCalled()
			expect(mockConn.commit).not.toHaveBeenCalled()
			expect(mockConn.release).toHaveBeenCalled()
		})
		pool.getConnection.mockReset()
	})
	test('500 when moderator role check itself fails', async () => {
		pool.query.mockRejectedValueOnce(new Error('db down'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/action`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						target_user_id: 2,
						action_type: 'WARNING',
					}),
				}
			)
			expect(res.status).toBe(500)
		})
	})
})

describe('POST /api/moderation/trust-score', () => {
	beforeEach(() => pool.query.mockReset())
	test('400 when user_id or trust_score missing', async () => {
		pool.query.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-score`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({ user_id: 3 }),
				}
			)
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/required/)
		})
	})
	test('400 when trust_score out of range or not finite', async () => {
		pool.query.mockResolvedValue([[{ 1: 1 }]]) // moderator ok (all attempts)
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			for (const bad of [-1, 101, 'abc']) {
				const res = await fetch(
					`${base}/api/moderation/trust-score`,
					{
						method: 'POST',
						headers: {
							'Content-Type':
								'application/json',
						},
						body: JSON.stringify({
							user_id: 3,
							trust_score: bad,
						}),
					}
				)
				expect(res.status).toBe(400)
				expect((await res.json()).error).toMatch(
					/0-100/
				)
			}
		})
	})
	test('404 when user does not exist', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([[]]) // user lookup
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-score`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						user_id: 42,
						trust_score: 55,
					}),
				}
			)
			expect(res.status).toBe(404)
		})
	})
	test('200 upserts score with evidence JSON and echoes the score', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([[{ user_id: 3 }]]) // user exists
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // upsert
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-score`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						user_id: 3,
						trust_score: 55,
						evidence: [
							{
								type: 'SPOOFED_LOCATION',
							},
						],
						reason: 'testing',
					}),
				}
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.trust_score).toBe(55)
			const upsertCall = pool.query.mock.calls[2]
			expect(upsertCall[0]).toMatch(/ON DUPLICATE KEY UPDATE/)
			expect(upsertCall[1]).toEqual([
				3,
				55,
				JSON.stringify([{ type: 'SPOOFED_LOCATION' }]),
				'testing',
			])
		})
	})
	test('500 when upsert fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockResolvedValueOnce([[{ user_id: 3 }]])
			.mockRejectedValueOnce(new Error('boom'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-score`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						user_id: 3,
						trust_score: 55,
					}),
				}
			)
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe('boom')
		})
	})
})

describe('GET /api/moderation/actions', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp(null)
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/actions`
			)
			expect(res.status).toBe(401)
		})
	})
	test('403 when not moderator', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user_id: 2 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/actions`
			)
			expect(res.status).toBe(403)
		})
	})
	test('200 parses evidence JSON, keeps malformed raw, caps limit at 100', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([
				[
					{
						action_id: 1,
						target_user_id: 2,
						moderator_id: 1,
						action_type: 'WARNING',
						reason: 'spoofing',
						evidence: JSON.stringify([
							{
								type: 'SPOOFED_LOCATION',
							},
						]),
						duration_days: null,
						expires_at: null,
						created_at: '2026-01-01T10:00:00Z',
						target_name: 'Bob',
						target_email: 'bob@example.com',
						moderator_name: 'Mod',
					},
					{
						action_id: 2,
						target_user_id: 3,
						moderator_id: 1,
						action_type: 'RESTRICTION',
						reason: 'repeat',
						evidence: 'not-json{',
						duration_days: 3,
						expires_at: '2026-01-10 10:00:00',
						created_at: '2026-01-02T10:00:00Z',
						target_name: 'Cara',
						target_email:
							'cara@example.com',
						moderator_name: 'Mod',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/actions?limit=9999`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].evidence).toEqual([
				{ type: 'SPOOFED_LOCATION' },
			])
			expect(body[1].evidence).toBe('not-json{') // kept raw
			expect(pool.query.mock.calls[1][1][0]).toBe(100)
		})
	})
	test('500 when query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockRejectedValueOnce(new Error('db down'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/actions`
			)
			expect(res.status).toBe(500)
		})
	})
})

describe('GET /api/moderation/history/:userId', () => {
	beforeEach(() => pool.query.mockReset())
	test('200 returns parsed history scoped to the target user', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([
				[
					{
						action_id: 5,
						target_user_id: 2,
						moderator_id: 1,
						action_type: 'WARNING',
						reason: 'spoof',
						evidence: JSON.stringify({
							type: 'SPOOFED',
						}),
						duration_days: null,
						expires_at: null,
						created_at: '2026-01-03T10:00:00Z',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/history/2`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].evidence).toEqual({ type: 'SPOOFED' })
			const historyCall = pool.query.mock.calls[1]
			expect(historyCall[0]).toMatch(
				/WHERE target_user_id = \?/
			)
			expect(historyCall[1]).toEqual(['2'])
		})
	})
	test('500 when query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockRejectedValueOnce(new Error('db down'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/history/2`
			)
			expect(res.status).toBe(500)
		})
	})
})

describe('GET /api/moderation/trust-scores', () => {
	beforeEach(() => pool.query.mockReset())
	test('200 converts trust_score to number and parses evidence', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]]) // moderator ok
			.mockResolvedValueOnce([
				[
					{
						user_id: 2,
						trust_score: '22.5',
						evidence: JSON.stringify([]),
						reason: 'spoof',
						updated_at: '2026-01-04T10:00:00Z',
						name: 'Bob',
						email: 'bob@example.com',
					},
				],
			])
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-scores`
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].trust_score).toBe(22.5)
			expect(body[0].evidence).toEqual([])
		})
	})
	test('500 when query fails', async () => {
		pool.query
			.mockResolvedValueOnce([[{ 1: 1 }]])
			.mockRejectedValueOnce(new Error('db down'))
		const app = makeApp({ user_id: 1 })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/moderation/trust-scores`
			)
			expect(res.status).toBe(500)
		})
	})
})
