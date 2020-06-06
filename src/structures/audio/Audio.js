const Shoukaku = require('shoukaku')
const NodeCache = require('node-cache')
const { Collection } = require('discord.js')
const fetch = require('node-fetch')
const cheerio = require('cheerio')
const randomUA = require('random-http-useragent')
const AudioTimer = require('./AudioTimer')
const Filters = require('./AudioFilters')
const Queue = require('./Queue')
const AudioPlayerEventRouter = require('./AudioPlayerEventRouter')
const AudioUtils = require('./AudioUtils')
const QueueEvents = require('./QueueEvents')

class Audio extends Shoukaku.Shoukaku {
  constructor (...args) {
    super(...args)

    this.client = args.shift()

    this.utils = new AudioUtils(this.client)

    this.classPrefix = '[Audio:Defalut'
    this.lavalinkPrefix = '[Audio:Lavalink]'
    this.defaultPrefix = {
      getTrack: `${this.classPrefix}:getTrack]`,
      join: `${this.classPrefix}:join]`,
      leave: `${this.classPrefix}:leave]`,
      stop: `${this.classPrefix}:stop]`,
      handleDisconnect: `${this.classPrefix}:handleDisconnect]`,
      setPlayerDefaultSetting: `${this.classPrefix}:setPlayerDefaultSetting]`,
      setVolume: `${this.classPrefix}:setVolume]`,
      getRelated: `${this.classPrefix}:getRelated]`,
      fetchRelated: `${this.classPrefix}:fetchRelated]`,
      getUA: `${this.classPrefix}:getUA]`,
      parseYoutubeHTML: `${this.classPrefix}:parseYoutubeHTML]`,
      moveNode: `${this.classPrefix}:moveNode]`
    }

    this.queue = new Queue(this)
    const queueEvents = new QueueEvents(this.client)
    this.queue.on('queueEvent', (data) => {
      queueEvents.HandleEvents(data)
    })

    this.audioTimer = new AudioTimer(this.client, this.client._options.audio.timeout)
    this.filters = new Filters(this)
    this.textChannels = new Collection()
    this.textMessages = new Collection()
    this.nowplayingMessages = new Collection()
    this.skippers = new Collection()
    this.playedTracks = new Collection()

    this.audioRouter = new AudioPlayerEventRouter(this)

    this.client.logger.info(`${this.classPrefix}] Init Audio..`)
    this.trackCache = new NodeCache({ ttl: 3600 })
    this.relatedCache = new NodeCache({ ttl: 43200 })

    this.on('ready', (name, resumed) => this.client.logger.info(`${this.lavalinkPrefix} Lavalink Node: ${name} is now connected. This connection is ${resumed ? 'resumed' : 'a new connection'}`))
    this.on('error', (name, error) => this.client.logger.error(`${this.lavalinkPrefix} Lavalink Node: ${name} emitted an error. ${error.stack}`))
    this.on('close', (name, code, reason) => this.client.logger.warn(`${this.lavalinkPrefix} Lavalink Node: ${name} closed with code ${code}. Reason: ${reason || 'No reason'}`))
    this.on('disconnected', (name, reason) => this.client.logger.warn(`${this.lavalinkPrefix} Lavalink Node: ${name} disconnected. Reason: ${reason || 'No reason'}`))
    this.on('debug', (name, data) => this.client.logger.debug(`${this.lavalinkPrefix} Lavalink Node: ${name} - Data: ${JSON.stringify(data)}`))
  }

  /**
   * @param {String} voiceChannelID - voiceChannelId join for
   * @param {String} guildID - guildID of voiceChannel
   */
  join (voiceChannelID, guildID) {
    return new Promise((resolve, reject) => {
      this.getNode().joinVoiceChannel({
        guildID: guildID,
        voiceChannelID: voiceChannelID
      }).then((player) => {
        this.audioRouter.registerEvents(player)
        this.setPlayersDefaultSetting(guildID)
        this.client.logger.debug(`${this.defaultPrefix.join} [${guildID}] [${voiceChannelID}] Successfully joined voiceChannel.`)
        this.queue.autoPlay(guildID)
        resolve(true)
      }).catch(e => {
        this.client.logger.error(`${this.defaultPrefix.join} [${guildID}] [${voiceChannelID}] Failed to join voiceChannel [${e.name}: ${e.message}]`)
        reject(e)
      })
    })
  }

