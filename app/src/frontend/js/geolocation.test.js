import { jest } from '@jest/globals'

import { get_player_location } from './geolocation.js'
import { get_player_location_with_timeout } from './geolocation.js'

describe('get_player_location', () => {
	const original_geolocation = global.navigator?.geolocation

	afterEach(() => {
		jest.restoreAllMocks()
		Object.defineProperty(global.navigator, 'geolocation', {
			value: original_geolocation,
			configurable: true,
		})
	})

	test('resolves with [latitude, longitude] on success', async () => {
		const mock_get_current_position = jest.fn((success) => {
			success({
				coords: {
					latitude: 12.3456,
					longitude: -65.4321,
				},
			})
		})

		Object.defineProperty(global.navigator, 'geolocation', {
			value: {
				getCurrentPosition: mock_get_current_position,
			},
			configurable: true,
		})

		const result = await get_player_location()
		expect(result).toEqual([12.3456, -65.4321])
		expect(mock_get_current_position).toHaveBeenCalledTimes(1)
	})

	test('with_timeout resolves fast when GPS answers', async () => {
		Object.defineProperty(global.navigator, 'geolocation', {
			value: {
				getCurrentPosition: (success) => {
					success({
						coords: {
							latitude: 1,
							longitude: 2,
						},
					})
				},
			},
			configurable: true,
		})

		const result = await get_player_location_with_timeout(1000)
		expect(result).toEqual([1, 2])
	})

	test('with_timeout rejects instead of hanging on silent GPS', async () => {
		Object.defineProperty(global.navigator, 'geolocation', {
			value: {
				// Never calls back — like a desktop that never answers.
				getCurrentPosition: () => {},
			},
			configurable: true,
		})

		await expect(
			get_player_location_with_timeout(20)
		).rejects.toThrow('Location timed out')
	})
})
