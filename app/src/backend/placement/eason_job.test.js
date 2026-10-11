import { jest } from '@jest/globals'

jest.unstable_mockModule('../services/rating.js', () => ({
	rolloverSeasonIfDue: jest.fn(),
}))

const { rolloverSeasonIfDue } = await import('../services/rating.js')
const { startSeasonScheduler } = await import('./season_job.js')

const pool = {}

async function flushMicrotasks() {
	await Promise.resolve()
	await Promise.resolve()
}

describe('startSeasonScheduler', () => {
	let intervalSpy
	let capturedFn
	let capturedMs

	beforeEach(() => {
		jest.spyOn(console, 'log').mockImplementation(() => {})
		jest.spyOn(console, 'error').mockImplementation(() => {})
		rolloverSeasonIfDue.mockReset()
		intervalSpy = jest
			.spyOn(global, 'setInterval')
			.mockImplementation((fn, ms) => {
				capturedFn = fn
				capturedMs = ms
				return 999 // fake timer handle
			})
	})

	afterEach(() => {
		console.log.mockRestore()
		console.error.mockRestore()
		intervalSpy.mockRestore()
	})

	test('runs an immediate check on start and schedules an hourly interval', async () => {
		rolloverSeasonIfDue.mockResolvedValue(null)

		startSeasonScheduler(pool)
		await flushMicrotasks()

		expect(rolloverSeasonIfDue).toHaveBeenCalledWith(pool)
		expect(intervalSpy).toHaveBeenCalledTimes(1)
		expect(capturedMs).toBe(60 * 60 * 1000)
	})

	test('logs when the immediate check rolls over a season', async () => {
		rolloverSeasonIfDue.mockResolvedValue(2)

		startSeasonScheduler(pool)
		await flushMicrotasks()

		expect(console.log).toHaveBeenCalledWith(
			'[season job] rolled over to season 2'
		)
	})

	test('does not log when nothing rolled over', async () => {
		rolloverSeasonIfDue.mockResolvedValue(null)

		startSeasonScheduler(pool)
		await flushMicrotasks()

		expect(console.log).not.toHaveBeenCalled()
	})

	test('a later interval tick also checks for rollover', async () => {
		rolloverSeasonIfDue.mockResolvedValue(null)

		startSeasonScheduler(pool)
		await flushMicrotasks()
		rolloverSeasonIfDue.mockClear()

		await capturedFn()

		expect(rolloverSeasonIfDue).toHaveBeenCalledTimes(1)
	})

	test('catches and logs an error instead of throwing', async () => {
		rolloverSeasonIfDue.mockRejectedValue(
			new Error('db unreachable')
		)

		expect(() => startSeasonScheduler(pool)).not.toThrow()
		await flushMicrotasks()

		expect(console.error).toHaveBeenCalledWith(
			'[season job]',
			'db unreachable'
		)
	})
})
