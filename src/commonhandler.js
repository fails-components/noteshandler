/* eslint-disable node/no-callback-literal */
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

import { commandOptions } from 'redis'
import CIDRMatcher from 'cidr-matcher'
import { serialize as BSONserialize } from 'bson'
import { createHash, webcrypto as crypto } from 'crypto'

export class CommonConnection {
  async getBgpdf(notepadscreenid) {
    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')
      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: { _id: 0, backgroundpdfuse: 1, backgroundpdf: 1 }
        }
      )
      // console.log("lecturedoc",lecturedoc);
      if (
        !lecturedoc.backgroundpdfuse ||
        !lecturedoc.backgroundpdf ||
        !lecturedoc.backgroundpdf.sha
      )
        return null
      return this.getFileURL(lecturedoc.backgroundpdf.sha, 'application/pdf')
    } catch (err) {
      console.log('error in getBgpdf pictures', err)
    }
  }

  async getUsedPicts(notepadscreenid) {
    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')
      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: { _id: 0, usedpictures: 1 }
        }
      )
      // console.log("lecturedoc",lecturedoc);
      if (!lecturedoc.usedpictures) return []

      return lecturedoc.usedpictures.map((el) => {
        return {
          name: el.name,
          mimetype: el.mimetype,
          sha: el.sha.buffer.toString('hex'),
          url: this.getFileURL(el.sha.buffer, el.mimetype),
          urlthumb: this.getFileURL(el.tsha.buffer, el.mimetype)
        }
      })
      // ok now I have the picture, but I also have to generate the urls
    } catch (err) {
      console.log('error in getUsedPicts pictures', err)
    }
  }

  async sendBoardsToSocket(lectureuuid, socket) {
    // we have to send first information about pictures

    const usedpict = await this.getUsedPicts({ lectureuuid: lectureuuid })
    if (usedpict) {
      socket.emit('pictureinfo', usedpict)
    }
    const bgpdf = await this.getBgpdf({ lectureuuid: lectureuuid })
    if (bgpdf) {
      socket.emit('bgpdfinfo', { bgpdfurl: bgpdf })
    } else {
      socket.emit('bgpdfinfo', { none: true })
    }

    try {
      const res = await this.redis.sMembers(
        'lecture:' + lectureuuid + ':boards'
      )

      // console.log('boards', res, 'lecture:' + lectureuuid + ':boards')
      const length = res.length
      let countdown = length
      if (length === 0) socket.emit('reloadBoard', { last: true })
      for (const index in res) {
        const boardnum = res[index]
        // console.log('sendBoardsToSocket', boardnum, lectureuuid)
        try {
          const res2 = await this.redis.get(
            commandOptions({ returnBuffers: true }),
            'lecture:' + lectureuuid + ':board' + boardnum
          )

          countdown--
          // console.log('send reloadboard', boardnum, res2, length)
          const send = {
            number: boardnum,
            data: res2,
            last: countdown === 0
          }
          socket.emit('reloadBoard', send)
        } catch (error) {
          console.log('error in sendboard to sockets loop', error)
        }
      }
    } catch (error) {
      console.log('error in sendboard to sockets', error)
    }
  }

  async getLectDetail(notepadscreenid, socket) {
    // TODO should be feed from mongodb

    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')

      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: {
            _id: 0,
            title: 1,
            coursetitle: 1,
            ownersdisplaynames: 1,
            date: 1
          }
        }
      )
    } catch (err) {
      console.log('error in get LectDetail', err)
    }

    const lectdetail = {
      title: lecturedoc.title,
      coursetitle: lecturedoc.coursetitle,
      instructors: lecturedoc.ownersdisplaynames,
      date: lecturedoc.date
    }
    // if (notepadscreenid.notepaduuid) lectdetail.notepaduuid=notepadscreenid.notepaduuid;
    socket.emit('lecturedetail', lectdetail)
  }

  // sync changes to notes
  async addUpdateCryptoIdent(args) {
    const identity = {
      signKey: args.signKey,
      cryptKey: args.cryptKey,
      displayname: args.displayname,
      userhash: args.userhash,
      /* id: args.socketid, */
      purpose: args.purpose,
      lastaccess: Date.now().toString()
    }
    // Two things store it in redis until disconnect
    const oldident = this.redis.hGet(
      'lecture:' + args.lectureuuid + ':idents',
      args.socketid.toString()
    )
    this.redis.hSet('lecture:' + args.lectureuuid + ':idents', [
      args.socketid.toString(),
      JSON.stringify(identity)
    ])
    let oldid = await oldident
    if (oldid) oldid = JSON.parse(oldid)

    // and inform about new/updated identity
    const roomname = this.getRoomName(args.lectureuuid)

    if (
      oldid &&
      identity.signKey === oldid.signKey &&
      identity.cryptKey === oldid.cryptKey
    ) {
      this.notepadio.to(roomname).emit('identValidity', {
        lastaccess: identity.lastaccess,
        id: args.socketid
      })
    } else {
      this.notepadio
        .to(roomname)
        .emit('identUpdate', { identity: identity, id: args.socketid })
    }
  }

  async handleKeymasterQuery(args) {
    const now = Date.now() / 1000
    // ok, first we have to figure out if a query is already running
    try {
      await this.redis.executeIsolated(async (isoredis) => {
        await isoredis.watch('lecture:' + args.lectureuuid + ':keymaster')
        const queryInfo = await isoredis.hGet(
          'lecture:' + args.lectureuuid + ':keymaster',
          'queryTime'
        )
        /* console.log(
          'query Info',
          queryInfo,
          now - Number(queryInfo),
          now,
          Number(queryInfo)
        ) */

        if (queryInfo && now - Number(queryInfo) < 15) {
          // we have no key, so may be the kaymaster does not know that we exist
          await this.addUpdateCryptoIdent(args)
          return // do not spam the system with these queries 20 +10
        }

        const res = await isoredis
          .multi()
          .hSet('lecture:' + args.lectureuuid + ':keymaster', [
            'queryTime',
            now.toString(),
            'bidding',
            '0',
            'master',
            'none'
          ])
          .exec()
        if (res !== null) {
          const roomname = this.getRoomName(args.lectureuuid)
          // start the bidding
          this.notepadio.to(roomname).emit('keymasterQuery')
        }
      })
    } catch (error) {
      console.log('handleKeymasterQuery problem or multple attempts', error)
    }
  }

  async emitAVOffers(socket, args) {
    const alloffers = await this.redis.hGetAll(
      'lecture:' + args.lectureuuid + ':avoffers'
    )
    const offers = []
    for (const label in alloffers) {
      const labels = label.split(':')
      offers.push({
        type: labels[0],
        id: labels[1],
        time: alloffers[label]
      })
    }
    socket.emit('avofferList', { offers })
  }

  getRoomName(uuid) {
    return uuid
  }

  async getRouting(args, cmd, routerurl, callback) {
    const majorid = args.lectureuuid
    const clientid = args.lectureuuid + ':' + cmd.id
    const clientidpure = cmd.id

    let tickets // routing tickets

    let hops = []

    const options = {
      projection: {
        _id: 0,
        url: 1,
        region: 1,
        key: 1,
        spki: 1,
        primaryRealms: { $elemMatch: { $eq: majorid } },
        hashSalt: 1,
        localClients: { $elemMatch: { $eq: clientid } },
        remoteClients: { $elemMatch: { $eq: clientid } }
      }
    }

    try {
      const routercol = this.mongo.collection('avsrouters')
      // first hop the actual router client
      hops.push(
        routercol.findOne(
          {
            url: routerurl
          },
          options
        )
      )
      if (cmd.dir === 'in') {
        // this is the clients perspective, so what is coming in
        // for 'out' we have all we need
        // now we need the router with the actual target client
        hops.push(
          routercol.findOne(
            {
              localClients: clientid
            },
            options
          )
        )
        // now we have to find out, if these two are in the same region
        await Promise.all(hops)
        const first = await hops[0]
        const last = await hops[1]
        // in this case we need two more routers
        if (!first) throw new Error('router not found')
        if (!last) {
          console.log('target client not found ' + clientid)
          callback({ notfound: clientid })
          return
        }
        let inspos = 1
        // console.log('first debug', first, majorid)
        // console.log('last debug', last)
        if (!first.localClients) first.localClients = []
        if (!first.remoteClients) first.remoteClients = []
        if (!first.primaryRealms) first.primaryRealms = []
        if (!last.localClients) last.localClients = []
        if (!last.primaryClients) last.primaryClients = []
        if (!last.primaryRealms) last.primaryRealms = []
        if (!first.localClients.includes(clientid)) {
          if (
            !first.primaryRealms.includes(majorid) &&
            first.region !== last.region
          ) {
            hops.splice(
              inspos,
              0,
              routercol.findOne(
                {
                  region: first.region,
                  primaryRealms: majorid
                },
                options
              )
            )
            inspos++
          }
          if (
            (!last.primaryRealms || !last.primaryRealms.includes(majorid)) &&
            first.region !== last.region
          ) {
            hops.splice(
              inspos,
              0,
              routercol.findOne(
                {
                  region: last.region,
                  primaryRealms: majorid
                },
                options
              )
            )
            inspos++
          }
          // we got everything
        } else {
          hops.pop()
        }
      }
      hops = await Promise.all(hops)
      // now we create routing information, from the hops
      tickets = (await Promise.all(hops))
        .map(async (ele, index, array) => {
          const salt = ele.hashSalt
          const calcHash = async (input) => {
            const hash = createHash('sha256')
            hash.update(input)
            hash.update(salt)
            return hash.digest('base64')
          }

          const cid = await calcHash(clientidpure)
          const mid = await calcHash(majorid)
          const ret = {
            client: mid + ':' + cid,
            realm: mid
          }
          if (index < array.length - 1) {
            ret.next = array[index + 1].url
            ret.nextspki = array[index + 1].spki
          }
          return { data: ret, key: ele.key }
        })
        .map(async (ele) => {
          // ok we now need to encrypt it
          try {
            const el = await ele
            const aeskey = await crypto.subtle.generateKey(
              {
                name: 'AES-GCM',
                length: 256
              },
              true,
              ['encrypt', 'decrypt']
            )
            const iv = crypto.getRandomValues(new Uint8Array(12))
            const retval = {
              aeskey: await crypto.subtle.encrypt(
                {
                  name: 'RSA-OAEP'
                },
                await crypto.subtle.importKey(
                  'jwk',
                  el.key,
                  {
                    name: 'RSA-OAEP',
                    modulusLength: 4096,
                    publicExponent: new Uint8Array([1, 0, 1]),
                    hash: 'SHA-256'
                  },
                  true,
                  ['encrypt']
                ),
                await crypto.subtle.exportKey('raw', aeskey)
              ),
              payload: await crypto.subtle.encrypt(
                {
                  name: 'AES-GCM',
                  iv
                },
                aeskey,
                BSONserialize(el.data)
              ),
              iv
            }
            return retval
          } catch (error) {
            console.log('error exporting key', error)
            return null
          }
        })
      tickets = await Promise.all(tickets)
    } catch (error) {
      console.log('getRouting error', error)
      callback({ error: String(error) })
      return
    }
    callback({ tickets })
  }

  async getTransportInfo(args, callback) {
    const regions = []
    let router
    let token = {}
    try {
      // iterate over all regions until something matches
      const regioncol = this.mongo.collection('avsregion')
      {
        const regioncursorip = regioncol
          .find({ ipfilter: { $exists: true } })
          .project({ _id: 0, name: 1, hmac: 1, ipfilter: 1 })
        await regioncursorip.forEach((el) => {
          if (el.ipfilter) {
            const matcher = new CIDRMatcher(el.ipfilter)
            if (matcher.containsAny(args.ipaddress)) {
              regions.push(el)
            }
          } else regions.push(el)
        })
      }
      if (args.geopos) {
        const regioncursorgeo = regioncol.aggregate([
          {
            $geoNear: {
              near: args.geopos,
              spherical: true,
              key: 'geopos',
              query: { geopos: { $exists: true } },
              distanceField: 'dist.calculated'
            }
          }
        ])
        await regioncursorgeo.forEach((el) => {
          if (el.geopos && !el.ipfilter) {
            regions.push(el)
          }
        })
      }
      {
        const remain = { ipfilter: { $exists: false } }
        if (args.geopos) remain.geopos = { $exists: false }
        const regioncursor = regioncol.find(remain)
        await regioncursor.forEach((el) => {
          if (!el.ipfilter) {
            regions.push(el)
          }
        })
      }
      // we got our regions list, now we iterate over all regions until
      // we find a suitable router

      const routercol = this.mongo.collection('avsrouters')
      let primary
      let region
      while (regions.length > 0 && !router) {
        region = regions.shift()
        primary = true
        let cursor = routercol
          .find({
            region: { $eq: region.name },
            $expr: { $gt: ['$maxClients', '$numClients'] },
            primaryRealms: args.lectureuuid
          })
          .sort({ numClients: -1 })
        if ((await cursor.count()) < 1) {
          cursor.close()
          primary = false
          // go to secondary realm
          cursor = routercol
            .find({
              region: { $eq: region.name },
              $expr: { $gt: ['$maxClients', '$numClients'] },
              localClients: { $regex: args.lectureuuid + ':[a-zA-Z0-9-]+' } // may be remoteClients
            })
            .sort({ numClients: -1 })
          if ((await cursor.count()) < 1) {
            primary = false
            cursor.close()
            // last try, a new router
            cursor = routercol
              .find({
                region: { $eq: region.name },
                $and: [
                  { $expr: { $gt: ['$maxClients', '$numClients'] } },
                  { $expr: { $gt: ['$maxRealms', '$numRealms'] } }
                ]
              })
              .sort({ maxRealms: -1, numClients: -1 })
            if ((await cursor.count()) < 1) {
              continue
            }
          }
        }
        router = await cursor.next()
        cursor.close()
      }
      if (!router) {
        callback({
          error: 'no router found'
        })
        return
      }

      // ok we got a cursor...
      // if it is not primary, we have to find out, if there is a primary
      let setprimary = false
      if (!primary) {
        const dprimary = await routercol.findOne({
          region: { $eq: region.name },
          primaryRealms: args.lectureuuid
        })
        if (!dprimary) setprimary = true
      }
      const update = {
        $addToSet: {
          localClients: args.lectureuuid + ':' + args.clientid
        }
      }
      const calcHash = async (input) => {
        const hash = createHash('sha256')
        hash.update(input)
        // console.log('debug router info', router)
        hash.update(router.hashSalt)
        return hash.digest('base64')
      }

      const realmhash = calcHash(args.lectureuuid)
      const clienthash = calcHash(args.clientid)
      update.$set = {}
      update.$set['transHash.' + (await realmhash)] = args.lectureuuid
      update.$set['transHash.' + (await clienthash)] = args.clientid

      // todo hash table
      token.accessRead = [
        (await realmhash).replace(/[+/]/g, '\\$&') + ':[a-zA-Z0-9-/+=]+'
      ]
      if (args.canWrite) token.accessWrite = token.accessRead
      if (setprimary) {
        if (!update.$addToSet) update.$addToSet = {}
        update.$addToSet.primaryRealms = args.lectureuuid
      }
      if (setprimary || primary) token.primaryRealm = await realmhash
      token.realm = await realmhash
      token.client = await clienthash

      await routercol.updateOne({ url: router.url }, update)
    } catch (error) {
      console.log('getTransportError', error)
    }
    token = this.signAvsJwt(token)

    // perfect we have enough information to give the transport info back
    callback({
      url: router.url,
      wsurl: router.wsurl,
      spki: router.spki,
      token: await token
    })
  }
}
