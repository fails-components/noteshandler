/*
    Fails Components (Fancy Automated Internet Lecture System - Components)
    Copyright (C)  2015-2017 (original FAILS), 
                   2021- (FAILS Components)  Marten Richter <marten.richter@freenet.de>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { createServer } from 'http'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import * as redis from 'redis'
import MongoClient from 'mongodb'
import { NotesConnection } from './noteshandler.js'
import {
  FailsJWTSigner,
  FailsJWTVerifier,
  FailsAssets
} from '@fails-components/security'
import { FailsConfig } from '@fails-components/config'

const initServer = async () => {
  const cfg = new FailsConfig()

  // this should be read only replica
  let rediscl
  let redisclusterconfig
  if (cfg.getRedisClusterConfig)
    redisclusterconfig = cfg.getRedisClusterConfig()
  if (!redisclusterconfig) {
    console.log(
      'Connect to redis database with host:',
      cfg.redisHost(),
      'and port:',
      cfg.redisPort()
    )
    rediscl = redis.createClient({
      socket: { port: cfg.redisPort(), host: cfg.redisHost() },
      password: cfg.redisPass()
    })
  } else {
    // cluster case
    console.log('Connect to redis cluster with config:', redisclusterconfig)
    rediscl = redis.createCluster(redisclusterconfig)
  }

  await rediscl.connect()
  console.log('redisclient connected')

  // and yes pub sub is also read only so we need a mechanism for chat....
  const redisclpub = rediscl.duplicate()
  const redisclsub = rediscl.duplicate()

  await Promise.all([redisclpub.connect(), redisclsub.connect()])

  // again a read only replica should do...
  const mongoclient = await MongoClient.connect(cfg.getMongoURL(), {
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
  const mongodb = mongoclient.db(cfg.getMongoDB())

  const server = createServer()

  const notessecurity = new FailsJWTSigner({
    redis: rediscl,
    type: 'notes',
    expiresIn: '10m',
    secret: cfg.getKeysSecret()
  })
  const avssecurity = new FailsJWTSigner({
    redis: rediscl,
    type: 'avs',
    expiresIn: '1m',
    secret: cfg.getKeysSecret()
  })
  const notesverifier = new FailsJWTVerifier({
    redis: rediscl,
    type: 'notes'
  })
  const assets = new FailsAssets({
    datadir: cfg.getDataDir(),
    dataurl: cfg.getURL('data'),
    webservertype: cfg.getWSType(),
    privateKey: cfg.getStatSecret(),
    swift: cfg.getSwift(),
    s3: cfg.getS3()
  })

  // may be move the io also inside the object, on the other hand, I can not insert middleware anymore

  let cors = null

  if (cfg.needCors()) {
    cors = {
      origin: cfg.getURL('web'),
      methods: ['GET', 'POST']
      // credentials: true
    }
  }

  const ioIns = new Server(server, {
    cors: cors,
    path: '/notes.io',
    serveClient: false,
    transports: ['websocket'],
    pingInterval: 5000,
    pingTimeout: 3000
  })
  const notepadio = ioIns.of('/notepads')
  const screenio = ioIns.of('/screens')
  const notesio = ioIns.of('/notes')

  ioIns.adapter(createAdapter(redisclpub, redisclsub))

  const nsconn = new NotesConnection({
    redis: rediscl,
    mongo: mongodb,
    notepadio: notepadio,
    screenio: screenio,
    notesio: notesio,
    signNotesJwt: notessecurity.signToken,
    signAvsJwt: avssecurity.signToken,
    getFileURL: assets.getFileURL,
    noteshandlerURL: cfg.getURL('notes'),
    screenUrl: cfg.getURL('web'),
    notepadUrl: cfg.getURL('web'),
    notesUrl: cfg.getURL('web')
  })

  notesio.use(notesverifier.socketauthorize())
  notesio.on('connection', (socket) => {
    nsconn.SocketHandlerNotes.bind(nsconn, socket)()
  })

  notepadio.use((socket, next) => {
    return next(new Error('no Connection possible'))
  }) // this should not connect to notepad
  screenio.use((socket, next) => {
    return next(new Error('no Connection possible'))
  }) // this should not connect to screen

  let port = cfg.getPort('notes')
  if (port === 443) port = 8080 // we are in production mode inside a container

  server.listen(port, cfg.getHost(), function () {
    console.log(
      'Failsserver listening at http://%s:%s',
      server.address().address,
      server.address().port
    )
  })
}
initServer()
