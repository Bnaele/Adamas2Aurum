import { WebSocketServer } from 'ws'
import pool from '../utils/db.js'
import {
	TURN_TIMEOUT_MS,
	BATTLE_DECK_NO_CARDS,
	valid_user_cards,
	deck_violation,
	get_active_battle,
} from '../utils/battle.js'
import {
	load_battle_state,
	get_battle_state,
	clear_battle_state,
} from './battle_state.js'
import {
	get_effective_stat,
	apply_defence,
	apply_buff,
	apply_debuff,
	apply_defence_stance,
	apply_revive,
	tick_effects,
	TEAM_ACTIONS,
} from './battle_effects.js'
import { broadcast_to_spectators, clear_spectators } from './spectate_socket.js'
import { applyRatingUpdate } from '../services/rating.js'

/* A mapping from players user_id to the timeout interval */
const disconnected_players = new Map()
/* A mapping from a players user id to a JS object.
 * user_id -> {
 * 	ws, // the websocket connection used to communicate with the player.
 * 	battle_id, // the battle id of the player used to distinguish if they are the lobby, a pending battle request, or active battle.
 * 	user_id, // a redundant field for an easily accesible user id of the player.
 * 	name, // the name of the user/player
 * 	username, // the username of the user/player
 * }
 */
const active_players = new Map()
/* A mapping from battle_id to active turn timeout timers */
const turn_timers = new Map()

function clear_turn_timer(battle_id) {
	if (turn_timers.has(battle_id)) {
		const timerData = turn_timers.get(battle_id)
		clearTimeout(timerData.id)
		turn_timers.delete(battle_id)
	}
}

function start_turn_timer(battle_id) {
	clear_turn_timer(battle_id)
	const id = setTimeout(
		() => handle_turn_timeout(battle_id),
		TURN_TIMEOUT_MS
	)
	turn_timers.set(battle_id, {
		id: id,
		started_at: Date.now(),
		duration: TURN_TIMEOUT_MS,
	})
}

function get_turn_timer(battle_id) {
	if (!turn_timers.has(battle_id)) {
		return 0
	}
	const timerData = turn_timers.get(battle_id)
	const elapsed = Date.now() - timerData.started_at
	return Math.max(0, timerData.duration - elapsed)
}

function get_player_connection(user_id) {
	return active_players.get(user_id) || null
}

function clear_player_connection(user_id) {
	if (user_id !== null || user_id !== undefined)
		active_players.delete(user_id)
}

export function get_players_in_battle(battle_id) {
	const players = []
	const state = get_battle_state(battle_id)

	if (!state) return players

	if (state.player1_id !== null) players.push(player1_id)
	if (state.player2_id !== null) players.push(player2_id)
	return players
}

export function get_active_players_in_battle(battle_id) {
	const players = get_players_in_battle(battle_id)
	players.map((x) => get_player_connection(x)).filter((x) => x !== null)
	return players
}

async function update_battle_players(battle_id, payload) {
	const state = get_battle_state(battle_id)
	if (!state) {
		return
	}

	const p1 = get_player_connection(state.player1_id)
	const p2 = get_player_connection(state.player2_id)

	if (p1 && p1.ws.readyState === 1) p1.ws.send(payload)
	if (p2 && p2.ws.readyState === 1) p2.ws.send(payload)
	broadcast_to_spectators(battle_id, payload)
}

/* battle_id = null: connected to battle site and active in lobby
 * battle_id = -1: received or issued a pending battle challenge
 * battle_id >= 0: currently in an active battle
 */
function get_online_lobby_users() {
	const available = []
	for (const [id, player] of active_players.entries()) {
		if (player.battle_id === null) {
			available.push({
				user_id: id,
				username: player.username,
				name: player.name,
			})
		}
	}
	return available
}

function broadcast_lobby_presence() {
	const users = get_online_lobby_users()
	const payload = JSON.stringify({ type: 'lobby_users', users })

	for (const [, player] of active_players.entries()) {
		// Send updates only to players currently resting in the lobby
		if (player.battle_id === null && player.ws.readyState === 1) {
			player.ws.send(payload)
		}
	}
}

