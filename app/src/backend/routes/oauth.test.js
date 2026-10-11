import { jest } from '@jest/globals'

jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))

const { create_oauth_router, safe_return_to } = await import('./oauth.js')
const { PIN_ACCOUNT_CONFLICT } = await import('../utils/google_user_sync.js')

import express from 'express'
import { createServer } from 'http'

const CFG = {
	clientId: 'cid',
	clientSecret: 'secret',
	redirectUri: 'http://localhost:3000/api/auth/callback/google',
}
const ORIGINS = ['https://app.example']
const PROFILE = {
	sub: 'g_1',
	email: 'thandi@gmail.com',
	email_verified: true,
	name: 'Thandi',
}

// Minimal stand-in for express-session: save() is a no-op and regenerate()
// swaps in a fresh, empty session like the real one does.
function makeHarness({ session = {}, db, fetchImpl, config = CFG } = {}) {
	const state = { session: { ...session, save: (cb) => cb() } }
	const app = express()
	app.use((req, _res, next) => {
		req.session = state.session
		req.session.regenerate = (cb) => {
			state.session = { save: (done) => done() }
			req.session = state.session
			cb()
		}
		next()
	})
	app.use(
		'/api/auth',
		create_oauth_router({
			allowed_origins: ORIGINS,
			db,
			get_config: () => config,
			fetchImpl,
		})
	)
	return { app, state }
}

async function withServer(app, fn) {
	const server = createServer(app)
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	try {
		await fn(`http://127.0.0.1:${port}`)
	} finally {
		await new Promise((resolve) => server.close(resolve))
	}
}

const get = (url) => fetch(url, { redirect: 'manual' })

function googleFetch(profile = PROFILE) {
	return jest.fn(async (url) =>
		String(url).includes('/token')
			? {
					ok: true,
					json: async () => ({
						access_token: 'at',
					}),
				}
			: { ok: true, json: async () => profile }
	)
}

const pendingSession = (extra = {}) => ({
	oauth: { state: 'st', verifier: 'ver', return_to: '/', ...extra },
})

describe('safe_return_to', () => {
	test.each([
		['/pages/events.html', '/pages/events.html'],
		['https://app.example/x?y=1', 'https://app.example/x?y=1'],
		['https://evil.example/', '/'],
		['//evil.example', '/'],
		['/\\evil.example', '/'],
		['javascript:alert(1)', '/'],
		[undefined, '/'],
	])('%p -> %p', (input, expected) => {
		expect(safe_return_to(input, ORIGINS)).toBe(expected)
	})
})

