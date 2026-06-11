import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'webhooks.sqlite')

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDatabase(dbPath = process.env.WEBHOOKS_DB_PATH || DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  return db
}
