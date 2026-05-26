'use strict'

const Fastify = require('fastify')
const { Pool } = require('pg')
const Redis = require('ioredis')
const promClient = require('prom-client')

// --- Métricas ---
promClient.collectDefaultMetrics()
const httpDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
})
const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Total de cache hits no Redis',
  labelNames: ['route']
})
const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Total de cache misses no Redis',
  labelNames: ['route']
})

// --- App ---
const app = Fastify({ logger: true })

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = new Redis(process.env.REDIS_URL)

redis.on('error', err => app.log.warn({ err }, 'redis error'))

async function initDb () {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      item_id    INTEGER NOT NULL,
      rating     INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}

app.addHook('onResponse', (req, reply, done) => {
  httpDuration
    .labels(req.method, req.routeOptions?.url ?? req.url, reply.statusCode)
    .observe(reply.elapsedTime / 1000)
  done()
})

// --- Rotas de plataforma ---
app.get('/health', async () => ({ status: 'ok' }))

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', promClient.register.contentType)
  return promClient.register.metrics()
})

// --- CRUD /reviews ---
app.get('/reviews/:itemId', async (req) => {
  const { itemId } = req.params
  const cacheKey = `reviews:${itemId}`

  const cached = await redis.get(cacheKey).catch(() => null)
  if (cached) {
    cacheHits.labels('/reviews/:itemId').inc()
    return JSON.parse(cached)
  }

  cacheMisses.labels('/reviews/:itemId').inc()
  const { rows } = await pool.query(
    'SELECT * FROM reviews WHERE item_id = $1 ORDER BY created_at DESC',
    [itemId]
  )
  await redis.setex(cacheKey, 60, JSON.stringify(rows)).catch(() => null)
  return rows
})

app.post('/reviews', {
  schema: {
    body: {
      type: 'object',
      required: ['item_id', 'rating'],
      properties: {
        item_id: { type: 'integer' },
        rating:  { type: 'integer', minimum: 1, maximum: 5 },
        comment: { type: 'string' }
      }
    }
  }
}, async (req, reply) => {
  const { item_id, rating, comment = null } = req.body
  const { rows } = await pool.query(
    'INSERT INTO reviews (item_id, rating, comment) VALUES ($1, $2, $3) RETURNING *',
    [item_id, rating, comment]
  )
  // Invalida cache do item
  await redis.del(`reviews:${item_id}`).catch(() => null)
  return reply.status(201).send(rows[0])
})

app.delete('/reviews/:id', async (req, reply) => {
  const { rows } = await pool.query('DELETE FROM reviews WHERE id = $1 RETURNING item_id', [req.params.id])
  if (!rows.length) return reply.status(404).send({ error: 'not found' })
  await redis.del(`reviews:${rows[0].item_id}`).catch(() => null)
  return reply.status(204).send()
})

// --- Start ---
const start = async () => {
  await initDb()
  await app.listen({ port: parseInt(process.env.PORT ?? '3000'), host: '0.0.0.0' })
}

start().catch(err => {
  app.log.error(err)
  process.exit(1)
})
