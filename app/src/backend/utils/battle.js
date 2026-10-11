import pool from './db.js'

export const TURN_TIMEOUT_MS = 32 * 1000
export const BATTLE_DECK_NO_CARDS = 5
export const MAX_LEGENDARY_PER_DECK = 1
// With 4 categories and 5 slots, at most 2 per category means every deck
// mixes at least 3 categories — the battle actions (DEFEND, DODGE,
// category-specific attacks) reward a mixed hand, and it stops a
// single-category stack of whatever a player happens to own most of.
export const MAX_CARDS_PER_CATEGORY = 2

/**
 * Why this deck breaks the build rules, or null if it's valid.
 * Enforced server-side (battle_socket save_player_deck, /valid-cards).
 */
export async function deck_violation(user, deck) {
	if (!Array.isArray(deck) || deck.length != BATTLE_DECK_NO_CARDS)
		return `Decks must contain exactly ${BATTLE_DECK_NO_CARDS} cards`

	const card_ids = deck.map((c) => c.card_id)
	const placeholders = card_ids.map(() => '?').join(',')
	const values = [...card_ids, user.user_id]

	// Fetch rarity and category alongside ownership — needed for the deck
	// constraints below, not just the ownership check.
	const [rows] = await pool.query(
		`SELECT uc.card_id, c.rarity, c.category
           FROM user_cards uc
           JOIN cards c ON c.card_id = uc.card_id
          WHERE uc.card_id IN (${placeholders}) AND uc.user_id = ?`,
		values
	)

	// Ownership check — every submitted card_id must resolve back to a row
	// this player owns. (Equivalent to the old COUNT(DISTINCT ...) check,
	// since the frontend already prevents duplicate card_ids in one deck.)
	if (rows.length !== card_ids.length)
		return 'Deck contains cards you do not own (or the same card twice)'

	// Deck constraint (user story 8): at most 1 LEGENDARY card per deck —
	// stops a player from stacking an all-Legendary deck just because they
	// happen to own that many.
	const legendaryCount = rows.filter(
		(r) => r.rarity === 'LEGENDARY'
	).length
	if (legendaryCount > MAX_LEGENDARY_PER_DECK)
		return `At most ${MAX_LEGENDARY_PER_DECK} LEGENDARY card per deck`

	// Deck constraint (user story 8): max cards per category.
	const perCategory = new Map()
	for (const r of rows)
		perCategory.set(
			r.category,
			(perCategory.get(r.category) || 0) + 1
		)
	for (const [category, count] of perCategory) {
		if (count > MAX_CARDS_PER_CATEGORY)
			return `At most ${MAX_CARDS_PER_CATEGORY} ${category} cards per deck (got ${count})`
	}

	return null
}

export async function valid_user_cards(user, deck) {
	return (await deck_violation(user, deck)) === null
}

export async function get_active_battle(user_id) {
	try {
		const [rows, fields] = await pool.query(
			`SELECT battle_id FROM battles WHERE (player1_id = ? OR player2_id = ?) AND status = 'ACTIVE' LIMIT 1`,
			[user_id, user_id]
		)

		if (rows.length == 0) return null
		else return rows[0].battle_id
	} catch {
		return null
	}
}

export async function abandon_battle(battle_id) {
	try {
		const [rows, fields] = await pool.query(
			`UPDATE battles SET status = 'ABANDONED', winner_id = ?, ended_at = NOW() WHERE battle_id = ?`,
			[null, battle_id]
		)

		if (rows.length == 0) return null
		else return rows[0].affectedRows
	} catch {
		return false
	}
}

export async function abandon_stale_battles() {
	try {
		const [result] = await pool.query(
			`UPDATE battles
			 SET status = 'ABANDONED', winner_id = NULL, ended_at = NOW()
			 WHERE status IN ('PENDING', 'ACTIVE')`
		)
		console.log(
			`[Server Startup] Cleaned up ${result.affectedRows} unresolved battle(s).`
		)
		return result.affectedRows
	} catch (err) {
		console.error(
			'[Server Startup] Error abandoning stale battles:',
			err
		)
		throw err
	}
}
