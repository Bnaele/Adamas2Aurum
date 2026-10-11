import { jest } from '@jest/globals'

// Mock the shared pool before any battle module imports it. A tiny
// in-memory "database" below answers queries by SQL shape, so the real
// battle_socket / battle_state / utils/battle code runs end to end.
jest.unstable_mockModule('../utils/db.js', () => ({
	default: {
		query: jest.fn(),
	},
}))

const { default: pool } = await import('../utils/db.js')
const { get_battle_state, clear_battle_state, list_battle_states } =
	await import('./battle_state.js')
const {
	create_db_battle,
	player_has_submitted_deck,
	save_player_deck,
	check_battle_decks,
	find_player_battle,
	get_players_in_battle,
} = await import('./battle_socket.js')
const { setup_websocket_router } = await import('./socket_router.js')

import { createServer } from 'http'
import WebSocket from 'ws'

// ── Fake database ───────────────────────────────────────────

// Card catalogue: card_id -> card row. Categories are chosen so each
// slot of a deck can perform a different set of actions.
const CATALOGUE = {}
const CATEGORY_BY_SLOT = [
	'CHARACTER',
	'LOCATION',
	'INFLUENCE',
	'HISTORICAL',
	'CHARACTER',
]
for (let id = 1; id <= 30; id++) {
	CATALOGUE[id] = {
		card_id: id,
		name: `Card ${id}`,
		image_url: '',
		category: CATEGORY_BY_SLOT[(id - 1) % 5],
		rarity: id === 29 || id === 30 ? 'LEGENDARY' : 'COMMON',
		stat_attack: 20,
		stat_location: 10,
		stat_influence: 10,
		stat_legacy: 40,
		stat_era: 2000,
	}
}

let db

function resetDb() {
	db = {
		next_battle_id: 100,
		next_deck_id: 1000,
		battles: new Map(), // battle_id -> row
		decks: [], // { deck_id, battle_id, user_id, card_id, slot_position }
		owned: new Map(), // user_id -> Set(card_id)
		npc_pool_size: 5,
		fail_battle_insert: false,
		short_deck_insert: false,
	}
}

function own(user_id, card_ids) {
	db.owned.set(user_id, new Set(card_ids))
}

function norm(sql) {
	return String(sql).trim().toLowerCase().replace(/\s+/g, ' ')
}

function dispatch(sql, params = []) {
	const q = norm(sql)

	if (q.startsWith('select battle_id from battles where (player1_id')) {
		const row = [...db.battles.values()].find(
			(b) =>
				b.status === 'ACTIVE' &&
				(b.player1_id === params[0] ||
					b.player2_id === params[0])
		)
		return [row ? [{ battle_id: row.battle_id }] : [], []]
	}
	if (q.startsWith('select uc.card_id, c.rarity')) {
		const user_id = params.at(-1)
		const owned = db.owned.get(user_id) || new Set()
		const rows = params
			.slice(0, -1)
			.filter((id) => owned.has(id))
			.map((id) => ({
				card_id: id,
				rarity: CATALOGUE[id].rarity,
				category: CATALOGUE[id].category,
			}))
		return [rows]
	}
	if (q.startsWith('insert into battles')) {
		if (db.fail_battle_insert) return [{ affectedRows: 0 }]
		const battle_id = db.next_battle_id++
		db.battles.set(battle_id, {
			battle_id,
			player1_id: params[0],
			player2_id: params[1],
			status: 'ACTIVE',
		})
		return [{ affectedRows: 1, insertId: battle_id }]
	}
	if (q.startsWith('select count(*) as card_count from battle_decks')) {
		const [battle_id, user_id = null] = params
		const card_count = db.decks.filter(
			(d) =>
				d.battle_id === battle_id &&
				d.user_id === user_id
		).length
		return [[{ card_count }]]
	}
	if (q.startsWith('select card_id, stat_legacy from cards')) {
		return [
			[21, 22, 23, 24, 25]
				.slice(0, db.npc_pool_size)
				.map((id) => ({
					card_id: id,
					stat_legacy: 40,
				})),
		]
	}
	if (q.startsWith('insert into battle_decks')) {
		// PvP rows bind 4 params each; NPC rows bind 3 (user_id is NULL).
		const is_npc = q.includes('null')
		const width = is_npc ? 3 : 4
		let inserted = 0
		for (let i = 0; i < params.length; i += width) {
			const [battle_id, user_id, card_id, slot_position] =
				is_npc
					? [
							params[i],
							null,
							params[i + 1],
							params[i + 2],
						]
					: params.slice(i, i + 4)
			db.decks.push({
				deck_id: db.next_deck_id++,
				battle_id,
				user_id,
				card_id,
				slot_position,
			})
			inserted++
		}
		if (db.short_deck_insert) inserted--
		return [{ affectedRows: inserted }]
	}
	if (q.startsWith('select * from battles where battle_id')) {
		const row = db.battles.get(params[0])
		return [row ? [row] : []]
	}
	if (q.startsWith('select bd.deck_id')) {
		const rows = db.decks
			.filter((d) => d.battle_id === params[0])
			.map((d) => ({ ...CATALOGUE[d.card_id], ...d }))
		return [rows]
	}
	if (q.startsWith('update battles set status')) {
		const status = q.match(/status = '(\w+)'/)[1].toUpperCase()
		const row = db.battles.get(params[1])
		if (row) {
			row.status = status
			row.winner_id = params[0]
		}
		return [{ affectedRows: row ? 1 : 0 }]
	}
	return [{ affectedRows: 1, insertId: 1 }]
}