  /**
  * @param {String} guildID - guildID
  * @example - <Audio>.setPlayerDefaultSetting('672586746587774976')
  * @returns {Promise<Boolean>}
  */
  async setPlayersDefaultSetting (guildID) {
    if (!guildID) return new Error('no guildID Provied')
    const { volume } = await this.client.database.getGuild(guildID)
    this.client.logger.debug(`${this.defaultPrefix.setPlayerDefaultSetting} Set player volume for guild ${guildID} (${volume})`)
    return this.players.get(guildID).setVolume(volume)
  }

  /**
   * @param {String} guildID - guildID for player leave
   */
  leave (guildID) {
    this.client.logger.debug(`${this.defaultPrefix.leave} [${guildID}] Player leave`)
    if (this.players.get(guildID)) this.players.get(guildID).disconnect()
    else {
      for (const node of this.nodes.values()) {
        node.leaveVoiceChannel(guildID)
      }
    }
  }

  /**
   * @param {String} guildID - guildID for player stop
   * @param {Boolean} cleanQueue - if clears Tracks Queue
   */
  stop (guildID, cleanQueue = true) {
    if (!guildID) return new Error('guildID is not provied')
    this.playedTracks.set(guildID, [])
    this.leave(guildID)
    clearTimeout(this.audioTimer.timers.get(guildID))
    this.textChannels.delete(guildID)
    this.textMessages.delete(guildID)
    if (cleanQueue) {
      this.client.database.updateGuild(guildID, { $set: { queue: [] } })
      this.queue.setNowPlaying(guildID, { track: null })
      this.client.database.updateGuild(guildID, { $set: { nowplayingPosition: 0 } })
    }
    this.utils.updateNowplayingMessage(guildID)
  }

  /**
   * @param {String} guildId - guildId to set volume
   * @param {Number} volume - Percentage of volume (0~150)
   * @example - <Audio>.setVolume('672586746587774976', 150)
   */
  setVolume (guildID, vol) {
    this.client.logger.debug(`${this.defaultPrefix.setVolume} Setting volume of guild ${guildID} to ${vol}..`)
    this.client.database.updateGuild(guildID, { $set: { volume: vol } })
    if (!this.players.get(guildID)) return Promise.resolve(false)
    else {
      return this.players.get(guildID).setVolume(vol)
    }
  }

  /**
   * @param {Object} data - Socket Data
   */
  async handleDisconnect (data) {
    const guildData = await this.client.database.getGuild(data.guildId)
    this.utils.sendMessage(data.guildId, this.client.utils.localePicker.get(guildData.locale, 'AUDIO_DISCONNECTED'), true)
    this.stop(data.guildId, false)
  }

  /**
   * @description - Get Nodes sort by players.
   */
  getNode (name = undefined) {
    if (!name || this.nodes.get(name)) return this.getUsableNodes().sort((a, b) => { return a.penalties - b.penalties }).shift()
    else {
      this.nodes.get(name)
    }
  }

  getUsableNodes () {
    return Array.from(this.nodes.values()).filter(el => el.state === 'CONNECTED')
  }

  /**
   * @param {String} vId - Youtube Video Id
   */
  async getRelated (vId) {
    if (this.relatedCache.get(vId) && this.relatedCache.get(vId).length !== 0) {
      this.client.logger.error(`${this.defaultPrefix.getRelated} Cache Hit [${vId}], returns ${this.relatedCache.get(vId).length} Items`)
      return this.relatedCache.get(vId)
    } else {
      this.client.logger.error(`${this.defaultPrefix.getRelated} No Cache Hits [${vId}], Fetch Related Videos..`)
      let $ = await this.fetchRelated(vId)
      if ($('body > div.content-error').text().length !== 0) {
        this.client.logger.error(`${this.defaultPrefix.getRelated} Failed to fetch [${vId}]... retrying..`)
        $ = await this.fetchRelated(vId)
      }
      let relatedSongs = this.parseYoutubeHTML($)
      if (relatedSongs.length === 0) {
        this.client.logger.error(`${this.defaultPrefix.getRelated} [${vId}] Array is [], retrying one time.`)
        $ = await this.fetchRelated(vId)
        relatedSongs = this.parseYoutubeHTML($)
      }
      if (relatedSongs.length !== 0) {
        this.client.logger.error(`${this.defaultPrefix.getRelated} Registering Cache [${vId}], ${relatedSongs.length} Items`)
        this.relatedCache.set(vId, relatedSongs)
      }
      return relatedSongs
    }
  }

