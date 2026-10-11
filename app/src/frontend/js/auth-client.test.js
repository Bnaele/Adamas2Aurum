import { jest } from '@jest/globals'
import { API_BASE } from './constants.js'
import { googleSignIn, usernameSignIn } from './auth-client.js'

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

describe('googleSignIn', () => {
	const originalLocation = window.location

	beforeEach(() => {
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

	test('redirects the browser to the backend Google route', () => {
		googleSignIn()
		expect(window.location.href).toBe(
			`${API_BASE}/api/auth/google?return_to=${encodeURIComponent('https://app.example/')}`
		)
	})

	test('returns { data, error: null } so the auth drawer handler works unchanged', () => {
		const { data, error } = googleSignIn()
		expect(error).toBeNull()
		expect(data.url).toMatch(/\/api\/auth\/google\?return_to=/)
	})

	test('makes no network request (it is a full-page redirect)', () => {
		global.fetch = jest.fn()
		googleSignIn()
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
