/* eslint no-console:0 */

const path = require('path')
const server = require('http').createServer()
const { spawn } = require('child_process')
const WebSocketServer = require('ws').Server
const express = require('express')
const basicAuth = require('express-basic-auth')
const webpack = require('webpack')
const history = require('connect-history-api-fallback')
const webpackDev = require('webpack-dev-middleware')
const argv = require('optimist').argv
const NODB = !!argv.nodb
const NOKAFKA = !!argv.nokafka
if (NODB) {
  console.log('DATABASE DISABLED')
}
if (NODB) {
  console.log('KAFKA DISABLED')
}

const webpackConfig = require('./webpack.config')
const Consumer = require('./consumer')
const Kafka = require('no-kafka')
const app = express()
const constants = require('./consumer/constants')
let dataGeneratorProcess = null

let Postgres, db, query
if (!NODB) {
  Postgres = require('pg-promise')({
    capSQL: true
  })
  const dbUrl = `${process.env.DATABASE_URL ||
    process.env.AWS_DATABASE_URL ||
    'postgresql://localhost:5432'}?ssl=true`

  db = Postgres(dbUrl)
  query = Postgres.helpers.concat([
    { query: new Postgres.QueryFile('./sql/truncate.sql', { minify: true }) },
    {
      query: new Postgres.QueryFile('./sql/load.sql', { minify: true }),
      values: [
        process.env.FIXTURE_DATA_S3,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY
      ]
    }
  ])
  db.connect()
}

const PRODUCTION = process.env.NODE_ENV === 'production'
const PORT = process.env.PORT || 3000

/*
 * Configure web app and webpack pieces
 *
 */
app.use('/public', express.static(path.join(__dirname, 'public')))

/*
 * Configure admin routes for demoer
 *
 */
const auth = basicAuth({
  users: { '': process.env.ADMIN_PASSWORD || 'supersecret' },
  challenge: true,
  realm: 'Demo Admin'
})

app.get('/admin/reload', auth, (req, res) => {
  if (NODB) {
    return res.send('App running without a progres database.')
  }
  return db
    .none(query)
    .then(() => res.send(`Fixture data truncated and reloaded.`))
    .catch((error) => res.send(`ERROR: ${error}`))
})

app.get('/admin/start', auth, (req, res) => {
  if (dataGeneratorProcess) {
    return res.send('Already running. Restart Heroku `web` process to stop.')
  } else {
    dataGeneratorProcess = spawn('node', ['index.js', '-c', 'kafka.js'], {
      cwd: path.resolve(process.cwd(), '..', 'generate_data')
    })

    dataGeneratorProcess.on('error', (err) => {
      console.log(`Failed to start data generator: ${err}`)
      dataGeneratorProcess = null
    })
    dataGeneratorProcess.on('close', (code) => {
      console.log(`Data generator process stopped with code ${code}.`)
      dataGeneratorProcess = null
    })
    dataGeneratorProcess.stdout.on('data', (data) =>
      console.log(`data generator stdout: ${data}`)
    )
    dataGeneratorProcess.stderr.on('data', (data) =>
      console.log(`data generator stderr: ${data}`)
    )
    res.send('Data generator started.')
  }
})

app.get('/admin/kill', auth, (req, res) => {
  if (dataGeneratorProcess) {
    dataGeneratorProcess.kill('SIGHUP')
    dataGeneratorProcess = null
    return res.send('Kill signal sent to data generator.')
  } else {
    return res.send('Data generator not running.')
  }
})

if (PRODUCTION) {
  app.use(express.static(path.join(__dirname, 'dist')))
  app.get('/:route', (req, res) => {
    if (!req.params) res.sendFile(path.join(__dirname, 'dist/index.html'))
    else res.sendFile(path.join(__dirname, `dist/${req.params}.html`))
  })
} else {
  app.use(
    history({
      rewrites: [
        {
          from: /\/(audience|booth|presentation)/,
          to: function(context) {
            return `${context.parsedUrl.pathname}.html`
          }
        }
      ],
      verbose: false
    })
  )
  app.use(webpackDev(webpack(webpackConfig), { stats: 'minimal' }))
}

server.on('request', app)

/*
 * Configure WebSocketServer
 *
 */
const wss = new WebSocketServer({ server })

/*
 * Configure Kafka consumer
 *
 */
if (!NOKAFKA) {
  const consumer = new Consumer({
    broadcast: (data) => {
      data.type = 'ecommerce'
      wss.clients.forEach((client) => client.send(JSON.stringify(data)))
    },
    interval: constants.INTERVAL,
    topic: constants.KAFKA_TOPIC,
    consumer: {
      connectionString: process.env.KAFKA_URL.replace(/\+ssl/g, ''),
      ssl: {
        cert: './client.crt',
        key: './client.key'
      }
    }
  })

  const consumer2 = new Kafka.SimpleConsumer({
    idleTimeout: 1000,
    connectionTimeout: 10 * 1000,
    clientId: constants.KAFKA_WEIGHT_TOPIC,
    consumer: {
      connectionString: process.env.KAFKA_URL.replace(/\+ssl/g, ''),
      ssl: {
        cert: './client.crt',
        key: './client.key'
      }
    }
  })

  const producer = new Kafka.Producer({
    connectionString: process.env.KAFKA_URL.replace(/\+ssl/g, ''),
    ssl: {
      cert: './client.crt',
      key: './client.key'
    }
  })

  consumer
    .init()
    .catch((err) => {
      console.error(`Consumer could not be initialized: ${err}`)
      if (PRODUCTION) throw err
    })
    .then(() => {
      return consumer2.init().catch((err) => {
        console.error(`Consumer2 could not be initialized: ${err}`)
        if (PRODUCTION) throw err
      })
    })
    .then(() => {
      return consumer2
        .subscribe(constants.KAFKA_WEIGHT_TOPIC, (messageSet) => {
          const items = messageSet.map((m) =>
            JSON.parse(m.message.value.toString('utf8'))
          )
          for (const msg of items) {
            wss.clients.forEach((client) => client.send(JSON.stringify(msg)))
          }
        })
        .catch((err) => {
          console.error(`Consumer2 could not be initialized: ${err}`)
          if (PRODUCTION) throw err
        })
    })
    .then(() => {
      return producer.init().catch((err) => {
        console.error(`Producer could not be initialized: ${err}`)
        if (PRODUCTION) throw err
      })
    })
    .then(() => {
      wss.on('connection', function connection(ws) {
        ws.on('message', function incoming(message) {
          try {
            producer.send({
              topic: constants.KAFKA_CMD_TOPIC,
              message: {
                value: message
              },
              partition: 0
            })
          } catch (e) {
            console.error(e)
          }
        })
      })
      server.listen(PORT, () =>
        console.log(`http/ws server listening on http://localhost:${PORT}`)
      )
    })
} else {
  server.listen(PORT, () =>
    console.log(`http/ws server listening on http://localhost:${PORT}`)
  )
}