function queriesMatching(pattern) {
	return pool.query.mock.calls.filter(([sql]) => pattern.test(sql))
}

// ── Test harness ────────────────────────────────────────────

// Stand-in for express-session: the test client picks its user via a
// header, the real router still enforces "must have a user_id".
function fakeSession(req, _res, next) {
	const id = Number(req.headers['x-test-user'])
	req.session = id ? { user: { user_id: id, name: `User ${id}` } } : {}
	next()
}

let server
let base_url
const open_sockets = []

function connect(user_id) {
	const ws = new WebSocket(`${base_url}/ws/battle`, {
		headers: { 'x-test-user': String(user_id) },
	})
	ws.inbox = []
	ws.waiters = []
	ws.on('message', (raw) => {
		const msg = JSON.parse(raw)
		const idx = ws.waiters.findIndex((w) => w.type === msg.type)
		if (idx >= 0) ws.waiters.splice(idx, 1)[0].resolve(msg)
		else ws.inbox.push(msg)
	})
	open_sockets.push(ws)
	return new Promise((resolve, reject) => {
		ws.on('open', () => resolve(ws))
		ws.on('error', reject)
	})
}

function next_message(ws, type) {
	const idx = ws.inbox.findIndex((m) => m.type === type)
	if (idx >= 0) return Promise.resolve(ws.inbox.splice(idx, 1)[0])
	return new Promise((resolve) => ws.waiters.push({ type, resolve }))
}

function sendJSON(ws, msg) {
	ws.send(JSON.stringify(msg))
}

async function request(ws, msg, reply_type) {
	sendJSON(ws, msg)
	return next_message(ws, reply_type)
}

async function lastError(ws, msg) {
	return (await request(ws, msg, 'error')).message
}

