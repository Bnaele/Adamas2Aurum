import { jest } from '@jest/globals'
import { API_BASE } from './constants.js'
import {
	googleSignIn,
	completeGoogleSignIn,
	usernameSignIn,
} from './auth-client.js'
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'

function mockFetch(status, body) {
	global.fetch = jest.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	}))
}

afterEach(() => {
	delete global.fetch
	jest.restoreAllMocks()
})

// jsdom has no crypto.subtle / TextEncoder; Node provides both.
beforeAll(() => {
	if (!globalThis.crypto?.subtle)
		Object.defineProperty(globalThis, 'crypto', {
			value: webcrypto,
			configurable: true,
		})
	if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder
})

describe('googleSignIn', () => {
	const originalLocation = window.location

	beforeEach(() => {
		sessionStorage.clear()
		delete window.location
		window.location = {
			href: '',
			origin: 'https://app.example',
			pathname: '/pages/events.html',
			search: '',
		}
	})

	afterEach(() => {
		window.location = originalLocation
	})

	test('stores a verifier and redirects to the backend with its SHA-256 challenge', async () => {
		await googleSignIn()
		const verifier = sessionStorage.getItem('a2a_google_verifier')
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

		const url = new URL(window.location.href)
		expect(url.origin + url.pathname).toBe(
			`${API_BASE}/api/auth/google`
		)
		expect(url.searchParams.get('return_to')).toBe(
			'https://app.example/'
		)
		const expected = (await import('node:crypto'))
			.createHash('sha256')
			.update(verifier)
			.digest('base64url')
		expect(url.searchParams.get('challenge')).toBe(expected)
	})

	test('returns { data, error: null } so the auth drawer handler works unchanged', async () => {
		const { data, error } = await googleSignIn()
		expect(error).toBeNull()
		expect(data.url).toMatch(/\/api\/auth\/google\?return_to=/)
	})

	test('makes no network request (it is a full-page redirect)', async () => {
		global.fetch = jest.fn()
		await googleSignIn()
		expect(global.fetch).not.toHaveBeenCalled()
	})
})

describe('completeGoogleSignIn', () => {
	const originalLocation = window.location
	let replaceState

	beforeEach(() => {
		sessionStorage.clear()
		replaceState = jest
			.spyOn(window.history, 'replaceState')
			.mockImplementation(() => {})
		delete window.location
		window.location = {
			href: '',
			origin: 'https://app.example',
			pathname: '/',
			search: '?auth_code=abc123&x=1',
			hash: '',
		}
	})

	afterEach(() => {
		window.location = originalLocation
		replaceState.mockRestore()
	})

	test('does nothing when there is no auth_code in the URL', async () => {
		window.location.search = ''
		global.fetch = jest.fn()
		expect(await completeGoogleSignIn()).toBeNull()
		expect(global.fetch).not.toHaveBeenCalled()
	})

	test('removes the code from the URL and redeems it with the stored verifier', async () => {
		sessionStorage.setItem('a2a_google_verifier', 'ver')
		mockFetch(200, { user_id: 4, name: 'Thandi' })

		const { data, error } = await completeGoogleSignIn()

		expect(error).toBeNull()
		expect(data).toEqual({ user_id: 4, name: 'Thandi' })
		expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1')
		const [url, init] = global.fetch.mock.calls[0]
		expect(url).toBe(`${API_BASE}/api/auth/oauth/exchange`)
		expect(init.credentials).toBe('include')
		expect(JSON.parse(init.body)).toEqual({
			code: 'abc123',
			verifier: 'ver',
		})
		expect(sessionStorage.getItem('a2a_google_verifier')).toBeNull()
	})

	test('reports the backend error when the code is refused', async () => {
		sessionStorage.setItem('a2a_google_verifier', 'ver')
		mockFetch(401, { error: 'Invalid or expired sign-in code.' })
		const { data, error } = await completeGoogleSignIn()
		expect(data).toBeNull()
		expect(error.message).toBe('Invalid or expired sign-in code.')
	})

	test('fails without a request when sign-in was started in another tab', async () => {
		global.fetch = jest.fn()
		const { error } = await completeGoogleSignIn()
		expect(error.message).toMatch(/different tab/)
		expect(global.fetch).not.toHaveBeenCalled()
	})
})

describe('usernameSignIn', () => {
	test('returns the user on success', async () => {
		mockFetch(200, { user: { user_id: 1 } })
		const { data, error } = await usernameSignIn('thandi', '1234')
		expect(error).toBeNull()
		expect(data).toEqual({ user_id: 1 })
	})

	test('returns the server error message on failure', async () => {
		mockFetch(401, { error: 'Invalid credentials' })
		const { data, error } = await usernameSignIn('thandi', '0000')
		expect(data).toBeNull()
		expect(error.message).toBe('Invalid credentials')
	})
})
