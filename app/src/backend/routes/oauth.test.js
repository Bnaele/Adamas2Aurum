import { jest } from '@jest/globals'
import crypto from 'crypto'

jest.unstable_mockModule('../utils/db.js', () => ({
	default: { query: jest.fn() },
}))

const { create_oauth_router, safe_return_to, LOGIN_CODE_TTL_MS } =
	await import('./oauth.js')
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
const ROW = { user_id: 4, email: 'thandi@gmail.com', name: 'Thandi' }

// The frontend's verifier/challenge pair (what auth-client.js generates).
const VERIFIER = 'v'.repeat(43)
const CHALLENGE = crypto
	.createHash('sha256')
	.update(VERIFIER)
	.digest('base64url')

// Minimal stand-in for express-session: save() is a no-op and regenerate()
// swaps in a fresh, empty session like the real one does.
function makeHarness({ session = {}, db, fetchImpl, config = CFG } = {}) {
	const state = { session: { ...session, save: (cb) => cb() } }
	const app = express()
	app.use(express.json())
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
const post = (url, body) =>
	fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

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
	oauth: {
		state: 'st',
		verifier: 'ver',
		client_challenge: CHALLENGE,
		return_to: '/',
		...extra,
	},
})

// Runs the callback and returns the one-time code from the redirect.
async function signInToCode(base) {
	const res = await get(
		`${base}/api/auth/callback/google?code=abc&state=st`
	)
	const loc = new URL(res.headers.get('location'), 'http://x')
	return { res, loc, code: loc.searchParams.get('auth_code') }
}

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
	const start = (base, extra = '') =>
		get(`${base}/api/auth/google?challenge=${CHALLENGE}${extra}`)

	test('redirects to Google and remembers state, PKCE verifier and the frontend challenge', async () => {
		const { app, state } = makeHarness()
		await withServer(app, async (base) => {
			const res = await start(
				base,
				`&return_to=${encodeURIComponent('https://app.example/home')}`
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
			expect(state.session.oauth.client_challenge).toBe(
				CHALLENGE
			)
			expect(state.session.oauth.return_to).toBe(
				'https://app.example/home'
			)
		})
	})

	test('400 without a valid frontend challenge', async () => {
		const { app, state } = makeHarness()
		await withServer(app, async (base) => {
			expect(
				(await get(`${base}/api/auth/google`)).status
			).toBe(400)
			expect(
				(
					await get(
						`${base}/api/auth/google?challenge=short`
					)
				).status
			).toBe(400)
			expect(state.session.oauth).toBeUndefined()
		})
	})

	test('ignores a return_to on a foreign origin', async () => {
		const { app, state } = makeHarness()
		await withServer(app, async (base) => {
			await start(
				base,
				`&return_to=${encodeURIComponent('https://evil.example')}`
			)
			expect(state.session.oauth.return_to).toBe('/')
		})
	})

	test('503 when Google credentials are not configured', async () => {
		const { app } = makeHarness({ config: null })
		await withServer(app, async (base) => {
			expect((await start(base)).status).toBe(503)
		})
	})
})

describe('GET /api/auth/callback/google', () => {
	test('success redirects to return_to with a one-time code and does NOT log in yet', async () => {
		const db = { query: jest.fn().mockResolvedValueOnce([[ROW]]) }
		const fetchImpl = googleFetch()
		const { app, state } = makeHarness({
			session: pendingSession({
				return_to: 'https://app.example/home',
			}),
			db,
			fetchImpl,
		})
		await withServer(app, async (base) => {
			const { res, loc, code } = await signInToCode(base)
			expect(res.status).toBe(302)
			expect(loc.origin + loc.pathname).toBe(
				'https://app.example/home'
			)
			expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(state.session.user).toBeUndefined()
			expect(state.session.oauth).toBeUndefined()
			const [, init] = fetchImpl.mock.calls[0]
			expect(
				new URLSearchParams(init.body).get(
					'code_verifier'
				)
			).toBe('ver')
		})
	})

	test('rejects a state that does not match — no Google calls, no code', async () => {
		const fetchImpl = googleFetch()
		const { app } = makeHarness({
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
			expect(res.headers.get('location')).not.toMatch(
				/auth_code=/
			)
			expect(fetchImpl).not.toHaveBeenCalled()
		})
	})

	test('rejects a callback with no pending sign-in in the session', async () => {
		const fetchImpl = googleFetch()
		const { app } = makeHarness({
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
		})
	})

	test('user cancelling on Google redirects back with an error', async () => {
		const fetchImpl = googleFetch()
		const { app } = makeHarness({
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
		})
	})

	test('refuses an unverified Google email without touching the database', async () => {
		const db = { query: jest.fn() }
		const { app } = makeHarness({
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
		})
	})

	test('PIN-account email conflict: no code, the reason comes back as auth_error', async () => {
		const db = {
			query: jest
				.fn()
				.mockResolvedValueOnce([[]])
				.mockResolvedValueOnce([
					[{ user_id: 9, has_pin: 1 }],
				]),
		}
		const { app } = makeHarness({
			session: pendingSession(),
			db,
			fetchImpl: googleFetch(),
		})
		await withServer(app, async (base) => {
			const { loc } = await signInToCode(base)
			expect(loc.searchParams.get('auth_error')).toBe(
				PIN_ACCOUNT_CONFLICT
			)
			expect(loc.searchParams.get('auth_code')).toBeNull()
		})
	})

	test('a failed token exchange redirects with an error and no code', async () => {
		const { app } = makeHarness({
			session: pendingSession(),
			db: { query: jest.fn() },
			fetchImpl: jest
				.fn()
				.mockResolvedValue({ ok: false, status: 400 }),
		})
		await withServer(app, async (base) => {
			const { loc } = await signInToCode(base)
			expect(loc.searchParams.get('auth_error')).toBeTruthy()
			expect(loc.searchParams.get('auth_code')).toBeNull()
		})
	})
})