async function set_battle_finished(
	battle_id,
	reason,
	winner = null,
	loser = null
) {
	if (battle_id === null) return
	if (
		![
			'PENDING',
			'ACTIVE',
			'COMPLETED',
			'FORFEITED',
			'ABANDONED',
		].includes(reason)
	)
		reason = 'ABANDONED'

	await pool.query(
		`UPDATE battles SET status = '${reason}', winner_id = ?, ended_at = NOW() WHERE battle_id = ?`,
		[winner, battle_id]
	)

	// Ranked rating update. Only fires when both a winner and a human
	// loser are known — NPC battles pass loser=null and are skipped
	// naturally, same as the disconnect/abandon path below.
	if (winner !== null && loser !== null) {
		try {
			await applyRatingUpdate(pool, winner, loser)
		} catch (err) {
			console.error('rating update failed:', err)
		}
	}
}

// 1. Create a PvP or NPC Battle row in MySQL
export async function create_db_battle(player1_id, player2_id = null) {
	const [result] = await pool.query(
		`INSERT INTO battles (
            player1_id, player2_id, winner_id, status, started_at, ended_at
        ) VALUES (?, ?, NULL, 'ACTIVE', CURRENT_TIMESTAMP, NULL)`,
		[player1_id, player2_id]
	)

	if (result.affectedRows === 0) {
		throw new Error('Failed to insert new battle record')
	}

	return result.insertId
}

export async function player_has_submitted_deck(battle_id, user_id) {
	const isNull = user_id === null || user_id === undefined

	const query = `
        SELECT COUNT(*) AS card_count
        FROM battle_decks
        WHERE battle_id = ?
          AND ${isNull ? 'user_id IS NULL' : 'user_id = ?'}
    `
	const params = isNull ? [battle_id] : [battle_id, user_id]

	const [rows] = await pool.query(query, params)

	return rows[0].card_count === BATTLE_DECK_NO_CARDS
}

// 2. Validate and save a player's selected deck for a battle
export async function save_player_deck(battle_id, user, deck) {
	if (!deck || deck.length !== BATTLE_DECK_NO_CARDS) {
		throw new Error(
			`Decks must contain exactly ${BATTLE_DECK_NO_CARDS} cards`
		)
	}

	const has_submitted = await player_has_submitted_deck(
		battle_id,
		user.user_id
	)
	if (has_submitted) {
		throw new Error(
			'Player has already submitted cards for this battle'
		)
	}

	const violation = await deck_violation(user, deck)
	if (violation) {
		throw new Error(`Invalid card selection: ${violation}`)
	}

	const values = []
	const placeholders = deck
		.map((card, idx) => {
			values.push(battle_id, user.user_id, card.card_id, idx)
			return '(?,?,?,?)'
		})
		.join(',')

	const [result] = await pool.query(
		`INSERT INTO battle_decks (battle_id, user_id, card_id, slot_position)
         VALUES ${placeholders}`,
		values
	)

	if (result.affectedRows !== BATTLE_DECK_NO_CARDS) {
		throw new Error('Failed to save complete deck')
	}

	return result
}

export async function check_battle_decks(battle_id, p1_user_id, p2_user_id) {
	const p1_has_submitted = await player_has_submitted_deck(
		battle_id,
		p1_user_id
	)
	if (!p1_has_submitted) return false
	const p2_has_submitted = await player_has_submitted_deck(
		battle_id,
		p2_user_id
	)
	if (!p2_has_submitted) return false
	return true
}

async function build_npc_deck(battle_id) {
	const [cards] = await pool.query(
		`SELECT card_id, stat_legacy FROM cards ORDER BY RAND() LIMIT ${BATTLE_DECK_NO_CARDS}`
	)

	if (cards.length < BATTLE_DECK_NO_CARDS) {
		throw new Error(
			'Not enough cards in the pool to build an NPC deck'
		)
	}

	const values = []
	const placeholders = cards
		.map((card, idx) => {
			values.push(battle_id, card.card_id, idx)
			return '(?, NULL, ?, ?)'
		})
		.join(',')

	const [result] = await pool.query(
		`INSERT INTO battle_decks
		 (battle_id, user_id, card_id, slot_position) VALUES
		 ${placeholders}`,
		values
	)

	if (result.affectedRows !== BATTLE_DECK_NO_CARDS) {
		throw new Error('Failed to build NPC deck')
	}

	return result
}

