import { jest } from '@jest/globals'
import crypto from 'crypto'
jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))
const { default: pool } = await import('../utils/db.js')
const { default: authRouter, loginLimiter } = await import('./auth.js')
const { hashPin } = await import('../utils/pin_hash.js')
import express from 'express'
import { createServer } from 'http'

function hash(pin) {
	return crypto
		.createHash('sha256')
		.update(String(pin))
		.digest('hex')
		.toLowerCase()
}

function makeApp(session = {}) {
	const app = express()
	app.use(express.json())
	app.use((req, _res, next) => {
		req.session = session
		next()
	})
	app.use('/api/auth', authRouter)
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

describe('POST /api/auth/login', () => {
	beforeEach(() => {
		pool.query.mockReset()
		loginLimiter.reset()
	})
	test('400 when missing fields', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			expect(res.status).toBe(400)
		})
	})
	test('401 when user not found', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'a@a.com',
					pin: '1234',
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('401 when pin wrong', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 1, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([[{ pin_hash: hash('9999') }]])
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'a@a.com',
					pin: '1234',
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('200 login success', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 1, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // legacy hash upgrade
			.mockResolvedValueOnce([[{ role: 'SUPER_ADMIN' }]])
		const session = {}
		const app = makeApp(session)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'a@a.com',
					pin: '1234',
				}),
			})
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.user.roles).toContain('SUPER_ADMIN')
		})
		expect(session.user).toBeDefined()
	})
	test('accepts password field as pin alias', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 1, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // legacy hash upgrade
			.mockResolvedValueOnce([[]])
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'a@a.com',
					password: '1234',
				}),
			})
			expect(res.status).toBe(200)
		})
	})

	function login(base, email, pin) {
		return fetch(`${base}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, pin }),
		})
	}

	test('legacy SHA-256 login upgrades the stored hash to salted scrypt', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 7, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[]])
		await withServer(makeApp({}), async (base) => {
			expect(
				(await login(base, 'a@a.com', '1234')).status
			).toBe(200)
		})
		const [sql, [newHash, userId]] = pool.query.mock.calls[2]
		expect(sql).toMatch(/UPDATE user_credentials SET pin_hash/)
		expect(newHash).toMatch(/^scrypt\$/)
		expect(userId).toBe(7)
	})

	test('scrypt hash: login works and nothing is re-written', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 1, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([
				[{ pin_hash: await hashPin('482913') }],
			])
			.mockResolvedValueOnce([[]]) // roles
		await withServer(makeApp({}), async (base) => {
			expect(
				(await login(base, 'a@a.com', '482913')).status
			).toBe(200)
		})
		expect(pool.query).toHaveBeenCalledTimes(3)
		expect(
			pool.query.mock.calls.some(([sql]) =>
				/UPDATE/.test(sql)
			)
		).toBe(false)
	})

	test('a failed hash upgrade does not block the login', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 1, name: 'A', email: 'a@a.com' }],
			])
			.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
			.mockRejectedValueOnce(new Error('Data too long'))
			.mockResolvedValueOnce([[]])
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {})
		await withServer(makeApp({}), async (base) => {
			expect(
				(await login(base, 'a@a.com', '1234')).status
			).toBe(200)
		})
		warn.mockRestore()
	})

	test('429 with Retry-After after 5 wrong PINs; the right PIN is refused while locked', async () => {
		const wrong = () =>
			pool.query
				.mockResolvedValueOnce([
					[
						{
							user_id: 1,
							name: 'A',
							email: 'a@a.com',
						},
					],
				])
				.mockResolvedValueOnce([
					[{ pin_hash: hash('1234') }],
				])
		await withServer(makeApp({}), async (base) => {
			for (let i = 0; i < 5; i++) {
				wrong()
				expect(
					(await login(base, 'a@a.com', '0000'))
						.status
				).toBe(401)
			}
			const res = await login(base, 'a@a.com', '1234')
			expect(res.status).toBe(429)
			expect(
				Number(res.headers.get('retry-after'))
			).toBeGreaterThan(0)
		})
		// The locked request never reached the DB.
		expect(pool.query).toHaveBeenCalledTimes(10)
	})

	test('unknown usernames count toward the lockout too', async () => {
		await withServer(makeApp({}), async (base) => {
			for (let i = 0; i < 5; i++) {
				pool.query.mockResolvedValueOnce([[]])
				await login(base, 'ghost', '1234')
			}
			expect(
				(await login(base, 'ghost', '1234')).status
			).toBe(429)
		})
	})
})

describe('POST /api/auth/register', () => {
	beforeEach(() => pool.query.mockReset())
	test('400 when missing', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'A' }),
			})
			expect(res.status).toBe(400)
		})
	})
	test('400 when terms are not accepted', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'A',
					email: 'alice',
					pin: '1234',
				}),
			})
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/Terms of Use/)
		})
		expect(pool.query).not.toHaveBeenCalled()
	})
	test('400 when the terms version is stale', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'A',
					email: 'alice',
					pin: '1234',
					terms_accepted: true,
					terms_version: '0.1',
				}),
			})
			expect(res.status).toBe(400)
		})
		expect(pool.query).not.toHaveBeenCalled()
	})
	test('400 when the username is taken', async () => {
		pool.query.mockResolvedValueOnce([[{ user_id: 1 }]])
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'A',
					email: 'alice',
					pin: '1234',
					terms_accepted: true,
					terms_version: '1.0',
				}),
			})
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(
				/already registered/
			)
		})
	})
	test.each(['thandi@gmail.com', 'a@', '@x'])(
		"400 for username %p: usernames can't contain '@' (Google hijack)",
		async (username) => {
			await withServer(makeApp({}), async (base) => {
				const res = await fetch(
					`${base}/api/auth/register`,
					{
						method: 'POST',
						headers: {
							'Content-Type':
								'application/json',
						},
						body: JSON.stringify({
							name: 'T',
							email: username,
							pin: '1234',
						}),
					}
				)
				expect(res.status).toBe(400)
				expect((await res.json()).error).toMatch(/@/)
			})
			expect(pool.query).not.toHaveBeenCalled()
		}
	)
	test.each(['123', '1234567', 'abcd', '12 34'])(
		'400 when the PIN %p is not 4–6 digits',
		async (pin) => {
			await withServer(makeApp({}), async (base) => {
				const res = await fetch(
					`${base}/api/auth/register`,
					{
						method: 'POST',
						headers: {
							'Content-Type':
								'application/json',
						},
						body: JSON.stringify({
							name: 'Bob',
							email: 'bobby',
							pin,
						}),
					}
				)
				expect(res.status).toBe(400)
				expect((await res.json()).error).toMatch(
					/4 to 6 digits/
				)
			})
			expect(pool.query).not.toHaveBeenCalled()
		}
	)
	test('201 stores a salted scrypt hash, not the PIN or its SHA-256', async () => {
		pool.query
			.mockResolvedValueOnce([[]])
			.mockResolvedValueOnce([{ insertId: 9 }])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockResolvedValueOnce([[]])
		await withServer(makeApp({}), async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'Bob',
					email: 'bobby',
					pin: '482913',
					terms_accepted: true,
					terms_version: '1.0',
				}),
			})
			expect(res.status).toBe(201)
		})
		const [sql, [userId, stored]] = pool.query.mock.calls[2]
		expect(sql).toMatch(/INSERT INTO user_credentials/)
		expect(userId).toBe(9)
		expect(stored).toMatch(/^scrypt\$/)
		expect(stored).not.toContain('482913')
		expect(stored).not.toBe(hash('482913'))
	})
	test('201 creates user and records terms acceptance', async () => {
		pool.query
			.mockResolvedValueOnce([[]]) // existing
			.mockResolvedValueOnce([{ insertId: 2 }]) // insert users
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // insert creds
			.mockResolvedValueOnce([{ affectedRows: 1 }]) // terms acceptance
			.mockResolvedValueOnce([[]]) // roles
		const session = {}
		const app = makeApp(session)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'Bob',
					email: 'bob',
					pin: '1234',
					terms_accepted: true,
					terms_version: '1.0',
				}),
			})
			expect(res.status).toBe(201)
			expect(session.user.email).toBe('bob')
		})
		const [sql, [userId, version]] = pool.query.mock.calls[3]
		expect(sql).toMatch(/user_terms_acceptances/)
		expect(userId).toBe(2)
		expect(version).toBe('1.0')
	})
})

describe('GET /api/auth/terms-status', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/terms-status`)
			expect(res.status).toBe(401)
		})
	})
	test('accepted:false when no record', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user: { user_id: 5 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/terms-status`)
			expect(res.status).toBe(200)
			const data = await res.json()
			expect(data.accepted).toBe(false)
			expect(data.current_version).toBe('1.0')
		})
	})
	test('accepted:false on a stale version', async () => {
		pool.query.mockResolvedValueOnce([
			[{ terms_version: '0.1', accepted_at: '2026-01-01' }],
		])
		const app = makeApp({ user: { user_id: 5 } })
		await withServer(app, async (base) => {
			const data = await (
				await fetch(`${base}/api/auth/terms-status`)
			).json()
			expect(data.accepted).toBe(false)
			expect(data.accepted_version).toBe('0.1')
		})
	})
	test('accepted:true on the current version', async () => {
		pool.query.mockResolvedValueOnce([
			[{ terms_version: '1.0', accepted_at: '2026-09-29' }],
		])
		const app = makeApp({ user: { user_id: 5 } })
		await withServer(app, async (base) => {
			const data = await (
				await fetch(`${base}/api/auth/terms-status`)
			).json()
			expect(data.accepted).toBe(true)
		})
	})
})

describe('POST /api/auth/accept-terms', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/auth/accept-terms`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						version: '1.0',
					}),
				}
			)
			expect(res.status).toBe(401)
		})
	})
	test('400 on a stale version', async () => {
		const app = makeApp({ user: { user_id: 5 } })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/auth/accept-terms`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						version: '0.1',
					}),
				}
			)
			expect(res.status).toBe(400)
		})
		expect(pool.query).not.toHaveBeenCalled()
	})
	test('200 records acceptance', async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }])
		const app = makeApp({ user: { user_id: 5 } })
		await withServer(app, async (base) => {
			const res = await fetch(
				`${base}/api/auth/accept-terms`,
				{
					method: 'POST',
					headers: {
						'Content-Type':
							'application/json',
					},
					body: JSON.stringify({
						version: '1.0',
					}),
				}
			)
			expect(res.status).toBe(200)
			expect((await res.json()).accepted).toBe(true)
		})
		const [sql, [userId, version]] = pool.query.mock.calls[0]
		expect(sql).toMatch(/user_terms_acceptances/)
		expect(userId).toBe(5)
		expect(version).toBe('1.0')
	})
})

describe('GET /api/auth/me', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/me`)
			expect(res.status).toBe(401)
		})
	})
	test('200 returns user with roles', async () => {
		pool.query.mockResolvedValueOnce([[{ role: 'EVENT_AUTHOR' }]])
		const app = makeApp({
			user: { user_id: 1, name: 'A', email: 'a@a.com' },
		})
		// need session.user for me route: it reads req.session.user
		const sess = {
			user: { user_id: 1, name: 'A', email: 'a@a.com' },
		}
		const app2 = express()
		app2.use(express.json())
		app2.use((req, _res, next) => {
			req.session = sess
			next()
		})
		app2.use('/api/auth', authRouter)
		const server = createServer(app2)
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		const { port } = server.address()
		const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.roles).toContain('EVENT_AUTHOR')
		await new Promise((r) => server.close(r))
	})
})

