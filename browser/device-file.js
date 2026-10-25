// Browser stand-in for `device-file`.
//
// In Node, hypercore-storage uses device-file to lock a CORESTORE file and
// heuristically notice copies between machines. The browser implementation
// creates fresh OPFS stores and populates them through replication, so import
// identity checks are not needed. The database engine uses a Web Lock to
// prevent concurrent writers for the same origin and store path.
//
// Keep device-file's interface without Node filesystem assumptions. `transfer()`
// returns -1, which tells rocksdb-native there is no external lock.

class DeviceFile {
  constructor(filename, opts = {}) {
    this.filename = filename
    this.data = opts.data || {}
    this.lock = null
    this.opened = false
    this.closed = false
    this._opening = null
    this._closing = null
  }

  ready() {
    if (this._opening === null) {
      this._opening = Promise.resolve().then(() => {
        this.opened = true
      })
    }
    return this._opening
  }

  close() {
    if (this._closing === null) {
      this._closing = this.ready().then(() => {
        this.closed = true
      })
    }
    return this._closing
  }

  transfer() {
    return -1
  }

  async suspend() {
    await this.ready()
  }

  async resume() {
    await this.ready()
  }

  static async validate() {
    return true
  }
}

module.exports = DeviceFile
