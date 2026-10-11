import {
	EVENTS_API,
	showToast,
	toDatetimeLocal,
	buildCardBody,
} from './utils.js'
import { API_BASE, API_BASE_WS } from './constants.js'
import { updateAuthNav, logout } from './auth-helpers.js'
import { startChromeDayNightCycle } from './campus-style.js'

// No live map on this page — drive the shared `body.night` chrome theme
// from the same day/night check as the map. The admin console never does
// this, so it stays light.
startChromeDayNightCycle()

var ws = null
let wsRetryCount = 0
var user = null

const AUTH_API = `${API_BASE}/api/auth`

const BATTLE_DECK_NO_CARDS = 5
let turnTimerInterval = null

;(async function createSlots() {
	const deck_slots = document.getElementById('deck-slots')
	deck_slots.replaceChildren()

	const slotsHTML = Array.from(
		{ length: BATTLE_DECK_NO_CARDS },
		(_, index) => {
			const slotIndex = index + 1
			return `<div class="deck-slot" data-slot="${slotIndex}"><span class="deck-slot-num">${slotIndex}</span></div>`
		}
	).join('')

	deck_slots.innerHTML = slotsHTML
})()

const elOpponentSelectionView = document.getElementById('view-opponent-select')
const elOpponentGrid = document.getElementById('opponent-grid')
const elOpponentLoading = document.getElementById('opponent-loading')
const elOpponentEmpty = document.getElementById('opponent-empty')

const elCardSelectionView = document.getElementById('view-deck-select')
const elCardCollection = document.getElementById('collection-grid')
const elCardCollectionLoading = document.getElementById('deck-loading')
const elCardCollectionEmpty = document.getElementById('deck-empty')

const elBattleDeckSelection = document.getElementById('deck-slots')
const elBattleDeckCount = document.getElementById('deck-count')
const elBattleStart = document.getElementById('btn-start-battle')

const elBattleView = document.getElementById('view-battle')
const elBattlePlayerTurn = document.getElementById('turn-indicator')
const elBattleTurnTimeout = document.getElementById('turn-timeout')
const elBattleTurnNumber = document.getElementById('turn-number')
const elBattleOppCardsList = document.getElementById('opponent-cards')
const elBattlePlayerCardsList = document.getElementById('player-cards')
const elBattleLog = document.getElementById('battle-log')
const elBattleActions = document.getElementById('action-buttons')
const elBattleForfeit = document.getElementById('btn-forfeit')
elBattleForfeit.addEventListener('click', () => forfeitBattle())

const elResultView = document.getElementById('view-result')
const elResultHeading = document.getElementById('result-heading')
const elResultCollectionButton = document.getElementById('btn-view-collection')
const elResultDamageInflicted = document.getElementById('damage-inflicted')
const elResultDamageSuffered = document.getElementById('damage-suffered')

const elListError = document.getElementById('list-error')

const btnLogout = document.getElementById('btn-logout')

var battleDeckCount = 0
// Whether the Start-battle click handler is bound yet (loadSelectionEvents
// runs once per battle, so without this the handler stacks).
var battleStartBound = false
const battleDeck = Array.from({ length: BATTLE_DECK_NO_CARDS }, (_, index) => {
	const slotIndex = index + 1
	return {
		element: document.querySelector(
			`#deck-slots .deck-slot[data-slot="${slotIndex}"]`
		),
		span: document.querySelector(
			`#deck-slots .deck-slot[data-slot="${slotIndex}"] span`
		),
		card: null,
		cardElement: null,
	}
})

btnLogout?.addEventListener('click', logout)

function switchToOpponentSelectionView(deck) {
	elCardSelectionView.classList.add('hidden')
	elListError.classList.add('hidden')
	elResultView.classList.add('hidden')
	elBattleView.classList.add('hidden')
	elBattleForfeit.classList.add('hidden')
	elOpponentSelectionView.classList.remove('hidden')
}

function switchToResultView() {
	elCardSelectionView.classList.add('hidden')
	elListError.classList.add('hidden')
	elResultView.classList.remove('hidden')
	elBattleView.classList.add('hidden')
	elBattleForfeit.classList.add('hidden')
	elOpponentSelectionView.classList.add('hidden')
}