describe('POST /api/auth/logout', () => {
	test('200 logout', async () => {
		const sess = { destroy: (cb) => cb() }
		const app = express()
		app.use(express.json())
		app.use((req, _res, next) => {
			req.session = sess
			next()
		})
		app.use('/api/auth', authRouter)
		const server = createServer(app)
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		const { port } = server.address()
		const res = await fetch(
			`http://127.0.0.1:${port}/api/auth/logout`,
			{ method: 'POST' }
		)
		expect(res.status).toBe(200)
		await new Promise((r) => server.close(r))
	})
})

describe('GET /api/auth/profile', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`)
			expect(res.status).toBe(401)
		})
	})
	test('200 returns name, username and PIN status', async () => {
		pool.query
			.mockResolvedValueOnce([
				[
					{
						user_id: 3,
						name: 'Cara',
						email: 'cara',
						provider_id: 'local:cara',
					},
				],
			])
			.mockResolvedValueOnce([[{ has_pin: 1 }]])
		const app = makeApp({
			user: { user_id: 3, name: 'Cara', email: 'cara' },
		})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({
				name: 'Cara',
				username: 'cara',
				has_pin: true,
				is_local: true,
			})
		})
	})
	test('Google accounts report has_pin false', async () => {
		pool.query
			.mockResolvedValueOnce([
				[
					{
						user_id: 4,
						name: 'G',
						email: 'g@gmail.com',
						provider_id: 'google:xyz',
					},
				],
			])
			.mockResolvedValueOnce([[]])
		const app = makeApp({
			user: { user_id: 4, name: 'G', email: 'g@gmail.com' },
		})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`)
			const body = await res.json()
			expect(body.has_pin).toBe(false)
			expect(body.is_local).toBe(false)
		})
	})
})

