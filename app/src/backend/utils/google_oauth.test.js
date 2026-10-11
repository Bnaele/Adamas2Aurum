import { jest } from '@jest/globals'
import crypto from 'crypto'
import {
	google_config,
	create_pkce,
	build_auth_url,
	exchange_code,
	fetch_profile,
	GOOGLE_TOKEN_URL,
	GOOGLE_USERINFO_URL,
} from './google_oauth.js'

const cfg = {
	clientId: 'cid',
	clientSecret: 'secret',
	redirectUri: 'http://localhost:3000/api/auth/callback/google',
}

describe('google_config', () => {
	test('null unless both client id and secret are set', () => {
		expect(google_config({})).toBeNull()
		expect(google_config({ GOOGLE_CLIENT_ID: 'a' })).toBeNull()
	})

	test('redirect URI uses BASE_URL, then BETTER_AUTH_URL, then localhost', () => {
		const env = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }
		expect(google_config(env).redirectUri).toBe(
			'http://localhost:3000/api/auth/callback/google'
		)
		expect(
			google_config({
				...env,
				BETTER_AUTH_URL: 'https://old.app/',
			}).redirectUri
		).toBe('https://old.app/api/auth/callback/google')
		expect(
			google_config({
				...env,
				BASE_URL: 'https://new.app',
				BETTER_AUTH_URL: 'https://old.app',
			}).redirectUri
		).toBe('https://new.app/api/auth/callback/google')
	})
})

describe('create_pkce', () => {
	test('challenge is the base64url SHA-256 of the verifier', () => {
		const { verifier, challenge } = create_pkce()
		expect(challenge).toBe(
			crypto
				.createHash('sha256')
				.update(verifier)
				.digest('base64url')
		)
		expect(create_pkce().verifier).not.toBe(verifier)
	})
})

describe('build_auth_url', () => {
	test('carries client, redirect, scope, state and S256 challenge', () => {
		const url = new URL(
			build_auth_url(cfg, { state: 's1', challenge: 'c1' })
		)
		expect(url.origin + url.pathname).toBe(
			'https://accounts.google.com/o/oauth2/v2/auth'
		)
		const p = url.searchParams
		expect(p.get('client_id')).toBe('cid')
		expect(p.get('redirect_uri')).toBe(cfg.redirectUri)
		expect(p.get('response_type')).toBe('code')
		expect(p.get('scope')).toBe('openid email profile')
		expect(p.get('state')).toBe('s1')
		expect(p.get('code_challenge')).toBe('c1')
		expect(p.get('code_challenge_method')).toBe('S256')
	})
})

describe('exchange_code', () => {
	test('POSTs the code + verifier and returns the access token', async () => {
		const fetchImpl = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ access_token: 'at' }),
		})
		expect(
			await exchange_code(cfg, 'the-code', 'ver', fetchImpl)
		).toBe('at')
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(GOOGLE_TOKEN_URL)
		const body = new URLSearchParams(init.body)
		expect(body.get('code')).toBe('the-code')
		expect(body.get('code_verifier')).toBe('ver')
		expect(body.get('grant_type')).toBe('authorization_code')
		expect(body.get('client_secret')).toBe('secret')
	})

	test('throws when Google rejects the code', async () => {
		const fetchImpl = jest
			.fn()
			.mockResolvedValue({ ok: false, status: 400 })
		await expect(
			exchange_code(cfg, 'bad', 'ver', fetchImpl)
		).rejects.toThrow(/400/)
	})
})

describe('fetch_profile', () => {
	test('sends the bearer token and returns the profile', async () => {
		const profile = {
			sub: '1',
			email: 'a@b.c',
			email_verified: true,
		}
		const fetchImpl = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => profile,
		})
		expect(await fetch_profile('at', fetchImpl)).toEqual(profile)
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(GOOGLE_USERINFO_URL)
		expect(init.headers.Authorization).toBe('Bearer at')
	})
})