function switchToCardSelectionView() {
	elCardSelectionView.classList.remove('hidden')
	elListError.classList.add('hidden')
	elResultView.classList.add('hidden')
	elBattleView.classList.add('hidden')
	elBattleForfeit.classList.add('hidden')
	elOpponentSelectionView.classList.add('hidden')
	resetDeck()
	refreshDeck()
	loadSelectionEvents()
}

function switchToBattleView(deck) {
	elCardSelectionView.classList.add('hidden')
	elListError.classList.add('hidden')
	elResultView.classList.add('hidden')
	elBattleView.classList.remove('hidden')
	elBattleForfeit.classList.remove('hidden')
	elOpponentSelectionView.classList.add('hidden')
}

/**
 * Renders opponent cards into the opponent grid container.
 * @param {Array<Object>} opponents - Array of user objects [{ user_id, name, avatar_url, points }]
 * @param {Function} onSelectOpponent - Callback triggered with the selected user_id
 */
function renderOpponents(opponents, onSelectOpponent) {
	const grid = elOpponentGrid
	if (!grid) return
	elOpponentLoading.classList.remove('hidden')

	grid.replaceChildren()

	if (!opponents) {
		elOpponentLoading.classList.add('hidden')
		elOpponentEmpty.classList.remove('hidden')
		return
	}
	opponents.push({
		user_id: null,
		name: 'NPC',
		avatar_url: 'https://www.magnific.com/free-photos-vectors/placeholder-profile',
		points: 0,
	})

	elOpponentLoading.classList.add('hidden')
	elOpponentEmpty.classList.add('hidden')

	opponents.forEach((u) => {
		const li = document.createElement('li')
		li.className = 'opponent-card'

		const avatarSrc =
			u.avatar_url ||
			'https://www.magnific.com/free-photos-vectors/placeholder-profile'

		li.innerHTML = `
            <img src="${avatarSrc}" alt="${u.name}'s avatar" class="opponent-avatar" />
            <h3 class="opponent-name">${u.name}</h3>
            <span class="opponent-points-badge">${(u.points || 0).toLocaleString()} PTS</span>
            <button class="btn btn-primary btn-challenge" data-user-id="${u.user_id}">
                Challenge
            </button>
        `

		const challengeBtn = li.querySelector('.btn-challenge')
		challengeBtn.addEventListener('click', () => {
			if (typeof onSelectOpponent === 'function') {
				onSelectOpponent(u.user_id)
			}
		})

		grid.appendChild(li)
	})
}

async function getOpponents(handler) {
	try {
	} catch (err) {
		console.error(err)
		return null
	}
}

function createBattleCard(card) {
	const ATTRIBUTES = {
		ATK: 'stat_attack',
		LOC: 'stat_location',
		INF: 'stat_influence',
		LEG: 'stat_legacy',
		ERA: 'stat_era',
	}
	const li = document.createElement('li')
	li.setAttribute('class', 'battle-card')
	li.setAttribute('data-slot', card.slot_position)
	li.setAttribute('data-card-id', card.card_id)
	li.setAttribute('data-rarity', card.rarity.toUpperCase())

	const healthOuter = document.createElement('div')
	healthOuter.classList.add('battle-card-health-bar')
	const healthInner = document.createElement('div')
	healthInner.classList.add('battle-card-health-fill')
	healthInner.style.width = `${Math.round((card.health * 100) / card.stat_legacy)}%`
	healthOuter.appendChild(healthInner)
	li.appendChild(healthOuter)

	const add = document.createElement('div')
	add.classList.add('battle-card-additional')
	const category = document.createElement('span')
	category.classList.add('battle-card-category-tag')
	category.setAttribute('data-category', card.category)
	category.textContent = card.category
	add.appendChild(category)
	const rarityTag = document.createElement('span')
	rarityTag.classList.add('battle-card-rarity')
	rarityTag.setAttribute('data-rarity', card.rarity.toUpperCase())
	rarityTag.title = `${card.rarity.toUpperCase()} RARITY`
	rarityTag.textContent = '◆'
	add.appendChild(rarityTag)
	li.appendChild(add)

	const img = document.createElement('img')
	img.classList.add('battle-card-img')
	img.src = card.image_url
	li.appendChild(img)
	const name = document.createElement('p')
	name.classList.add('battle-card-name')
	name.textContent = card.name
	li.appendChild(name)

	const stats = document.createElement('ul')
	stats.classList.add('battle-card-stats')
	li.appendChild(stats)
	for (const [key, value] of Object.entries(ATTRIBUTES)) {
		const statsLi = document.createElement('li')
		stats.appendChild(statsLi)
		let span = document.createElement('span')
		span.textContent = key
		statsLi.appendChild(span)
		span = document.createElement('span')
		span.classList.add('stat-value')
		span.textContent = card[value]
		statsLi.appendChild(span)
	}

	return li
}