async function waitUntil(check, max_seconds = 1) {
	const max = (max_seconds * 1000) / 10
	for (let i = 0; i < max; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('condition not met in time')
}

function deckOf(card_ids) {
	return card_ids.map((card_id) => ({ card_id }))
}

async function joinLobby(user_id, reply_type = 'lobby_users') {
	const ws = await connect(user_id)
	const reply = await request(ws, { type: 'join_lobby' }, reply_type)
	return { ws, reply }
}

// Two lobby players challenge/accept, then both submit decks.
async function startPvp(p1_id, p2_id, p1_cards, p2_cards) {
	own(p1_id, p1_cards)
	own(p2_id, p2_cards)
	const { ws: p1 } = await joinLobby(p1_id)
	const { ws: p2 } = await joinLobby(p2_id)

	sendJSON(p1, { type: 'challenge_player', target_user_id: p2_id })
	await next_message(p2, 'incoming_challenge')
	sendJSON(p2, {
		type: 'accept_challenge',
		accept: true,
		challenger_id: p1_id,
	})
	const started = await next_message(p1, 'battle_started')
	await next_message(p2, 'battle_started')

	await request(
		p1,
		{ type: 'submit_deck', deck: deckOf(p1_cards) },
		'deck_accepted'
	)
	sendJSON(p2, { type: 'submit_deck', deck: deckOf(p2_cards) })
	await next_message(p1, 'state_update')
	await next_message(p2, 'state_update')

	return { p1, p2, battle_id: started.battle_id }
}

function attack(ws, attacker_slot, target_slot, action = 'ATTACK') {
	return request(
		ws,
		{ type: 'attack', attacker_slot, target_slot, action },
		'turn_result'
	)
}

// Only the 2-minute abandon timer is intercepted; everything else (ws
// internals, waitUntil) keeps real timers.
const realSetTimeout = global.setTimeout
let abandon_timers = []

beforeAll(async () => {
	jest.spyOn(console, 'log').mockImplementation(() => {})
	jest.spyOn(console, 'error').mockImplementation(() => {})
	jest.spyOn(global, 'setTimeout').mockImplementation(
		(fn, ms, ...rest) => {
			if (ms === 120000) {
				const handle = realSetTimeout(() => {}, 0)
				abandon_timers.push(fn)
				return handle
			}
			return realSetTimeout(fn, ms, ...rest)
		}
	)
	resetDb()
	pool.query.mockImplementation(async (sql, params) =>
		dispatch(sql, params)
	)

	server = createServer()
	await setup_websocket_router(server, fakeSession)
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	base_url = `ws://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
	resetDb()
	abandon_timers = []
	pool.query.mockClear()
})

afterEach(async () => {
	for (const ws of open_sockets.splice(0)) ws.close()
	// Let the server process the closes before the next test.
	await new Promise((r) => realSetTimeout(r, 30))
	// Battle ids restart with each fake db, so drop cached states too.
	for (const state of list_battle_states())
		clear_battle_state(state.battle_id)
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
	console.log.mockRestore()
	console.error.mockRestore()
	global.setTimeout.mockRestore()
})

// ── DB helper tests ─────────────────────────────────────────

describe('battle db helpers', () => {
	test('create_db_battle returns the new id, and throws if nothing was inserted', async () => {
		expect(await create_db_battle(1, 2)).toBe(100)
		expect(db.battles.get(100)).toMatchObject({
			player1_id: 1,
			player2_id: 2,
		})

		db.fail_battle_insert = true
		await expect(create_db_battle(1)).rejects.toThrow(
			'Failed to insert new battle record'
		)
	})

	test('player_has_submitted_deck matches NULL for the CPU', async () => {
		db.decks.push(
			...[0, 1, 2, 3, 4].map((slot) => ({
				battle_id: 5,
				user_id: null,
				card_id: 21,
				slot_position: slot,
			}))
		)
		expect(await player_has_submitted_deck(5, null)).toBe(true)
		expect(await player_has_submitted_deck(5, undefined)).toBe(true)
		expect(await player_has_submitted_deck(5, 1)).toBe(false)

		const [cpu_sql, cpu_params] = pool.query.mock.calls[0]
		expect(norm(cpu_sql)).toContain('user_id is null')
		expect(cpu_params).toEqual([5])
		expect(pool.query.mock.calls[2][1]).toEqual([5, 1])
	})

	test('check_battle_decks needs both players to have submitted', async () => {
		own(1, [1, 2, 3, 4, 5])
		own(2, [6, 7, 8, 9, 10])
		expect(await check_battle_decks(5, 1, 2)).toBe(false)

		await save_player_deck(
			5,
			{ user_id: 1 },
			deckOf([1, 2, 3, 4, 5])
		)
		expect(await check_battle_decks(5, 1, 2)).toBe(false)

		await save_player_deck(
			5,
			{ user_id: 2 },
			deckOf([6, 7, 8, 9, 10])
		)
		expect(await check_battle_decks(5, 1, 2)).toBe(true)
	})

	test('save_player_deck rejects short, duplicate, unowned and partial saves', async () => {
		const user = { user_id: 1 }
		own(1, [1, 2, 3, 4, 5, 29, 30])

		await expect(save_player_deck(5, user, null)).rejects.toThrow(
			'Decks must contain exactly 5 cards'
		)
		await expect(
			save_player_deck(5, user, deckOf([1, 2, 3, 4]))
		).rejects.toThrow('Decks must contain exactly 5 cards')
		await expect(
			save_player_deck(5, user, deckOf([1, 2, 3, 4, 6]))
		).rejects.toThrow('Invalid card selection')
		await expect(
			save_player_deck(5, user, deckOf([1, 2, 3, 29, 30]))
		).rejects.toThrow('Invalid card selection')

		db.short_deck_insert = true
		await expect(
			save_player_deck(5, user, deckOf([1, 2, 3, 4, 5]))
		).rejects.toThrow('Failed to save complete deck')

		db.short_deck_insert = false
		await expect(
			save_player_deck(5, user, deckOf([1, 2, 3, 4, 5]))
		).rejects.toThrow('Player has already submitted cards')
	})

	test('find_player_battle and get_players_in_battle with no battle', () => {
		expect(find_player_battle(12345)).toBeNull()
		expect(get_players_in_battle(12345)).toEqual([])
	})
})

// ── Socket flow tests ───────────────────────────────────────

// Every attack lands unless a test says otherwise. Scoped to the socket
// flows: a constant Math.random also drives source-map's quicksort into
// a stack overflow when Jest maps error stacks under --coverage.
function withLandingAttacks() {
	beforeEach(() => {
		jest.spyOn(Math, 'random').mockReturnValue(0)
	})
	afterEach(() => {
		Math.random.mockRestore()
	})
}

describe('lobby and challenges', () => {
	test('messages before join_lobby fail with a server error', async () => {
		const ws = await connect(1)
		expect(
			await lastError(ws, {
				type: 'challenge_player',
				target_user_id: 2,
			})
		).toBe('Server error')
	})

	test('lobby_users lists everyone waiting in the lobby', async () => {
		const { ws: a } = await joinLobby(1)
		const { ws: b, reply } = await joinLobby(2)
		expect(reply.users.map((u) => u.user_id).sort()).toEqual([1, 2])
		const update = await next_message(a, 'lobby_users')
		expect(update.users).toHaveLength(2)

		b.close()
		await waitUntil(() =>
			a.inbox.some(
				(m) =>
					m.type === 'lobby_users' &&
					m.users.length === 1
			)
		)
	})

	test('challenging a player already in a challenge is refused', async () => {
		const { ws: a } = await joinLobby(1)
		const { ws: b } = await joinLobby(2)
		const { ws: c } = await joinLobby(3)
		sendJSON(a, { type: 'challenge_player', target_user_id: 2 })
		await next_message(b, 'incoming_challenge')
		expect(
			await lastError(c, {
				type: 'challenge_player',
				target_user_id: 2,
			})
		).toBe('Player is unavailable or offline')
	})

	test('accepting creates the battle and starts deck selection', async () => {
		const { ws: a } = await joinLobby(1)
		const { ws: b } = await joinLobby(2)
		sendJSON(a, { type: 'challenge_player', target_user_id: 2 })
		await next_message(b, 'incoming_challenge')

		sendJSON(b, {
			type: 'accept_challenge',
			accept: true,
			challenger_id: 1,
		})
		const started = await next_message(a, 'battle_started')
		expect(started).toMatchObject({
			battle_id: 100,
			player1_id: 1,
			player2_id: 2,
		})
		expect(
			(await next_message(b, 'battle_started')).battle_id
		).toBe(100)

		expect(
			await lastError(b, {
				type: 'accept_challenge',
				accept: true,
				challenger_id: 1,
			})
		).toBe('Already in a battle')

		// Decks aren't in yet, so there's nothing to attack with.
		expect(
			await lastError(a, {
				type: 'attack',
				attacker_slot: 0,
				target_slot: 0,
				action: 'ATTACK',
			})
		).toBe('Battle state not loaded')
	})

	test('a failed battle insert reports an error', async () => {
		const { ws: a } = await joinLobby(1)
		const { ws: b } = await joinLobby(2)
		sendJSON(a, { type: 'challenge_player', target_user_id: 2 })
		await next_message(b, 'incoming_challenge')

		db.fail_battle_insert = true
		expect(
			await lastError(b, {
				type: 'accept_challenge',
				accept: true,
				challenger_id: 1,
			})
		).toBe('Could not start battle')
	})

	test('deck submission errors are sent back to the player', async () => {
		own(1, [1, 2, 3, 4, 5])
		const { ws } = await joinLobby(1)
		await request(
			ws,
			{ type: 'start_npc_battle' },
			'battle_started'
		)
		expect(
			await lastError(ws, {
				type: 'submit_deck',
				deck: deckOf([1, 2, 3]),
			})
		).toBe('Decks must contain exactly 5 cards')
	})
})

describe('reconnecting to an active battle', () => {
	test('before submitting a deck, join_lobby resumes deck selection', async () => {
		db.battles.set(50, {
			battle_id: 50,
			player1_id: 1,
			player2_id: 2,
			status: 'ACTIVE',
		})
		const { reply } = await joinLobby(1, 'battle_started')
		expect(reply.battle_id).toBe(50)
	})

	test('after submitting a deck, join_lobby says to keep waiting', async () => {
		own(1, [1, 2, 3, 4, 5])
		db.battles.set(50, {
			battle_id: 50,
			player1_id: 1,
			player2_id: 2,
			status: 'ACTIVE',
		})
		await save_player_deck(
			50,
			{ user_id: 1 },
			deckOf([1, 2, 3, 4, 5])
		)
		const { reply } = await joinLobby(1, 'deck_accepted')
		expect(reply.battle_id).toBe(50)
	})

	test('rejoining within 2 minutes cancels the abandon timer', async () => {
		const { p1, battle_id } = await startPvp(
			1,
			2,
			[1, 2, 3, 4, 5],
			[6, 7, 8, 9, 10]
		)
		p1.close()
		await waitUntil(() => abandon_timers.length === 1, 130)

		const { reply } = await joinLobby(1, 'state_update')
		expect(reply.battle_id).toBe(battle_id)

		await abandon_timers[0]()
		expect(get_battle_state(battle_id)).not.toBeNull()
		expect(db.battles.get(battle_id).status).toBe('ACTIVE')
	})

	test('staying away for 2 minutes abandons the battle', async () => {
		const { p1, p2, battle_id } = await startPvp(
			1,
			2,
			[1, 2, 3, 4, 5],
			[6, 7, 8, 9, 10]
		)
		p1.close()
		await waitUntil(() => abandon_timers.length === 1)

		await abandon_timers[0]()
		const result = await next_message(p2, 'match_results')
		expect(result.winner).toBe(2)
		expect(db.battles.get(battle_id).status).toBe('ABANDONED')
		expect(get_battle_state(battle_id)).toBeNull()
		expect(queriesMatching(/final_health/)).toHaveLength(10)
	})

	test('a battle that never loaded is abandoned when the timer fires', async () => {
		const { ws: a } = await joinLobby(1)
		const { ws: b } = await joinLobby(2)
		sendJSON(a, { type: 'challenge_player', target_user_id: 2 })
		await next_message(b, 'incoming_challenge')
		sendJSON(b, {
			type: 'accept_challenge',
			accept: true,
			challenger_id: 1,
		})
		const { battle_id } = await next_message(a, 'battle_started')

		a.close()
		await waitUntil(() => abandon_timers.length === 1)
		await abandon_timers[0]()
		await waitUntil(
			() => db.battles.get(battle_id).status === 'ABANDONED'
		)
	})
})

describe('PvP battle', () => {
	withLandingAttacks()

	test('turn order, target validation and a full match to COMPLETED', async () => {
		const { p1, p2, battle_id } = await startPvp(
			1,
			2,
			[1, 2, 3, 4, 5],
			[6, 7, 8, 9, 10]
		)
		expect(find_player_battle(1)).toBe(battle_id)

		expect(
			await lastError(p2, {
				type: 'attack',
				attacker_slot: 0,
				target_slot: 0,
				action: 'ATTACK',
			})
		).toBe('Not your turn')

		const state = get_battle_state(battle_id)
		state.cards.player1[4].health = 0
		state.cards.player2[4].health = 0
		expect(
			await lastError(p1, {
				type: 'attack',
				attacker_slot: 4,
				target_slot: 0,
				action: 'ATTACK',
			})
		).toBe('That card is defeated')
		expect(
			await lastError(p1, {
				type: 'attack',
				attacker_slot: 0,
				target_slot: 4,
				action: 'ATTACK',
			})
		).toBe('Target already defeated')

		// Round 1: p1 buffs its own card (INFLUENCE), p2 attacks.
		const buff = await attack(p1, 2, 0, 'BUFF')
		expect(buff.player_result).toMatchObject({
			action: 'BUFF',
			applied: true,
			stat: 'stat_attack',
		})
		expect(buff.opponent_result).toBeNull()
		expect(buff.winner).toBe(-1)
		expect(buff.state.turn).toBe(2)
		await next_message(p2, 'turn_result')

		const hit = await attack(p2, 0, 1)
		expect(hit.player_result.landed).toBe(true)
		expect(hit.player_result.damage).toBeGreaterThan(0)
		await next_message(p1, 'turn_result')
		// A full round has passed: the 2-round buff ticks down once.
		expect(state.cards.player1[0].effects[0].duration).toBe(1)

		// Round 2: p1 debuffs, p2 misses.
		const debuff = await attack(p1, 2, 0, 'DEBUFF')
		expect(debuff.player_result.amount).toBe(-10)
		await next_message(p2, 'turn_result')

		Math.random.mockReturnValue(0.99)
		const miss = await attack(p2, 0, 0)
		expect(miss.player_result).toMatchObject({
			landed: false,
			damage: 0,
		})
		await next_message(p1, 'turn_result')
		Math.random.mockReturnValue(0)

		// Finish p2 off: everything but slot 0 is down, slot 0 has 1 HP.
		for (const card of state.cards.player2) card.health = 0
		state.cards.player2[0].health = 1
		const final = await attack(p1, 0, 0)
		expect(final.winner).toBe(1)
		const results = await next_message(p2, 'match_results')
		expect(results.winner).toBe(1)

		expect(db.battles.get(battle_id)).toMatchObject({
			status: 'COMPLETED',
			winner_id: 1,
		})
		expect(
			queriesMatching(/INSERT INTO battle_turns/)
		).toHaveLength(5)
		expect(get_battle_state(battle_id)).toBeNull()
		expect(find_player_battle(1)).toBeNull()
	})

	test('DEFEND, DODGE and category-specific attack modifiers', async () => {
		const { p1, p2, battle_id } = await startPvp(
			1,
			2,
			[1, 2, 3, 4, 5],
			[6, 7, 8, 9, 10]
		)
		const state = get_battle_state(battle_id)

		// p1's CHARACTER takes a defensive stance.
		const defend = await attack(p1, 0, 0, 'DEFEND')
		expect(defend.player_result).toMatchObject({
			action: 'DEFEND',
			applied: true,
			amount: 4,
		})
		await next_message(p2, 'turn_result')

		// p2's LOCATION dodges, buffing its own location.
		const dodge = await attack(p2, 1, 1, 'DODGE')
		expect(dodge.player_result).toMatchObject({
			stat: 'stat_location',
			amount: 10,
			duration: 1,
		})
		await next_message(p1, 'turn_result')

		// p1 attacks p2's HISTORICAL card, then p2's LOCATION card hits
		// p1's defended CHARACTER (defence absorbs, damage floors at 1).
		const vs_historical = await attack(p1, 0, 3)
		expect(vs_historical.player_result.landed).toBe(true)
		await next_message(p2, 'turn_result')

		const vs_defended = await attack(p2, 1, 0)
		expect(vs_defended.player_result.damage).toBe(1)
		expect(state.cards.player1[0].effects).toEqual([])
		await next_message(p1, 'turn_result')

		// Wrong category for the action.
		expect(
			await lastError(p1, {
				type: 'attack',
				attacker_slot: 1,
				target_slot: 0,
				action: 'BUFF',
			})
		).toBe("LOCATION cards can't BUFF")
		expect(
			await lastError(p1, {
				type: 'attack',
				attacker_slot: 2,
				target_slot: 0,
				action: 'REVIVE',
			})
		).toBe("INFLUENCE cards can't REVIVE")
	})

	test('forfeiting hands the win to the opponent', async () => {
		const { p1, p2, battle_id } = await startPvp(
			1,
			2,
			[1, 2, 3, 4, 5],
			[6, 7, 8, 9, 10]
		)
		sendJSON(p2, { type: 'forfeit' })
		expect((await next_message(p1, 'match_results')).winner).toBe(1)
		expect(db.battles.get(battle_id)).toMatchObject({
			status: 'FORFEITED',
			winner_id: 1,
		})
	})
})

describe('NPC battle', () => {
	withLandingAttacks()

	test('not enough cards to build the CPU deck', async () => {
		db.npc_pool_size = 3
		const { ws } = await joinLobby(1)
		expect(await lastError(ws, { type: 'start_npc_battle' })).toBe(
			'Failed to start NPC match'
		)
	})

	test('a partially saved CPU deck is reported', async () => {
		db.short_deck_insert = true
		const { ws } = await joinLobby(1)
		expect(await lastError(ws, { type: 'start_npc_battle' })).toBe(
			'Failed to start NPC match'
		)
	})

	test('the CPU answers every move until the player wins', async () => {
		own(1, [1, 2, 3, 4, 5])
		const { ws } = await joinLobby(1)
		const started = await request(
			ws,
			{ type: 'start_npc_battle' },
			'battle_started'
		)
		expect(started.is_npc).toBe(true)
		const battle_id = started.battle_id

		const loaded = await request(
			ws,
			{ type: 'submit_deck', deck: deckOf([1, 2, 3, 4, 5]) },
			'state_update'
		)
		expect(loaded.state.player2_id).toBeNull()
		expect(loaded.state.cards.player2).toHaveLength(5)

		const turn = await attack(ws, 0, 0)
		expect(turn.player_result.landed).toBe(true)
		expect(turn.opponent_result).toMatchObject({
			action: 'ATTACK',
			landed: true,
		})
		expect(turn.state.turn).toBe(1)
		expect(turn.state.turn_number).toBe(2)
		expect(turn.winner).toBe(-1)
		// Both the player's and the CPU's turn are logged.
		expect(
			queriesMatching(/INSERT INTO battle_turns/)
		).toHaveLength(2)

		const state = get_battle_state(battle_id)
		for (const card of state.cards.player2) card.health = 0
		state.cards.player2[0].health = 1
		const final = await attack(ws, 0, 0)
		expect(final.winner).toBe(1)
		expect(final.opponent_result).toBeNull()
		await next_message(ws, 'match_results')
		expect(db.battles.get(battle_id).status).toBe('COMPLETED')
	})

	test('the CPU can win', async () => {
		own(1, [1, 2, 3, 4, 5])
		const { ws } = await joinLobby(1)
		const { battle_id } = await request(
			ws,
			{ type: 'start_npc_battle' },
			'battle_started'
		)
		await request(
			ws,
			{ type: 'submit_deck', deck: deckOf([1, 2, 3, 4, 5]) },
			'state_update'
		)

		const state = get_battle_state(battle_id)
		for (const card of state.cards.player1) card.health = 0
		state.cards.player1[0].health = 1
		const turn = await attack(ws, 0, 0)
		expect(turn.opponent_result.target_health_after).toBe(0)
		expect(turn.winner).toBeNull()
		expect(
			(await next_message(ws, 'match_results')).winner
		).toBeNull()
		expect(db.battles.get(battle_id)).toMatchObject({
			status: 'COMPLETED',
			winner_id: null,
		})
	})
})
