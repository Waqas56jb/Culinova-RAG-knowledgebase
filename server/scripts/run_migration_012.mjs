import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/012_engineering_requests.sql'), 'utf8')
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL missing in EOS server .env')

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await c.connect()
console.log('\n######## EOS MIGRATION 012 ########')
await c.query(sql)
console.log('  ✓ ceks_engineering_requests')
console.log('######## DONE ########\n')
await c.end()
