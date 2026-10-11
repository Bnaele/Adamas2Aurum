import 'dotenv/config'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs'
import url from 'url'
import pool from './utils/db.js'
import { execute_sql_script } from './utils/sql_utils.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const sslConfig = () => {
	if (process.env.DB_SSL !== 'true') return false

	if (process.env.CA_CERT_BASE64) {
		return {
			ca: Buffer.from(
				process.env.CA_CERT_BASE64,
				'base64'
			).toString('utf-8'),
			rejectUnauthorized: true,
		}
	}

	return {
		ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.pem')),
		rejectUnauthorized: true,
	}
}

async function main() {
	console.log(
		'Resetting DB...\nNote: The DB will be unseeded, so you will have to run the seed script yourself.'
	)

	const dbName = process.env.DB_NAME || 'a2adb'
	const adminConfig = {
		host: process.env.DB_HOST || 'localhost',
		port: Number(process.env.DB_PORT) || 8024,
		user: process.env.DB_USER || 'root',
		password: process.env.DB_PASSWORD || 'test',
		ssl: sslConfig(),
		timezone: 'Z',
	}
	console.log(
		`======\nDropping and recreating database: ${dbName}\n======`
	)
	const connection = await mysql.createConnection(adminConfig)

	try {
		await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`)
		await connection.query(`CREATE DATABASE \`${dbName}\`;`)
		console.log('Done...')
	} finally {
		await connection.end()
	}

	console.log('======\nCreating DB tables\n======')
	let ret = await execute_sql_script(pool, './db/schema.sql')
	if (ret.ok === false) throw new Error(ret.error)

	console.log(
		'======\nDone.\nNote: The DB is unseeded. Run the seed script to seed it.\n======'
	)
	process.exit(0)
}

main().catch((err) => {
	console.error('Resetting failed:', err.message)
	process.exit(1)
})