describe('GET /api/auth/google', () => {
	test('redirects to Google and remembers state + PKCE verifier in the session', async () => {
		const { app, state } = makeHarness()
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/google?return_to=${encodeURIComponent('https://app.example/home')}`
			)
			expect(res.status).toBe(302)
			const loc = new URL(res.headers.get('location'))
			expect(loc.host).toBe('accounts.google.com')
			expect(loc.searchParams.get('client_id')).toBe('cid')
			expect(
				loc.searchParams.get('code_challenge_method')
			).toBe('S256')
			expect(loc.searchParams.get('state')).toBe(
				state.session.oauth.state
			)
			expect(state.session.oauth.verifier).toBeTruthy()
			expect(state.session.oauth.return_to).toBe(
				'https://app.example/home'
			)
		})
	})

	test('ignores a return_to on a foreign origin', async () => {
		const { app, state } = makeHarness()
		await withServer(app, async (base) => {
			await get(
				`${base}/api/auth/google?return_to=${encodeURIComponent('https://evil.example')}`
			)
			expect(state.session.oauth.return_to).toBe('/')
		})
	})

	test('503 when Google credentials are not configured', async () => {
		const { app } = makeHarness({ config: null })
		await withServer(app, async (base) => {
			const res = await get(`${base}/api/auth/google`)
			expect(res.status).toBe(503)
		})
	})
})

describe('GET /api/auth/callback/google', () => {
	test('signs the user in: session.user set, redirected to return_to, oauth state consumed', async () => {
		const row = {
			user_id: 4,
			email: 'thandi@gmail.com',
			name: 'Thandi',
		}
		const db = { query: jest.fn().mockResolvedValueOnce([[row]]) }
		const fetchImpl = googleFetch()
		const { app, state } = makeHarness({
			session: pendingSession({
				return_to: 'https://app.example/home',
			}),
			db,
			fetchImpl,
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=abc&state=st`
			)
			expect(res.status).toBe(302)
			expect(res.headers.get('location')).toBe(
				'https://app.example/home'
			)
			expect(state.session.user).toEqual(row)
			expect(state.session.oauth).toBeUndefined()
			const [tokenUrl, init] = fetchImpl.mock.calls[0]
			expect(String(tokenUrl)).toMatch(
				/oauth2\.googleapis\.com/
			)
			expect(
				new URLSearchParams(init.body).get(
					'code_verifier'
				)
			).toBe('ver')
		})
	})

	test('rejects a state that does not match — no Google calls, no login', async () => {
		const fetchImpl = googleFetch()
		const { app, state } = makeHarness({
			session: pendingSession(),
			db: { query: jest.fn() },
			fetchImpl,
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=abc&state=forged`
			)
			expect(res.status).toBe(302)
			expect(res.headers.get('location')).toMatch(
				/auth_error=/
			)
			expect(fetchImpl).not.toHaveBeenCalled()
			expect(state.session.user).toBeUndefined()
		})
	})

	test('rejects a callback with no pending sign-in in the session', async () => {
		const fetchImpl = googleFetch()
		const { app, state } = makeHarness({
			db: { query: jest.fn() },
			fetchImpl,
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=abc&state=st`
			)
			expect(res.headers.get('location')).toMatch(
				/auth_error=/
			)
			expect(fetchImpl).not.toHaveBeenCalled()
			expect(state.session.user).toBeUndefined()
		})
	})

	test('user cancelling on Google redirects back with an error', async () => {
		const fetchImpl = googleFetch()
		const { app, state } = makeHarness({
			session: pendingSession(),
			db: { query: jest.fn() },
			fetchImpl,
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?error=access_denied&state=st`
			)
			expect(res.headers.get('location')).toMatch(
				/auth_error=/
			)
			expect(fetchImpl).not.toHaveBeenCalled()
			expect(state.session.user).toBeUndefined()
		})
	})

	test('refuses an unverified Google email without touching the database', async () => {
		const db = { query: jest.fn() }
		const { app, state } = makeHarness({
			session: pendingSession(),
			db,
			fetchImpl: googleFetch({
				...PROFILE,
				email_verified: false,
			}),
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=abc&state=st`
			)
			expect(res.headers.get('location')).toMatch(
				/auth_error=/
			)
			expect(db.query).not.toHaveBeenCalled()
			expect(state.session.user).toBeUndefined()
		})
	})

	test('PIN-account email conflict: no login, the reason comes back as auth_error', async () => {
		const db = {
			query: jest
				.fn()
				.mockResolvedValueOnce([[]])
				.mockResolvedValueOnce([
					[{ user_id: 9, has_pin: 1 }],
				]),
		}
		const { app, state } = makeHarness({
			session: pendingSession(),
			db,
			fetchImpl: googleFetch(),
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=abc&state=st`
			)
			const loc = new URL(
				res.headers.get('location'),
				'http://x'
			)
			expect(loc.searchParams.get('auth_error')).toBe(
				PIN_ACCOUNT_CONFLICT
			)
			expect(state.session.user).toBeUndefined()
		})
	})

	test('a failed token exchange redirects with an error and no login', async () => {
		const { app, state } = makeHarness({
			session: pendingSession(),
			db: { query: jest.fn() },
			fetchImpl: jest
				.fn()
				.mockResolvedValue({ ok: false, status: 400 }),
		})
		await withServer(app, async (base) => {
			const res = await get(
				`${base}/api/auth/callback/google?code=bad&state=st`
			)
			expect(res.headers.get('location')).toMatch(
				/auth_error=/
			)
			expect(state.session.user).toBeUndefined()
		})
	})
})