function next_turn(state) {
	return state.turn === state.player1_id
		? state.player2_id
		: state.player1_id
}

function find_card(cards, slot_position) {
	return cards.find((c) => c.slot_position === slot_position) || null
}

function is_players_turn(state, user_id) {
	return state.turn === user_id
}

function is_valid_attacker(cards, slot_position) {
	const card = find_card(cards, slot_position)
	if (!card) return { ok: false, reason: 'No card in that slot' }
	if (card.health <= 0)
		return { ok: false, reason: 'That card is defeated' }
	return { ok: true, card }
}

function is_valid_target(action, cards, slot_position) {
	const card = find_card(cards, slot_position)
	if (!card) return { ok: false, reason: 'No opponent card in that slot' }
	if (card.health <= 0 && action != 'REVIVE')
		return { ok: false, reason: 'Target already defeated' }
	return { ok: true, card }
}

async function log_turn(
	battle_id,
	turn_number,
	acting_user_id,
	attacker,
	target,
	action,
	result
) {
	const landed = action === 'ATTACK' ? result.landed : null
	const damage = action === 'ATTACK' ? result.damage : 0

	await pool.query(
		`INSERT INTO battle_turns
		 (battle_id, turn_number, acting_user_id, deck_slot_played_id, deck_slot_targeted_id, action, damage_dealt, landed, effect_data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			battle_id,
			turn_number,
			acting_user_id,
			attacker.deck_id,
			target.deck_id,
			action,
			damage,
			landed,
			JSON.stringify(result),
		]
	)
}

async function persist_final_health(state) {
	for (const card of [...state.cards.player1, ...state.cards.player2]) {
		await pool.query(
			'UPDATE battle_decks SET final_health = ? WHERE deck_id = ?',
			[card.health, card.deck_id]
		)
	}
}

function calculate_defence(target) {
	const target_legacy = get_effective_stat(target, 'stat_legacy')
	const target_era = get_effective_stat(target, 'stat_era')

	let current_year = 2026
	let era_age = Math.max(0, current_year - target_era)

	// adjust weights to balance era and legacy impact
	let raw_input = era_age * 0.5 + target_legacy * 0.8

	let max_cap = 30
	// lower rate to make high defense harder to achieve
	let rate = 0.015

	return max_cap * (1 - Math.exp(-rate * raw_input))
}

function resolve_attack(attacker, target) {
	const attacker_attack = get_effective_stat(attacker, 'stat_attack')
	const attacker_location = get_effective_stat(attacker, 'stat_location')
	const target_location = get_effective_stat(target, 'stat_location')

	let hit_chance = Math.min(
		0.95,
		1.0 - target_location / 100 + attacker_location / 100
	)
	if (target.category === 'LOCATION') hit_chance *= 0.9
	if (Math.random() >= hit_chance) {
		return {
			landed: false,
			damage: 0,
			target_health_after: target.health,
		}
	}

	let defence = calculate_defence(target)
	if (target.category === 'HISTORICAL') defence *= 1.1

	let damage = attacker_attack
	if (attacker.category === 'CHARACTER') damage *= 1.5
	damage = Math.max(
		1,
		apply_defence(target, Math.round(damage - defence))
	)

	target.health = Math.max(0, target.health - damage)
	return {
		landed: true,
		damage,
		target_health_after: target.health,
	}
}

function get_target_pool(player_cards, opponent_cards, action) {
	return action === 'BUFF' || action === 'REVIVE'
		? player_cards
		: opponent_cards
}

const ABILITY_DEFAULTS = { stat: 'stat_attack', amount: 10, duration: 2 }

function resolve_action(attacker, target, action) {
	switch (action) {
		case 'ATTACK':
			return resolve_attack(attacker, target)
		case 'DEFEND':
			return apply_defence_stance(
				attacker,
				Math.round(attacker.stat_legacy / 10)
			)
		case 'DODGE':
			return apply_buff(
				attacker,
				target,
				'stat_location',
				10,
				1
			)
		case 'BUFF':
			return apply_buff(
				attacker,
				target,
				ABILITY_DEFAULTS.stat,
				ABILITY_DEFAULTS.amount,
				ABILITY_DEFAULTS.duration
			)
		case 'DEBUFF':
			return apply_debuff(
				attacker,
				target,
				ABILITY_DEFAULTS.stat,
				ABILITY_DEFAULTS.amount,
				ABILITY_DEFAULTS.duration
			)
		case 'REVIVE':
			return apply_revive(
				target,
				Math.round(target.stat_legacy / 2),
				3
			)
		default:
			throw new Error(`Unhandled action: ${action}`)
	}
}

function is_action_valid_for_category(category, action) {
	//   INFLUENCE: ATTACK, BUFF, and DEBUFF
	//   CHARACTER:  ATTACK, and DEFEND (highest damage)
	//   LOCATION: ATTACK, DODGE, and DEFEND (skews hit/dodge chance)
	//   HISTORICAL: ATTACK, DEFEND, and reviving a defeated CHARACTER (not built yet)
	const allowed = {
		CHARACTER: ['ATTACK', 'DEFEND'],
		LOCATION: ['ATTACK', 'DODGE', 'DEFEND'],
		INFLUENCE: ['ATTACK', 'BUFF', 'DEBUFF'],
		HISTORICAL: ['ATTACK', 'DEFEND'],
	}
	return (allowed[category] || []).includes(action)
}

function take_cpu_turn(state) {
	const alive_cpu = state.cards.player2.filter((c) => c.health > 0)
	const alive_player = state.cards.player1.filter((c) => c.health > 0)
	if (!alive_cpu.length || !alive_player.length) return null

	const attacker = alive_cpu[Math.floor(Math.random() * alive_cpu.length)]
	const target =
		alive_player[Math.floor(Math.random() * alive_player.length)]
	const result = resolve_action(attacker, target, 'ATTACK')

	return {
		action: 'ATTACK',
		attacker_slot: attacker.slot_position,
		target_slot: target.slot_position,
		result,
	}
}

function check_battle_over(state) {
	if (!state.cards.player1.some((c) => c.health > 0))
		return state.player2_id
	if (!state.cards.player2.some((c) => c.health > 0))
		return state.player1_id
	return -1
}

export function find_player_battle(user_id) {
	const player_connection = get_player_connection(user_id)
	if (player_connection === null) return null
	const state = get_battle_state(player_connection.battle_id)
	if (state === null) {
		clear_player_connection(user_id)
		return null
	}
	return state.battle_id
}

async function handle_turn_timeout(battle_id) {
	const state = get_battle_state(battle_id)
	if (!state) {
		clear_turn_timer(battle_id)
		return
	}

	const timed_out_user = state.turn
	let opponent_result = null

	// Advance turn to next player
	state.turn = next_turn(state)

	if (state.player2_id === null && state.turn === null) {
		state.turn_number += 0.5
		const cpu_result = take_cpu_turn(state)
		if (cpu_result) {
			opponent_result = {
				attacker_slot: cpu_result.attacker_slot,
				target_slot: cpu_result.target_slot,
				action: cpu_result.action,
				...cpu_result.result,
			}
			await log_turn(
				battle_id,
				state.turn_number,
				null,
				state.cards.player2[cpu_result.attacker_slot],
				state.cards.player1[cpu_result.target_slot],
				cpu_result.action,
				cpu_result.result
			)
		}
		state.turn_number += 0.5
		if (state.turn_number > 1) tick_effects(state)
		state.turn = next_turn(state)
	} else {
		state.turn_number += 0.5
	}

	if (state.turn_number >= 1 && state.turn_number % 1 === 0) {
		tick_effects(state)
	}

	let winner = check_battle_over(state)

	const turn_payload = JSON.stringify({
		type: 'turn_timeout',
		battle_id,
		player_user_id: timed_out_user,
		player_result: 'turn_timeout',
		opponent_result,
		state,
		turn_timer_ms: 30 * 1000,
		winner,
	})
	await update_battle_players(battle_id, turn_payload)

	if (winner !== -1) {
		await set_battle_finished(battle_id, 'COMPLETED', winner)
		await persist_final_health(state)

		const match_results_payload = JSON.stringify({
			type: 'match_results',
			winner,
		})
		await update_battle_players(battle_id, match_results_payload)
		clear_turn_timer(battle_id)
		clear_player_connection(state.player1_id)
		clear_player_connection(state.player2_id)
		clear_battle_state(battle_id)

		broadcast_lobby_presence()
	} else {
		// Restart timer for the next turn
		start_turn_timer(battle_id)
	}
}

export const battleWss = new WebSocketServer({ noServer: true })

battleWss.on('connection', (ws, request) => {
	const user_id = request.user.user_id
	let battle_id = null
	if (!user_id) {
		ws.close(4001, 'Unauthorized')
		return
	}

	ws.on('message', async (raw) => {
		let msg
		try {
			msg = JSON.parse(raw)
		} catch {
			return ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Invalid JSON',
				})
			)
		}

		console.log(
			`[WebSocket Log] ${new Date().toISOString()} - ${request.method} ${request.url} ${msg.type}`
		)
		try {
			if (msg.type === 'ping') {
				return ws.send(
					JSON.stringify({
						type: 'pong',
					})
				)
			} else if (msg.type === 'join_lobby') {
				const old_battle_id =
					await get_active_battle(user_id)
				const pending_timeout =
					disconnected_players.get(user_id)
				if (pending_timeout) {
					clearTimeout(pending_timeout)
					disconnected_players.delete(user_id)
				}
				active_players.set(user_id, {
					ws,
					battle_id: old_battle_id,
					user_id,
					name: request.user.name,
					username: request.user.name,
				})
				if (old_battle_id) {
					const state =
						await load_battle_state(
							old_battle_id
						)
					if (state) {
						const state_payload =
							JSON.stringify({
								type: 'state_update',
								battle_id: old_battle_id,
								state,
								turn_timer_ms:
									get_turn_timer(
										old_battle_id
									) -
									1 *
										1000,
							})
						ws.send(state_payload)
					} else {
						const myDeckSubmitted =
							await player_has_submitted_deck(
								old_battle_id,
								user_id
							)
						if (!myDeckSubmitted) {
							ws.send(
								JSON.stringify({
									type: 'battle_started',
									battle_id: old_battle_id,
								})
							)
						} else {
							ws.send(
								JSON.stringify({
									type: 'deck_accepted',
									battle_id: old_battle_id,
									message: 'Deck saved. Waiting for opponent...',
								})
							)
						}
					}
				} else {
					broadcast_lobby_presence()
				}
			} else if (msg.type === 'challenge_player') {
				battle_id =
					get_player_connection(user_id).battle_id
				if (battle_id !== null)
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Already in battle',
						})
					)
				if (msg.target_user_id === null) {
					get_player_connection(
						user_id
					).battle_id = null
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Target user id invalid',
						})
					)
				}
				const target = get_player_connection(
					msg.target_user_id
				)

				if (!target || target.battle_id !== null) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Player is unavailable or offline',
						})
					)
				}

				get_player_connection(user_id).battle_id = -1
				target.battle_id = -1

				target.ws.send(
					JSON.stringify({
						type: 'incoming_challenge',
						from_user_id: user_id,
						from_username:
							request.user.name,
					})
				)

				broadcast_lobby_presence()
			} else if (msg.type === 'accept_challenge') {
				const current_p2 =
					get_player_connection(user_id)
				if (current_p2 && current_p2.battle_id > 0) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Already in a battle',
						})
					)
				}
				if (!msg.accept) {
					current_p2.battle_id = null
					const challenger =
						get_player_connection(
							msg.challenger_id
						)
					challenger.battle_id = null
					return challenger.ws.send(
						JSON.stringify({
							type: 'reject_challenge',
							challenger_id:
								msg.challenger_id,
						})
					)
				}

				try {
					// 1. Create DB entry for the match
					const new_battle_id =
						await create_db_battle(
							msg.challenger_id,
							user_id
						)

					// 2. Update player states in memory
					const p1 = get_player_connection(
						msg.challenger_id
					)
					const p2 =
						get_player_connection(user_id)

					if (p1) p1.battle_id = new_battle_id
					if (p2) p2.battle_id = new_battle_id

					// 3. Prompt both players to select/confirm decks
					const start_payload = JSON.stringify({
						type: 'battle_started',
						battle_id: new_battle_id,
						player1_id: msg.challenger_id,
						player2_id: user_id,
					})

					if (p1 && p1.ws.readyState === 1)
						p1.ws.send(start_payload)
					if (p2 && p2.ws.readyState === 1)
						p2.ws.send(start_payload)

					broadcast_lobby_presence()
				} catch (err) {
					ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Could not start battle',
						})
					)
				}
			} else if (msg.type === 'start_npc_battle') {
				try {
					const new_battle_id =
						await create_db_battle(
							user_id,
							null
						)
					await build_npc_deck(new_battle_id)

					const player =
						get_player_connection(user_id)
					if (player)
						player.battle_id = new_battle_id

					ws.send(
						JSON.stringify({
							type: 'battle_started',
							battle_id: new_battle_id,
							is_npc: true,
						})
					)

					broadcast_lobby_presence()
				} catch (err) {
					ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Failed to start NPC match',
						})
					)
				}
			} else if (msg.type === 'submit_deck') {
				const player_info =
					get_player_connection(user_id)
				if (
					!player_info ||
					!player_info.battle_id ||
					player_info.battle_id <= 0
				) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Not currently in an active battle',
						})
					)
				}

				try {
					await save_player_deck(
						player_info.battle_id,
						request.user,
						msg.deck
					)

					const missing_deck_payload =
						JSON.stringify({
							type: 'deck_accepted',
							message: 'Deck saved. Waiting for opponent...',
						})

					const state = await load_battle_state(
						player_info.battle_id
					)
					if (!state) {
						return ws.send(
							missing_deck_payload
						)
					}

					const state_payload = JSON.stringify({
						type: 'state_update',
						battle_id: state.battle_id,
						state,
						turn_timer_ms: 30 * 1000,
					})
					await update_battle_players(
						player_info.battle_id,
						state_payload
					)

					start_turn_timer(player_info.battle_id)
				} catch (err) {
					ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: err.message,
						})
					)
				}
			} else if (msg.type === 'forfeit') {
				battle_id =
					get_player_connection(user_id).battle_id
				if (battle_id === null || battle_id === -1)
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Join a battle first',
						})
					)
				const state = get_battle_state(battle_id)

				const winner =
					state.player1_id === user_id
						? state.player2_id
						: state.player1_id
				clear_turn_timer(battle_id)
				await set_battle_finished(
					battle_id,
					'FORFEITED',
					winner,
					user_id
				)
				await persist_final_health(state)

				const match_results_payload = JSON.stringify({
					type: 'match_results',
					winner,
				})
				await update_battle_players(
					battle_id,
					match_results_payload
				)
				clear_player_connection(state.player1_id)
				clear_player_connection(state.player2_id)
				clear_battle_state(battle_id)
				clear_spectators(battle_id)

				broadcast_lobby_presence()
			} else if (msg.type === 'attack') {
				battle_id =
					get_player_connection(user_id).battle_id
				if (battle_id === null || battle_id === -1)
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Join a battle first',
						})
					)

				const state = get_battle_state(battle_id)
				if (!state)
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Battle state not loaded',
						})
					)

				let player_cards,
					opponent_cards,
					player_id,
					opponent_id
				if (user_id === state.player1_id) {
					player_id = state.player1_id
					player_cards = state.cards.player1

					opponent_id = state.player2_id
					opponent_cards = state.cards.player2
				} else {
					player_id = state.player2_id
					player_cards = state.cards.player2

					opponent_id = state.player1_id
					opponent_cards = state.cards.player1
				}
				if (!is_players_turn(state, user_id)) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: 'Not your turn',
						})
					)
				}
				const attacker_check = is_valid_attacker(
					player_cards,
					msg.attacker_slot
				)
				if (!attacker_check.ok) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: attacker_check.reason,
						})
					)
				}
				const target_check = is_valid_target(
					msg.action,
					TEAM_ACTIONS.includes(msg.action)
						? player_cards
						: opponent_cards,
					msg.target_slot
				)
				if (!target_check.ok) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: target_check.reason,
						})
					)
				}
				if (
					!is_action_valid_for_category(
						attacker_check.card.category,
						msg.action
					)
				) {
					return ws.send(
						JSON.stringify({
							reject_type: msg.type,
							type: 'error',
							message: `${attacker_check.card.category} cards can't ${msg.action}`,
						})
					)
				}

				let player_result = resolve_action(
					attacker_check.card,
					target_check.card,
					msg.action
				)
				await log_turn(
					battle_id,
					state.turn_number,
					user_id,
					attacker_check.card,
					target_check.card,
					msg.action,
					player_result
				)
				player_result = {
					attacker_slot: msg.attacker_slot,
					target_slot: msg.target_slot,
					action: msg.action,
					...player_result,
				}

				let winner = check_battle_over(state)
				let opponent_result = null

				if (winner === -1) {
					state.turn = next_turn(state)

					if (opponent_id === null) {
						// NPC Logic branch
						state.turn_number += 0.5
						const cpu_result =
							take_cpu_turn(state)
						opponent_result = {
							attacker_slot:
								cpu_result.attacker_slot,
							target_slot:
								cpu_result.target_slot,
							action: cpu_result.action,
							...cpu_result.result,
						}

						if (cpu_result) {
							await log_turn(
								battle_id,
								state.turn_number,
								null,
								opponent_cards[
									cpu_result
										.attacker_slot
								],
								player_cards[
									cpu_result
										.target_slot
								],
								cpu_result.action,
								cpu_result.result
							)
						}

						winner =
							check_battle_over(state)
						state.turn_number += 0.5
						if (state.turn_number > 1)
							tick_effects(state)
						state.turn = next_turn(state)
					} else {
						// PVP Logic
						state.turn_number += 0.5
					}

					if (
						state.turn_number >= 1 &&
						state.turn_number % 1 === 0
					) {
						tick_effects(state)
						winner =
							check_battle_over(state)
					}
				}

				const turn_payload = JSON.stringify({
					type: 'turn_result',
					player_result,
					player_user_id: user_id,
					opponent_result,
					battle_id: state.battle_id,
					state,
					turn_timer_ms: 30 * 1000,
					winner,
				})
				await update_battle_players(
					state.battle_id,
					turn_payload
				)

				if (winner !== -1) {
					clear_turn_timer(battle_id)
					const loser =
						winner === state.player1_id
							? state.player2_id
							: state.player1_id
					await set_battle_finished(
						battle_id,
						'COMPLETED',
						winner,
						loser
					)
					await persist_final_health(state)

					const match_results_payload =
						JSON.stringify({
							type: 'match_results',
							winner,
						})
					await update_battle_players(
						battle_id,
						match_results_payload
					)
					clear_player_connection(
						state.player1_id
					)
					clear_player_connection(
						state.player2_id
					)
					clear_battle_state(battle_id)
					clear_spectators(battle_id)
					broadcast_lobby_presence()
				} else {
					start_turn_timer(battle_id)
				}
			} else {
				ws.send(
					JSON.stringify({
						reject_type: msg.type,
						type: 'error',
						message: `Unknown message type: ${msg.type}`,
					})
				)
			}
		} catch (err) {
			console.error('battle socket error:', err)
			ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Server error',
				})
			)
		}
	})

	ws.on('error', (ev) => {
		console.error(
			`[WebSocket Error] ${new Date().toISOString()} - `,
			ev
		)
	})

	ws.on('close', (ev) => {
		const player = get_player_connection(user_id)

		// If they were in a active match, flag the match as abandoned
		if (player && player.battle_id > 0) {
			const existing_timeout = disconnected_players.get(
				player.user_id
			)
			if (existing_timeout) clearTimeout(existing_timeout)
			const timeout_id = setTimeout(async () => {
				if (
					disconnected_players.get(
						player.user_id
					) === undefined
				)
					return

				const state = get_battle_state(player.battle_id)
				if (state === null) {
					set_battle_finished(
						player.battle_id,
						'ABANDONED',
						null
					)
					return
				}

				const is_active = get_player_connection(
					player.user_id
				)
				if (is_active) {
					disconnected_players.delete(
						player.user_id
					)
					return
				}
				const match_results_payload = JSON.stringify({
					type: 'match_results',
					winner:
						state.player1_id ===
						player.user_id
							? state.player2_id
							: state.player1_id,
				})
				await update_battle_players(
					player.battle_id,
					match_results_payload
				)
				set_battle_finished(
					player.battle_id,
					'ABANDONED',
					null
				)
				await persist_final_health(state)
				clear_turn_timer(battle_id)
				clear_battle_state(player.battle_id)
				clear_spectators(player.battle_id)
			}, 120000) // 2 minutes
			disconnected_players.set(player.user_id, timeout_id)
		}

		// Remove connection and update lobby list
		clear_player_connection(user_id)
		broadcast_lobby_presence()
	})
})