  /**
   * @description - Parse Related Videos via youtube video html
   * @param {Cheerio} $ - Cheerio Loaded Obj
   * @returns {Array} - Parsed Elements
   */
  parseYoutubeHTML ($) {
    const relatedSongs = []
    const upnext = $('#watch7-sidebar-modules > div:nth-child(1) > div > div.watch-sidebar-body > ul > li > div.content-wrapper > a')
    if (upnext.attr('href')) relatedSongs.push({ uri: `https://youtube.com${upnext.attr('href')}`, identifier: this.utils.getvIdfromUrl(upnext.attr('href')), title: upnext.attr('title') })
    $('#watch-related').children().each((...item) => {
      const url = $(item).children('.content-wrapper').children('a').attr('href')
      const title = $(item).children('.content-wrapper').children('a').attr('title')
      if (url) relatedSongs.push({ uri: `https://youtube.com${url}`, identifier: this.utils.getvIdfromUrl(url), title: title })
    })
    return relatedSongs
  }

  /**
   * @description get Random UA with en-US
   * @returns {String} - UserAgent
   */
  async getUA () {
    const ua = await randomUA.get()
    this.client.logger.debug(`${this.defaultPrefix.getUA} Get UserAgent: ${ua}`)
    if (!ua || !ua.toLowerCase().includes('en-us') || !ua.includes('en-US')) return this.getUA()
    else return ua
  }

  /**
   * @param {String} vId - video ID to Fetch related videos
   * @returns {Array} - Fetched Results
   */
  async fetchRelated (vId) {
    const ua = await this.getUA()
    this.client.logger.debug(`${this.defaultPrefix.fetchRelated} Fetch ${vId} via UA: ${ua}`)
    const result = await fetch(`https://www.youtube.com/watch?v=${vId}`, { headers: { 'User-Agent': ua } })
      .then(async res => {
        return { body: res.text(), status: res.status }
      }).catch(err => {
        this.client.error(err.stack || err.message)
        return { body: Promise.resolve(null), status: 500 }
      })
    return cheerio.load(await result.body)
  }

  /**
   * @param {String} query - Search String ('ytsearch: asdfmovie')
   * @returns {Promise<Object>} - query Result (Promise)
   */
  async getTrack (query, cache = true) {
    if (!query) return new Error(`${this.defaultPrefix.getTrack} Query is not provied`)
    const node = this.getNode()
    if (this.trackCache.get(query) && cache) {
      this.client.logger.debug(`${this.defaultPrefix.getTrack} Query Keyword: ${query} Cache Available (${this.trackCache.get(query)}) returns Data`)
      return this.trackCache.get(query)
    }
    const resultFetch = await this.getFetch(node, query)
    if (resultFetch !== null && !['LOAD_FAILED', 'NO_MATCHES'].includes(resultFetch.loadType)) {
      this.client.logger.debug(`[AudioManager] Cache not found. registring cache... (${query})`)
      this.trackCache.set(query, resultFetch)
      resultFetch.tracks.map(el => {
        if (query === el.info.identifier) return
        this.client.logger.debug(`[AudioManager] Registring Identifier: ${el.info.identifier}`)
        this.trackCache.set(el.info.identifier, el)
      })
    }
    return resultFetch
  }

  getFetch (node, query) {
    return new Promise((resolve) => {
      node.rest._getFetch(`/loadtracks?${new URLSearchParams({ identifier: query }).toString()}`)
        .then(data => {
          resolve(data)
        })
        .catch(err => {
          this.client.logger.error(`${this.defaultPrefix.getTrack} Query Keyword: ${query} ${err.name}: ${err.message}`)
          resolve(Object.assign({ loadType: 'LOAD_FAILED', exception: { message: err.message } }))
        })
    })
  }
}

module.exports = Audio