function refreshActions(category = null) {
	//   INFLUENCE -> BUFF / DEBUFF only
	//   CHARACTER -> ATTACK, highest damage
	//   LOCATION  -> ATTACK, but skews hit/dodge chance
	//   HISTORICAL -> ATTACK, plus reviving a defeated CHARACTER (not built yet)
	elBattleActions.replaceChildren()
	if (category === null) return
	const allowed = {
		CHARACTER: ['ATTACK', 'DEFEND'],
		LOCATION: ['ATTACK', 'DODGE', 'DEFEND'],
		INFLUENCE: ['ATTACK', 'BUFF', 'DEBUFF'],
		HISTORICAL: ['ATTACK', 'DEFEND'],
	}
	if (allowed[category] === undefined) return
	for (const action of allowed[category]) {
		const button = document.createElement('button')
		button.classList.add('btn')
		button.classList.add('btn-action')
		button.setAttribute('data-action', action)
		button.textContent = action
		elBattleActions.appendChild(button)
		button.addEventListener('click', actionEvent)
	}
}

let pendingAction = null
let pendingAttackerSlot = null
let pendingTargetType = null
const ACTION_TARGETS = {
	SELF: ['DEFEND', 'DODGE'],
	OPPONENT: ['ATTACK', 'DEBUFF'],
	TEAM: ['REVIVE', 'BUFF'],
}

function actionEvent(event) {
	const action = event.currentTarget.getAttribute('data-action')
	const attacker = document.body.querySelector(
		'#player-cards .battle-card.selected'
	)
	if (!attacker) return

	const attackerSlot = parseInt(attacker.getAttribute('data-slot'), 10)

	if (ACTION_TARGETS.SELF.includes(action)) {
		sendAttack(attackerSlot, attackerSlot, action)
		clearSelectionState()
		return
	}

	pendingAction = action
	pendingAttackerSlot = attackerSlot

	if (ACTION_TARGETS.OPPONENT.includes(action)) {
		pendingTargetType = 'OPPONENT'
		document.body.classList.add('awaiting-opponent-target')
	} else if (ACTION_TARGETS.TEAM.includes(action)) {
		pendingTargetType = 'TEAM'
		document.body.classList.add('awaiting-team-target')
	}

	renderCancelBanner(action)
}

function onCardClick(event) {
	const cardElement = event.currentTarget
	const isPlayerCard = cardElement.closest('#player-cards') !== null
	const isOpponentCard = cardElement.closest('#opponent-cards') !== null

	if (pendingTargetType) {
		const clickedSlot = parseInt(
			cardElement.getAttribute('data-slot'),
			10
		)

		if (pendingTargetType === 'OPPONENT' && isOpponentCard) {
			sendAttack(
				pendingAttackerSlot,
				clickedSlot,
				pendingAction
			)
			clearSelectionState()
			return
		}

		if (pendingTargetType === 'TEAM' && isPlayerCard) {
			sendAttack(
				pendingAttackerSlot,
				clickedSlot,
				pendingAction
			)
			clearSelectionState()
			return
		}

		cancelTargeting()
	}

	if (cardElement.parentElement.getAttribute('id') === 'opponent-cards')
		return
	if (cardElement.classList.contains('selected')) {
		elBattleActions.replaceChildren()
		return cardElement.classList.remove('selected')
	}

	cardElement.parentElement
		.querySelector('.battle-card.selected')
		?.classList.remove('selected')

	cardElement.classList.add('selected')

	const category = cardElement
		.querySelector('.battle-card-category-tag')
		?.getAttribute('data-category')
	refreshActions(category)
}

function clearSelectionState() {
	cancelTargeting()
	document.querySelectorAll('.battle-card.selected').forEach((card) =>
		card.classList.remove('selected')
	)
	elBattleActions.replaceChildren()
}

