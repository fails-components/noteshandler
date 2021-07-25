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

import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import * as redis  from "redis";
import MongoClient from 'mongodb';
import {NotesConnection} from './noteshandler.js';
import {FailsJWTSigner, FailsJWTVerifier, FailsAssets} from 'fails-components-security';
import {FailsConfig} from 'fails-components-config';


let cfg=new FailsConfig();

// this should be read only replica
const redisclient = redis.createClient({detect_buffers: true /* required by notes connection*/});

// and yes pub sub is also read only so we need a mechanism for chat....
const redisclpub = redisclient.duplicate();
const redisclsub = redisclient.duplicate();

// again a read only replica should do...
let mongoclient = await MongoClient.connect(cfg.getMongoURL(),{useNewUrlParser: true , useUnifiedTopology: true });
let mongodb =mongoclient.db(cfg.getMongoDB()); 

const server = createServer();



let notessecurity=new FailsJWTSigner ({redis: redisclient, type: 'notes', expiresIn: "10m", secret:cfg.getKeysSecret()});
let notesverifier= new FailsJWTVerifier({redis: redisclient, type: 'notes'} );
let assets= new FailsAssets( { datadir: cfg.getDataDir(), dataurl: cfg.getURL('data'), webservertype: cfg.getWSType(), privateKey:  cfg.getStatSecret()});



// may be move the io also inside the object, on the other hand, I can not insert middleware anymore

let cors=null;

if (cfg.needCors()) {
  cors={
    origin: cfg.getURL('web'),
    methods: ["GET", "POST"],
   // credentials: true
  };
}

var ioIns = new Server(server,{cors: cors});
var notepadio = ioIns.of('/notepads');
var screenio = ioIns.of('/screens');
var notesio = ioIns.of('/notes');

ioIns.adapter(createAdapter(redisclpub, redisclsub));


var nsconn= new NotesConnection({
  redis: redisclient,
  mongo: mongodb, 
  notepadio: notepadio,
  screenio: screenio,
  notesio: notesio,
  signNotesJwt: notessecurity.signToken,
  getFileURL: assets.getFileURL,
  noteshandlerURL: cfg.getURL('notes'),
  screenUrl: cfg.getURL('web'),
  notepadUrl: cfg.getURL('web'),
  notesUrl: cfg.getURL('web')
});



notesio.use(notesverifier.socketauthorize());
notesio.on('connection',(socket)=>{nsconn.SocketHandlerNotes.bind(nsconn,socket)();});

notepadio.use(()=>{return next(new Error("no Connection possible"));}); // this should not connect to notepad
screenio.use(()=>{return next(new Error("no Connection possible"));}); // this should not connect to screen


server.listen(cfg.getPort('notes'),cfg.getHost(),function() {
    console.log('Failsserver listening at http://%s:%s',
        server.address().address, server.address().port);
      });

