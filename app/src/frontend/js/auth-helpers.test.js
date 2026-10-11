import { jest } from '@jest/globals'
import { API_BASE, API_BASE_WS } from './constants.js'
import {
	isAdmin,
	redirectAfterLogin,
	logout,
	updateAuthNav,
	ADMIN_ROLES,
} from './auth-helpers.js'

describe('auth-helpers', () => {
	describe('isAdmin', () => {
		test('returns true for admin roles', () => {
			expect(isAdmin({ roles: ['SUPER_ADMIN'] })).toBe(true)
			expect(isAdmin({ roles: ['EVENT_AUTHOR'] })).toBe(true)
			expect(isAdmin({ roles: ['CARD_AUTHOR'] })).toBe(true)
		})

		test('returns false for regular players or empty roles', () => {
			expect(isAdmin({ roles: [] })).toBe(false)
			expect(isAdmin({ roles: ['PLAYER'] })).toBe(false)
			expect(isAdmin(null)).toBe(false)
			expect(isAdmin(undefined)).toBe(false)
		})
	})

	describe('redirectAfterLogin', () => {
		const originalLocation = window.location

		beforeEach(() => {
			delete window.location
			window.location = { href: '' }
		})

		afterEach(() => {
			window.location = originalLocation
		})

		test('redirects admins to console', () => {
			redirectAfterLogin({ roles: ['SUPER_ADMIN'] })
			expect(window.location.href).toBe('/pages/console.html')
		})

		test('redirects players to the main map (same page Google sign-in returns to)', () => {
			redirectAfterLogin({ roles: [] })
			expect(window.location.href).toBe('/')
		})
	})

	describe('logout', () => {
		const originalLocation = window.location
		const originalFetch = global.fetch

		beforeEach(() => {
			delete window.location
			window.location = { href: '' }
		})

		afterEach(() => {
			window.location = originalLocation
			global.fetch = originalFetch
		})

		test('clears the session on the backend, then redirects to /', async () => {
			const fetchMock = jest
				.fn()
				.mockResolvedValue({ ok: true })
			global.fetch = fetchMock

			await logout()

			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(fetchMock.mock.calls[0][0]).toBe(
				`${API_BASE}/api/auth/logout`
			)
			expect(window.location.href).toBe('/')
		})

		test('redirects to / even if fetch calls fail', async () => {
			const fetchMock = jest
				.fn()
				.mockRejectedValue(new Error('Network error'))
			global.fetch = fetchMock

			await logout()

			expect(window.location.href).toBe('/')
		})
	})

	describe('ADMIN_ROLES', () => {
		test('contains expected roles', () => {
			expect(ADMIN_ROLES).toEqual(
				expect.arrayContaining([
					'SUPER_ADMIN',
					'EVENT_AUTHOR',
					'CARD_AUTHOR',
				])
			)
		})
		test('isAdmin respects all ADMIN_ROLES', () => {
			for (const r of ADMIN_ROLES) {
				expect(isAdmin({ roles: [r] })).toBe(true)
			}
		})
	})

	describe('updateAuthNav', () => {
		beforeEach(() => {
			document.body.innerHTML = `
				<div class="header-right"></div>
				<div id="user-badge"></div>
				<button id="btn-logout"></button>
				<a id="btn-signin"></a>
				<a id="nav-console"></a>
				<a id="nav-events"></a>
				<a id="nav-collection"></a>
				<a id="nav-battle"></a>
				<a id="nav-leaderboard"></a>
			`
		})
		afterEach(() => {
			document.body.innerHTML = ''
		})
		test('logged-out shows Sign In, hides player links and console', () => {
			updateAuthNav(null)
			expect(
				document
					.getElementById('btn-signin')
					.classList.contains('hidden')
			).toBe(false)
			expect(
				document
					.getElementById('nav-events')
					.classList.contains('hidden')
			).toBe(true)
			expect(
				document
					.getElementById('nav-console')
					.classList.contains('hidden')
			).toBe(true)
			expect(document.querySelector('.acct-wrap')).toBeNull()
		})
		test('player shows player links, hides console, creates avatar', () => {
			updateAuthNav({
				name: 'Bob Player',
				points: 120,
				roles: [],
			})
			expect(
				document
					.getElementById('nav-events')
					.classList.contains('hidden')
			).toBe(false)
			expect(
				document
					.getElementById('nav-console')
					.classList.contains('hidden')
			).toBe(true)
			const wrap = document.querySelector('.acct-wrap')
			expect(wrap).not.toBeNull()
			const btn = wrap.querySelector('.acct-avatar')
			expect(btn).not.toBeNull()
			expect(btn.getAttribute('aria-label')).toMatch(
				/Bob Player/
			)
		})
		test('admin hides player links, shows console, shows role sublabel', () => {
			updateAuthNav({
				name: 'Alice Admin',
				roles: ['SUPER_ADMIN'],
			})
			expect(
				document
					.getElementById('nav-events')
					.classList.contains('hidden')
			).toBe(true)
			expect(
				document
					.getElementById('nav-console')
					.classList.contains('hidden')
			).toBe(false)
			const sub = document.querySelector('.acct-menu-sub')
			// may be empty before menu opened, but wrap exists
			expect(
				document.querySelector('.acct-wrap')
			).not.toBeNull()
		})
		test('second call refreshes without duplicating wrap', () => {
			updateAuthNav({ name: 'A', roles: [] })
			const first =
				document.querySelectorAll('.acct-wrap').length
			updateAuthNav({ name: 'B', roles: [] })
			const second =
				document.querySelectorAll('.acct-wrap').length
			expect(first).toBe(1)
			expect(second).toBe(1)
			const btn = document.querySelector('.acct-avatar')
			expect(btn.getAttribute('aria-label')).toMatch(/B/)
		})
		test('null user removes existing menu', () => {
			updateAuthNav({ name: 'A', roles: [] })
			expect(
				document.querySelector('.acct-wrap')
			).not.toBeNull()
			updateAuthNav(null)
			expect(document.querySelector('.acct-wrap')).toBeNull()
		})
		test('avatar click toggles menu and shows header', async () => {
			updateAuthNav({
				name: 'Charlie Brown',
				points: 50,
				level: 2,
				roles: [],
			})
			const btn = document.querySelector('.acct-avatar')
			expect(btn).not.toBeNull()
			btn.click()
			const menu = document.querySelector('.acct-menu')
			expect(menu).not.toBeNull()
			expect(
				menu.querySelector('.acct-menu-name')
					.textContent
			).toBe('Charlie Brown')
			expect(
				menu.querySelector('.acct-menu-sub').textContent
			).toMatch(/50 pts/)
			// second click closes
			btn.click()
			expect(document.querySelector('.acct-menu')).toBeNull()
		})
		test('menu has no Settings item and edit username opens a modal', () => {
			updateAuthNav({ name: 'D', roles: [] })
			const btn = document.querySelector('.acct-avatar')
			btn.click()
			const labels = [
				...document.querySelectorAll('.acct-menu-item'),
			].map((el) => el.textContent)
			expect(labels.some((t) => t.includes('Settings'))).toBe(
				false
			)
			const item = [
				...document.querySelectorAll('.acct-menu-item'),
			].find((el) => el.textContent.includes('Edit username'))
			expect(item).toBeDefined()
			item.click()
			const overlay = document.querySelector(
				'.acct-modal-overlay'
			)
			expect(overlay).not.toBeNull()
			expect(
				overlay.querySelector('#acct-name-input').value
			).toBe('D')
		})
		test('delete account opens a confirmation modal', () => {
			updateAuthNav({ name: 'D', roles: [] })
			const btn = document.querySelector('.acct-avatar')
			btn.click()
			const item = [
				...document.querySelectorAll('.acct-menu-item'),
			].find((el) =>
				el.textContent.includes('Delete account')
			)
			expect(item).toBeDefined()
			expect(item.disabled).toBe(false)
			item.click()
			const overlay = document.querySelector(
				'.acct-modal-overlay'
			)
			expect(overlay).not.toBeNull()
			expect(
				overlay.querySelector('#acct-delete-confirm')
			).not.toBeNull()
		})
		test('change password opens a modal (PIN form for PIN accounts)', async () => {
			const originalFetch = global.fetch
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ has_pin: true }),
			})
			try {
				updateAuthNav({ name: 'D', roles: [] })
				const btn =
					document.querySelector('.acct-avatar')
				btn.click()
				const item = [
					...document.querySelectorAll(
						'.acct-menu-item'
					),
				].find((el) =>
					el.textContent.includes(
						'Change password'
					)
				)
				expect(item).toBeDefined()
				item.click()
				await new Promise((r) => setTimeout(r, 0))
				const overlay = document.querySelector(
					'.acct-modal-overlay'
				)
				expect(overlay).not.toBeNull()
				expect(
					overlay.querySelector('#acct-cur-pin')
				).not.toBeNull()
				expect(
					overlay.querySelector('#acct-new-pin')
				).not.toBeNull()
			} finally {
				global.fetch = originalFetch
			}
		})
		test('admin without name shows user icon fallback', () => {
			updateAuthNav({ name: '', roles: ['SUPER_ADMIN'] })
			const btn = document.querySelector('.acct-avatar')
			expect(btn.innerHTML).toContain('<svg')
		})
	})
})