describe('PATCH /api/auth/profile', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'New' }),
			})
			expect(res.status).toBe(401)
		})
	})
	test('400 when name is blank', async () => {
		const app = makeApp({ user: { user_id: 3 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: '   ' }),
			})
			expect(res.status).toBe(400)
		})
	})
	test('200 updates name and session', async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }])
		const sess = {
			user: { user_id: 3, name: 'Old', email: 'cara' },
		}
		const app = makeApp(sess)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/profile`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'New Name' }),
			})
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.user.name).toBe('New Name')
			expect(sess.user.name).toBe('New Name')
			expect(pool.query.mock.calls[0][1]).toEqual([
				'New Name',
				3,
			])
		})
	})
})

describe('POST /api/auth/change-pin', () => {
	beforeEach(() => pool.query.mockReset())
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/change-pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_pin: '1234',
					new_pin: '5678',
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('400 for Google accounts with no PIN', async () => {
		pool.query.mockResolvedValueOnce([[]])
		const app = makeApp({ user: { user_id: 4 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/change-pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_pin: '1234',
					new_pin: '5678',
				}),
			})
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toMatch(/Google/)
		})
	})
	test('401 when current PIN is wrong', async () => {
		pool.query.mockResolvedValueOnce([[{ pin_hash: hash('0000') }]])
		const app = makeApp({ user: { user_id: 3 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/change-pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_pin: '1234',
					new_pin: '5678',
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('400 when new PIN is invalid', async () => {
		pool.query.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
		const app = makeApp({ user: { user_id: 3 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/change-pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_pin: '1234',
					new_pin: '12',
				}),
			})
			expect(res.status).toBe(400)
		})
	})
	test('200 updates the PIN hash', async () => {
		pool.query
			.mockResolvedValueOnce([[{ pin_hash: hash('1234') }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
		const app = makeApp({ user: { user_id: 3 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/change-pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_pin: '1234',
					new_pin: '5678',
				}),
			})
			expect(res.status).toBe(200)
			const updateCall = pool.query.mock.calls[1]
			expect(updateCall[0]).toMatch(
				/UPDATE user_credentials SET pin_hash/
			)
			expect(updateCall[1][1]).toBe(3)
		})
	})
})

describe('DELETE /api/auth/account', () => {
	beforeEach(() => {
		pool.query.mockReset()
		delete pool.getConnection
	})
	test('401 when no session', async () => {
		const app = makeApp({})
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/account`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					confirmation: 'DELETE',
				}),
			})
			expect(res.status).toBe(401)
		})
	})
	test('400 without DELETE confirmation', async () => {
		const app = makeApp({ user: { user_id: 3 } })
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/account`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmation: 'yes' }),
			})
			expect(res.status).toBe(400)
		})
	})
	test('200 removes login and anonymises the user', async () => {
		const connQueries = []
		const conn = {
			beginTransaction: jest.fn(),
			commit: jest.fn(),
			rollback: jest.fn(),
			release: jest.fn(),
			query: jest.fn((sql, params) => {
				connQueries.push([sql, params])
				return Promise.resolve([[]])
			}),
		}
		pool.getConnection = jest.fn().mockResolvedValue(conn)
		let destroyed = false
		const sess = {
			user: { user_id: 3, name: 'Cara', email: 'cara' },
			destroy: (cb) => {
				destroyed = true
				cb()
			},
		}
		const app = makeApp(sess)
		await withServer(app, async (base) => {
			const res = await fetch(`${base}/api/auth/account`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					confirmation: 'DELETE',
				}),
			})
			expect(res.status).toBe(200)
			expect(conn.commit).toHaveBeenCalled()
			expect(destroyed).toBe(true)
			const sqls = connQueries.map((c) => c[0])
			expect(
				sqls.some((s) =>
					s.match(/DELETE FROM user_credentials/)
				)
			).toBe(true)
			expect(
				sqls.some((s) =>
					s.match(/UPDATE users SET name = \?/)
				)
			).toBe(true)
		})
		delete pool.getConnection
	})
})