function cancelTargeting() {
	pendingAction = null
	pendingAttackerSlot = null
	pendingTargetType = null
	document.body.classList.remove(
		'awaiting-opponent-target',
		'awaiting-team-target'
	)
}

function renderCancelBanner(action) {
	elBattleActions.replaceChildren()

	const banner = document.createElement('span')
	banner.classList.add('targeting-hint')
	banner.textContent = `Select ${pendingTargetType === 'OPPONENT' ? 'an Opponent' : 'a Teammate'} for ${action}`

	const cancelBtn = document.createElement('button')
	cancelBtn.classList.add('btn', 'btn-cancel')
	cancelBtn.textContent = 'Cancel'
	cancelBtn.addEventListener('click', () => {
		cancelTargeting()
		const attacker = document.body.querySelector(
			'#player-cards .battle-card.selected'
		)
		if (attacker) {
			const category = attacker
				.querySelector('.battle-card-category-tag')
				?.getAttribute('data-category')
			refreshActions(category)
		}
	})

	elBattleActions.appendChild(banner)
	elBattleActions.appendChild(cancelBtn)
}

document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && pendingTargetType) {
		cancelTargeting()
		const attacker = document.body.querySelector(
			'#player-cards .battle-card.selected'
		)
		if (attacker) {
			const category = attacker
				.querySelector('.battle-card-category-tag')
				?.getAttribute('data-category')
			refreshActions(category)
		}
	}
})

function sendAttack(attacker_slot, target_slot, action) {
	if (!ws) return
	ws.send(
		JSON.stringify({
			type: 'attack',
			attacker_slot,
			target_slot,
			action,
		})
	)
}

function action_log(actor, target, result) {
	if (!result || !result.action) {
		return 'Invalid action log result.'
	}

	switch (result.action) {
		case 'ATTACK': {
			if (result.landed) {
				return `${actor} attacked ${target} dealing ${result.damage ?? 0} damage`
			}
			return `${actor} attacked ${target} and missed`
		}
		case 'BUFF': {
			return `${actor} buffed ${target} for ${result.amount} in "${result.stat}"`
		}
		case 'DEBUFF': {
			const amount = -Math.abs(result.amount)
			return `${actor} debuffed ${target} for ${amount} in "${result.stat}"`
		}
		case 'DEFEND': {
			return `${actor} went into a defence stance`
		}
		case 'DODGE': {
			return `${actor} prepared to dodge`
		}
		default:
			return `${actor} performed unknown action: ${result.action}`
	}
}

function scrollToBottomBattleLog() {
	elBattleLog.scrollTo({
		top: elBattleLog.scrollHeight,
		behavior: 'smooth',
	})
}

function refreshBattleLogs(
	player_result,
	player_cards,
	opponent_result,
	opponent_cards,
	timeout = false
) {
	var li, actor, target
	if (player_result) {
		li = document.createElement('li')
		li.classList.add('player-log')
		if (player_result !== 'turn_timeout') {
			actor = player_cards[player_result.attacker_slot].name
			if (
				ACTION_TARGETS.SELF.includes(
					player_result.action
				) ||
				ACTION_TARGETS.TEAM.includes(
					player_result.action
				)
			)
				target =
					player_cards[player_result.target_slot]
						.name
			else
				target =
					opponent_cards[
						player_result.target_slot
					].name
			li.textContent = action_log(
				`Player "${actor}"`,
				`Opponent "${target}"`,
				player_result
			)
		} else {
			li.textContent = 'Player missed turn.'
		}
		elBattleLog.appendChild(li)
	}
	if (opponent_result) {
		li = document.createElement('li')
		li.classList.add('opponent-log')
		if (opponent_result !== 'turn_timeout') {
			actor =
				opponent_cards[opponent_result.attacker_slot]
					.name
			if (
				ACTION_TARGETS.SELF.includes(
					opponent_result.action
				) ||
				ACTION_TARGETS.TEAM.includes(
					opponent_result.action
				)
			)
				target =
					opponent_cards[
						opponent_result.target_slot
					].name
			else
				target =
					player_cards[
						opponent_result.target_slot
					].name
			li.textContent = action_log(
				`Opponent "${actor}"`,
				`Player "${target}"`,
				opponent_result
			)
		} else {
			li.textContent = 'Opponent missed turn.'
		}
		elBattleLog.appendChild(li)
	}
	scrollToBottomBattleLog()
}