describe('POST /api/auth/oauth/exchange', () => {
	// callback (consumes 1 db query) then exchange (consumes 1 more)
	const signedInHarness = () =>
		makeHarness({
			session: pendingSession(),
			db: {
				query: jest
					.fn()
					.mockResolvedValueOnce([[ROW]])
					.mockResolvedValueOnce([[ROW]]),
			},
			fetchImpl: googleFetch(),
		})

	test('with the right verifier the code logs the user in (session.user set)', async () => {
		const { app, state } = signedInHarness()
		await withServer(app, async (base) => {
			const { code } = await signInToCode(base)
			const res = await post(
				`${base}/api/auth/oauth/exchange`,
				{
					code,
					verifier: VERIFIER,
				}
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual(ROW)
			expect(state.session.user).toEqual(ROW)
		})
	})

	test('a wrong verifier is refused, and burns the code', async () => {
		const { app, state } = signedInHarness()
		await withServer(app, async (base) => {
			const { code } = await signInToCode(base)
			const bad = await post(
				`${base}/api/auth/oauth/exchange`,
				{
					code,
					verifier: 'x'.repeat(43),
				}
			)
			expect(bad.status).toBe(401)
			const retry = await post(
				`${base}/api/auth/oauth/exchange`,
				{
					code,
					verifier: VERIFIER,
				}
			)
			expect(retry.status).toBe(401)
			expect(state.session.user).toBeUndefined()
		})
	})

	test('a code works only once', async () => {
		const { app } = signedInHarness()
		await withServer(app, async (base) => {
			const { code } = await signInToCode(base)
			const body = { code, verifier: VERIFIER }
			expect(
				(
					await post(
						`${base}/api/auth/oauth/exchange`,
						body
					)
				).status
			).toBe(200)
			expect(
				(
					await post(
						`${base}/api/auth/oauth/exchange`,
						body
					)
				).status
			).toBe(401)
		})
	})

	test('an unknown code is refused', async () => {
		const { app, state } = makeHarness({ db: { query: jest.fn() } })
		await withServer(app, async (base) => {
			const res = await post(
				`${base}/api/auth/oauth/exchange`,
				{
					code: 'z'.repeat(43),
					verifier: VERIFIER,
				}
			)
			expect(res.status).toBe(401)
			expect(state.session.user).toBeUndefined()
		})
	})

	test('an expired code is refused', async () => {
		const { app, state } = signedInHarness()
		await withServer(app, async (base) => {
			const { code } = await signInToCode(base)
			const realNow = Date.now()
			const spy = jest
				.spyOn(Date, 'now')
				.mockReturnValue(
					realNow + LOGIN_CODE_TTL_MS + 1000
				)
			try {
				const res = await post(
					`${base}/api/auth/oauth/exchange`,
					{
						code,
						verifier: VERIFIER,
					}
				)
				expect(res.status).toBe(401)
				expect(state.session.user).toBeUndefined()
			} finally {
				spy.mockRestore()
			}
		})
	})

	test('400 when code or verifier is missing', async () => {
		const { app } = makeHarness({ db: { query: jest.fn() } })
		await withServer(app, async (base) => {
			const res = await post(
				`${base}/api/auth/oauth/exchange`,
				{}
			)
			expect(res.status).toBe(400)
		})
	})
})
