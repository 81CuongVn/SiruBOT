class Command {
  constructor (client) {
    this.client = client
    this.command = {
      name: 'cacheinfo',
      aliases: ['ㅊㅁ초댜ㅜ래'],
      category: 'BOT_OWNER',
      require_voice: false,
      hide: false,
      permissions: ['BotOwner']
    }
  }

  /**
   * @param {Object} compressed - Compressed Object (In CBOT)
   */
  run (compressed) {
    const { message } = compressed
    const used = process.memoryUsage()
    const array = []
    for (const key in used) {
      array.push(`${key.replace(/^\w/, c => c.toUpperCase())}: **${Math.round(used[key] / 1024 / 1024 * 100) / 100}**MB`)
    }
    const stats = this.client.audioCache.getStats()
    message.channel.send(`> **Tracks Cache Info**\n> **${stats.hits}** Hits, **${stats.misses}** Misses, **${stats.keys}** Keys\n> KeySize: **${(stats.ksize / 1024).toFixed(2)}**MB (${stats.ksize}KB), ValueSize: **${(stats.vsize / 1024).toFixed(2)}**MB (${stats.vsize}KB)\n> \n> **Memory Usage**\n> ${array.join(', ')}`)
  }
}

module.exports = Command
