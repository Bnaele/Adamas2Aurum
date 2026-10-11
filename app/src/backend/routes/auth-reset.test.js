import { jest } from '@jest/globals'
jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))
const { default: pool } = await import('../utils/db.js')
const { default: authRouter, pinResetTokens } = await import('./auth.js')
import express from 'express'
import { createServer } from 'http'

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
const post = (base, path, body) =>
	fetch(`${base}/api/auth${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('POST /api/auth/forgot-pin + /reset-pin', () => {
	beforeEach(() => {
		pool.query.mockReset()
		pinResetTokens.clear()
	})
	test('400 when email missing', async () => {
		await withServer(makeApp({}), async (base) => {
			expect(
				(await post(base, '/forgot-pin', {})).status
			).toBe(400)
			expect(
				(
					await post(base, '/reset-pin', {
						email: 'a',
					})
				).status
			).toBe(400)
		})
	})
	test('200 generic message for unknown user (no enumeration)', async () => {
		pool.query.mockResolvedValueOnce([[]])
		await withServer(makeApp({}), async (base) => {
			const res = await post(base, '/forgot-pin', {
				email: 'ghost',
			})
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.message).toMatch(/If that username exists/)
			expect(body.reset_token).toBeUndefined()
		})
	})
	test('400 for Google accounts with no PIN', async () => {
		pool.query
			.mockResolvedValueOnce([[{ user_id: 4, email: 'g' }]])
			.mockResolvedValueOnce([[]])
		await withServer(makeApp({}), async (base) => {
			const res = await post(base, '/forgot-pin', {
				email: 'g',
			})
			expect(res.status).toBe(400)
			expect((await res.json()).error).toMatch(/Google/)
		})
	})
	test('full flow: forgot-pin issues token, reset-pin consumes it once', async () => {
		pool.query
			.mockResolvedValueOnce([
				[{ user_id: 3, email: 'cara' }],
			])
			.mockResolvedValueOnce([[{ user_id: 3 }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }])
		await withServer(makeApp({}), async (base) => {
			const f = await post(base, '/forgot-pin', {
				email: 'cara',
			})
			expect(f.status).toBe(200)
			const { reset_token } = await f.json()
			expect(reset_token).toMatch(/^[0-9a-f]{64}$/)
			const r = await post(base, '/reset-pin', {
				email: 'cara',
				token: reset_token,
				new_pin: '5678',
			})
			expect(r.status).toBe(200)
			// single-use: replay fails
			const replay = await post(base, '/reset-pin', {
				email: 'cara',
				token: reset_token,
				new_pin: '9999',
			})
			expect(replay.status).toBe(400)
		})
		const updateCall = pool.query.mock.calls[2]
		expect(updateCall[0]).toMatch(
			/UPDATE user_credentials SET pin_hash/
		)
		expect(updateCall[1][1]).toBe(3)
	})
	test('400 when new PIN invalid or token wrong', async () => {
		pinResetTokens.set('tok123', {
			user_id: 3,
			email: 'cara',
			expires_at: Date.now() + 60000,
		})
		await withServer(makeApp({}), async (base) => {
			expect(
				(
					await post(base, '/reset-pin', {
						email: 'cara',
						token: 'tok123',
						new_pin: '12',
					})
				).status
			).toBe(400)
			expect(
				(
					await post(base, '/reset-pin', {
						email: 'cara',
						token: 'wrong',
						new_pin: '5678',
					})
				).status
			).toBe(400)
		})
	})
	test('expired token is rejected and cleared', async () => {
		pinResetTokens.set('old', {
			user_id: 3,
			email: 'cara',
			expires_at: Date.now() - 1000,
		})
		await withServer(makeApp({}), async (base) => {
			const res = await post(base, '/reset-pin', {
				email: 'cara',
				token: 'old',
				new_pin: '5678',
			})
			expect(res.status).toBe(400)
		})
		expect(pinResetTokens.has('old')).toBe(false)
	})
})
