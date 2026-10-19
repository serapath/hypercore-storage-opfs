// Browser stand-in for `device-file`.
//
// In Node, hypercore-storage uses device-file to lock a CORESTORE file (so two
// processes can't open one store) and to notice a store being copied between
// machines. Neither applies to OPFS: the engine underneath already takes an
// exclusive lock on the store (its LOCK file), and an OPFS store can't be
// copied to another device.
//
// So this keeps device-file's interface and does nothing. `transfer()`
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
