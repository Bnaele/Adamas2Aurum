import { jest } from '@jest/globals'
import {
	resolve_google_user,
	PIN_ACCOUNT_CONFLICT,
} from './google_user_sync.js'

const googleProfile = {
	sub: 'g_123',
	email: 'Thandi@Gmail.com',
	email_verified: true,
	name: 'Thandi',
	picture: 'https://img/t.png',
}

// db.query answers in call order; records every call.
function fakeDb(...responses) {
	const query = jest.fn()
	for (const r of responses) query.mockResolvedValueOnce(r)
	return { query }
}

const sqlOf = (db) => db.query.mock.calls.map(([sql]) => sql)

describe('resolve_google_user', () => {
	test('matches by Google account id (provider_id), never looking at email', async () => {
		const row = { user_id: 4, email: 'old@gmail.com' }
		const db = fakeDb([[row]])
		expect(await resolve_google_user(db, googleProfile)).toEqual({
			user: row,
		})
		expect(db.query).toHaveBeenCalledTimes(1)
		expect(db.query.mock.calls[0][1]).toEqual(['google:g_123'])
	})

	test('REFUSES an email that belongs to a username + PIN account (the hijack)', async () => {
		const db = fakeDb(
			[[]], // no provider match
			[[{ user_id: 9, has_pin: 1 }]] // PIN account with that email
		)
		expect(await resolve_google_user(db, googleProfile)).toEqual({
			conflict: PIN_ACCOUNT_CONFLICT,
		})
		expect(sqlOf(db).some((s) => /UPDATE|INSERT/.test(s))).toBe(
			false
		)
	})

	test('links an email match that has NO PIN to this Google account', async () => {
		const linked = { user_id: 1, email: 'thandi@gmail.com' }
		const db = fakeDb(
			[[]],
			[[{ user_id: 1, has_pin: 0 }]],
			[{ affectedRows: 1 }],
			[[linked]]
		)
		expect(await resolve_google_user(db, googleProfile)).toEqual({
			user: linked,
		})
		const [sql, params] = db.query.mock.calls[2]
		expect(sql).toMatch(/UPDATE users SET provider_id/)
		expect(params).toEqual(['google:g_123', 1])
	})

	test('creates a new user for a first-time Google sign-in (email lower-cased)', async () => {
		const created = { user_id: 12, email: 'thandi@gmail.com' }
		const db = fakeDb([[]], [[]], [{ insertId: 12 }], [[created]])
		expect(await resolve_google_user(db, googleProfile)).toEqual({
			user: created,
		})
		expect(db.query.mock.calls[1][1]).toEqual(['thandi@gmail.com'])
		const [sql, params] = db.query.mock.calls[2]
		expect(sql).toMatch(/INSERT INTO users/)
		expect(params).toEqual([
			'google:g_123',
			'thandi@gmail.com',
			'Thandi',
			'https://img/t.png',
		])
	})

	test('falls back to the email local-part when Google gives no name', async () => {
		const db = fakeDb(
			[[]],
			[[]],
			[{ insertId: 3 }],
			[[{ user_id: 3 }]]
		)
		await resolve_google_user(db, {
			sub: 'g_9',
			email: 'sipho@gmail.com',
			email_verified: true,
		})
		expect(db.query.mock.calls[2][1]).toEqual([
			'google:g_9',
			'sipho@gmail.com',
			'sipho',
			null,
		])
	})
})