function startTurnTimer(durationSeconds = 30) {
	// Always clear any existing interval to prevent overlapping timers
	stopTurnTimer()

	const elBattleTurnTimeout = document.getElementById('turn-timeout')
	if (!elBattleTurnTimeout) return

	let timeLeft = durationSeconds
	elBattleTurnTimeout.textContent = `${timeLeft}s`
	elBattleTurnTimeout.classList.remove('urgent') // Optional styling reset

	turnTimerInterval = setInterval(() => {
		timeLeft -= 1

		if (timeLeft <= 0) {
			stopTurnTimer()
			elBattleTurnTimeout.textContent = '0s'
			return
		}

		elBattleTurnTimeout.textContent = `${timeLeft}s`

		// Optional visual cue when 5 seconds or fewer remain
		if (timeLeft <= 5) {
			elBattleTurnTimeout.classList.add('urgent')
		}
	}, 1000)
}

function stopTurnTimer() {
	if (turnTimerInterval !== null) {
		clearInterval(turnTimerInterval)
		turnTimerInterval = null
	}
}

function refreshBattleView(battle_id, user_id, state) {
	if (!state || !state.cards) {
		console.warn(
			'refreshBattleView called with invalid state:',
			state
		)
		return
	}
	elBattleTurnNumber.textContent = Math.trunc(state.turn_number) ?? 1
	elBattlePlayerTurn.textContent =
		state.turn === user_id ? 'Your turn' : "Opponent's turn"
	var player_cards, opponent_cards
	if (state.player1_id === user_id) {
		player_cards = state.cards.player1 || []
		opponent_cards = state.cards.player2 || []
	} else {
		player_cards = state.cards.player2 || []
		opponent_cards = state.cards.player1 || []
	}
	elBattlePlayerCardsList.replaceChildren()

	function selectCard(event) {
		const cardElement = event.currentTarget
		if (cardElement.classList.contains('selected')) {
			elBattleActions.replaceChildren()
			return cardElement.classList.remove('selected')
		}
		cardElement.parentElement
			.querySelector('.battle-card.selected')
			?.classList.remove('selected')
		cardElement.classList.add('selected')
	}
	for (const card of player_cards) {
		const cardElement = createBattleCard(card)
		if (card.health <= 0) cardElement.classList.add('dead')
		elBattlePlayerCardsList.appendChild(cardElement)
		cardElement.addEventListener('click', onCardClick)
	}
	elBattleOppCardsList.replaceChildren()
	for (const card of opponent_cards) {
		const cardElement = createBattleCard(card)
		if (card.health > 0) cardElement.classList.add('targetable')
		if (card.health <= 0) cardElement.classList.add('dead')
		elBattleOppCardsList.appendChild(cardElement)
		cardElement.addEventListener('click', onCardClick)
	}
}

function forfeitBattle() {
	if (!ws) return
	ws.send(
		JSON.stringify({
			type: 'forfeit',
		})
	)
}

function connectToWebSocket() {
	try {
		let pingInterval
		ws = new WebSocket(`${API_BASE_WS}/ws/battle`)

		ws.onopen = () => {
			wsRetryCount = 0
			elListError.classList.add('hidden')
			pingInterval = setInterval(() => {
				ws.send(JSON.stringify({ type: 'ping' }))
			}, 25000) // ping every 25 seconds
			ws.send(
				JSON.stringify({
					type: 'join_lobby',
				})
			)
		}
		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data)
				if (data.type === 'pong') return
				console.log(data)

				switch (data.type) {
					case 'lobby_users':
						console.log(
							data.users.filter(
								(u) =>
									u.user_id !=
									user.user_id
							)
						)
						switchToOpponentSelectionView()
						renderOpponents(
							data.users.filter(
								(u) =>
									u.user_id !=
									user.user_id
							),
							(user_id) => {
								challengePlayer(
									user_id
								)
							}
						)
						break
					case 'incoming_challenge':
						const ans = confirm(
							`Would you like to accept the challenge from "${data.from_username}" (${data.from_user_id})?`
						)
						ws.send(
							JSON.stringify({
								type: 'accept_challenge',
								accept: ans,
								challenger_id:
									data.from_user_id,
							})
						)
						break
					case 'battle_started':
						switchToCardSelectionView()
						break
					case 'deck_accepted':
						alert(
							'Deck accepted and waiting for opponent...'
						)
						break
					case 'state_update':
						if (!data.state) {
							console.warn(
								'Received state_update with invalid state:',
								data
							)
							break
						}
						refreshBattleView(
							data.battle_id,
							user.user_id,
							data.state
						)
						switchToBattleView()
						startTurnTimer(
							Math.round(
								data.turn_timer_ms /
									1000,
								2
							) ?? 30
						)
						break

					case 'turn_timeout':
					case 'turn_result':
						if (
							!data.state ||
							!data.state.cards
						) {
							console.warn(
								'Received turn_result with invalid state:',
								data
							)
							break
						}
						const player_cards =
							data.state
								.player1_id ===
							user.user_id
								? data.state
										.cards
										.player1
								: data.state
										.cards
										.player2
						const opponent_cards =
							data.state
								.player1_id ===
							user.user_id
								? data.state
										.cards
										.player2
								: data.state
										.cards
										.player1
						if (
							data.player_user_id ===
							user.user_id
						) {
							refreshBattleLogs(
								data.player_result,
								player_cards,
								data.opponent_result,
								opponent_cards
							)
						} else {
							refreshBattleLogs(
								data.opponent_result,
								player_cards,
								data.player_result,
								opponent_cards
							)
						}
						refreshBattleView(
							data.battle_id,
							user.user_id,
							data.state
						)
						startTurnTimer(
							Math.round(
								data.turn_timer_ms /
									1000,
								2
							) ?? 30
						)
						break

					case 'match_results':
						stopTurnTimer()
						elResultHeading.textContent =
							data.winner ===
							user.user_id
								? 'Victory'
								: 'Defeat'
						elResultDamageSuffered.textContent =
							data.damage_suffered ||
							0
						elResultDamageInflicted.textContent =
							data.damage_inflicted ||
							0
						switchToResultView()
						break
					case 'error':
						if (
							data.reject_type ==
							'start_npc_battle'
						) {
							console.log(
								data.message
							)
							switchToOpponentSelectionView()
						}

						if (
							data.reject_type ==
							'submit_deck'
						) {
							console.log(
								data.message
							)
							switchToCardSelectionView()
						}
						if (
							data.reject_type ==
							'challenge_player'
						) {
							console.log(
								data.message
							)
							switchToOpponentSelectionView()
						}
						break
				}
			} catch (err) {
				console.error(
					'Failed to parse incoming WebSocket message:',
					err
				)
			}
		}
		ws.onclose = () => {
			if (pingInterval) clearInterval(pingInterval)
			console.log('WebSocket disconnected')
			// A dropped socket is not a logout — stay on the page and
			// retry a few times instead of dumping the player onto the map.
			wsRetryCount += 1
			if (wsRetryCount > 3) {
				elListError.textContent =
					'Lost connection to the battle server. Refresh the page to reconnect.'
				elListError.classList.remove('hidden')
				return
			}
			elListError.textContent =
				'Connection to the battle server dropped — retrying…'
			elListError.classList.remove('hidden')
			setTimeout(() => {
				ws = connectToWebSocket()
			}, 1500 * wsRetryCount)
		}
		ws.onerror = (error) => {
			// Logged only — onclose follows and owns the retry. Never
			// redirect: a socket error is not an auth failure.
			console.error('WebSocket error:', error)
		}

		return ws
	} catch (err) {
		console.error(err)
		return null
	}
}

async function verifyBattleEligibility(deck) {
	try {
		const res = await fetch(`${API_BASE}/api/cards/valid-cards`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(deck),
		})
		const data = await res.json()
		if (!res.ok) {
			console.error(data.error)
			return false
		}

		return data
	} catch (err) {
		console.error(err)
		return false
	}
}

async function challengePlayer(targetOpponentId = null) {
	// Send deck and match init frame directly over WS
	if (targetOpponentId === null) {
		ws.send(
			JSON.stringify({
				type: 'start_npc_battle',
			})
		)
	} else {
		ws.send(
			JSON.stringify({
				type: 'challenge_player',
				target_user_id: targetOpponentId,
			})
		)
	}
}

function alignDeck() {
	var space = 0
	for (const [idx, deckCard] of battleDeck.entries()) {
		if (deckCard.card == null) {
			space++
		} else if (space > 0) {
			battleDeck[idx - space].card = deckCard.card

			deckCard.card = null

			if (deckCard.cardElement != null) {
				deckCard.cardElement.remove()
				deckCard.cardElement = null
			}
		}
	}
}

function resetDeck() {
	battleDeckCount = 0
	for (const deckCard of battleDeck) {
		deckCard.card = null
	}
	refreshDeck()
}

function refreshDeck() {
	battleDeckCount = 0
	for (const deckCard of battleDeck) {
		if (deckCard.card == null) {
			deckCard.span.classList.remove('hidden')
			if (deckCard.cardElement != null) {
				deckCard.cardElement.remove()
				deckCard.cardElement = null
			}
			continue
		}
		if (deckCard.cardElement == null) {
			deckCard.cardElement = createBattleCard(deckCard.card)
			deckCard.cardElement
				.querySelector('.battle-card-health-bar')
				.remove()
			deckCard.cardElement.addEventListener('click', () => {
				deckCard.cardElement.remove()
				deckCard.card = null
				deckCard.cardElement = null
				deckCard.span.classList.remove('hidden')
				alignDeck()
				refreshDeck()
			})
		}
		deckCard.span.classList.add('hidden')
		deckCard.element.appendChild(deckCard.cardElement)
		battleDeckCount += 1
	}
	elBattleDeckCount.textContent = battleDeckCount
	if (battleDeckCount == BATTLE_DECK_NO_CARDS)
		elBattleStart.disabled = false
	else elBattleStart.disabled = true
}

function addToDeck(card) {
	for (const deckCard of battleDeck) {
		if (
			deckCard.card != null &&
			card.card_id == deckCard.card.card_id
		)
			return
	}
	for (const deckCard of battleDeck) {
		if (deckCard.card == null) {
			deckCard.card = card
			break
		}
	}
	alignDeck()
	refreshDeck()
}

async function loadSelectionEvents() {
	elListError.classList.add('hidden')
	try {
		elCardCollectionLoading.classList.remove('hidden')
		const res = await fetch(`${API_BASE}/api/cards/get-all`, {
			credentials: 'include',
		})
		const data = await res.json()
		if (!res.ok) {
			console.error(data.error)
			throw new Error(`Server responded with ${res.status}`)
		}

		elCardCollectionLoading.classList.add('hidden')
		elCardCollection.replaceChildren()
		if (data.length == 0)
			elCardCollectionEmpty.classList.remove('hidden')

		for (const card of data) {
			const li = createBattleCard(card)
			li.querySelector('.battle-card-health-bar').remove()
			elCardCollection.appendChild(li)
			li.addEventListener('click', (el) => addToDeck(card))
		}

		// The Start button lives across battles while this runs once per
		// battle setup — bind it only the first time, otherwise every
		// visit stacks another listener and one click sends N decks.
		if (!battleStartBound) {
			elBattleStart.addEventListener('click', () =>
				submitDeck(battleDeck.map((x) => x.card))
			)
			battleStartBound = true
		}
	} catch (err) {
		elListError.textContent = `Could not load events — ${err.message}`
		elListError.classList.remove('hidden')
	}
}

function submitDeck(deck) {
	ws.send(JSON.stringify({ type: 'submit_deck', deck }))
}

async function checkAccess() {
	let res
	try {
		res = await fetch(`${AUTH_API}/me`, {
			credentials: 'include',
		})
	} catch {
		// Backend unreachable — not the same as logged out. Stay on the
		// page and say so instead of dumping the player onto the map.
		elListError.textContent =
			'Could not reach the server — check your connection, then refresh.'
		elListError.classList.remove('hidden')
		return
	}
	if (res.status === 401) {
		window.location.href = '../index.html'
		return
	}
	if (!res.ok) {
		elListError.textContent = `Could not verify your session (server responded with ${res.status}).`
		elListError.classList.remove('hidden')
		return
	}
	user = await res.json()

	updateAuthNav(user)
	elBattleLog.replaceChildren()

	ws = connectToWebSocket()
	switchToOpponentSelectionView()
}

checkAccess()
