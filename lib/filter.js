'use strict'

const EventEmitter = require('events')
const async = require('async')
const createFilter = require('bloom-filter').create
const debug = require('debug')('bitcoin-filter')
const inherits = require('inherits')
require('setimmediate')

function fpRate (size, nHashFuncs, elements) {
  return Math.pow(1 - Math.pow(Math.E, -nHashFuncs * elements / size), nHashFuncs)
}

function Filter (peers, opts) {
  const _this = this

  if (!(this instanceof Filter)) return new Filter(peers, opts)
  if (!peers || typeof peers.send !== 'function') {
    throw new Error('Must provide "peers" argument')
  }
  EventEmitter.call(this)

  opts = opts || {}
  this._peers = peers
  this._targetFPRate = opts.falsePositiveRate || 0.001
  this._resizeThreshold = opts.resizeThreshold || 0.4
  this._elements = []
  this._filterables = []
  this._count = 0
  this._filter = null
  this.initialized = false

  setImmediate(function () {
    _this.initialized = true
    debug('sending initial filter: elements:' + _this._count)
    _this._resize(_this._error.bind(_this))
    peers.on('peer', function (peer) {
      debug('sending "filterload" to peer: ' + peer.socket.remoteAddress)
      peer.send('filterload', _this._getPayload())
    })
    _this.emit('init')
    _this.emit('ready')
  })
}

inherits(Filter, EventEmitter)

Filter.prototype._error = function (err) {
  if (err) this.emit('error', err)
}

Filter.prototype.onceReady = function (cb) {
  if (this.initialized) return cb()
  this.once('ready', cb)
}

Filter.prototype.add = function (value, cb) {
  const _this2 = this

  cb = cb || this._error.bind(this)
  const add = Buffer.isBuffer(value) ? this._addStaticElement : this._addFilterable
  add.call(this, value, function (err) {
    if (err) return cb(err)
    _this2._maybeResize(cb)
  })
}

Filter.prototype.remove = function (value) {
  if (Buffer.isBuffer(value)) {
    // TODO
  } else {
    // TODO
  }
}

Filter.prototype._addStaticElement = function (data, cb) {
  const element = Buffer(data.length)
  data.copy(element)
  this._elements.push(element)
  this._addElement(element)
  debug('static element added: ' + element.toString('hex'))
  cb(null)
}

Filter.prototype._addFilterable = function (filterable, cb) {
  const _this3 = this

  this._addFilterableElements(filterable, function (err) {
    if (err) return cb(err)
    _this3._filterables.push(filterable)
    filterable.on('filteradd', function (data) {
      if (Array.isArray(data)) {
        let _iteratorNormalCompletion = true
        let _didIteratorError = false
        let _iteratorError

        try {
          for (var _iterator = data[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
            const element = _step.value
            _this3._addElement(element)
          }
        } catch (err) {
          _didIteratorError = true
          _iteratorError = err
        } finally {
          try {
            if (!_iteratorNormalCompletion && _iterator.return) {
              _iterator.return()
            }
          } finally {
            if (_didIteratorError) {
              throw _iteratorError
            }
          }
        }
      } else {
        _this3._addElement(data)
      }
    })
    cb(null)
  })
}

Filter.prototype._addFilterableElements = function (filterable, cb) {
  const _this4 = this

  if (!this.initialized) {
    cb(null)
    return
  }
  let called = false
  const done = function done (err, elements) {
    called = true
    cb(err, elements)
  }
  const addElements = function addElements (err, elements, sync) {
    if (called) {
      if (err) return _this4._error(err)
      return _this4._error(new Error('Filterable#filterElements() returned elements via both async cb and sync return'))
    }
    if (err) return done(err)
    if (!elements) {
      if (elements === null || !sync) done(null)
      return
    }
    if (elements && !Array.isArray(elements)) {
      return done(new Error('"filterElements()" must return an array of Buffers or null/undefined'))
    }
    _this4._addElements(elements, false)
    debug('initial filterable elements added:' + (elements ? elements.length : 0))
    return done(null, elements)
  }
  const asyncAddElements = function asyncAddElements () {
    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key]
    }

    setImmediate(function () {
      return addElements.apply(undefined, args)
    })
  }
  addElements(null, filterable.filterElements(asyncAddElements), true)
}

Filter.prototype._addElement = function (data, send) {
  send = send == null ? true : send
  this._count++

  if (!this._filter) return
  this._filter.insert(data)

  if (send) {
    debug('sending "filteradd": ' + data.toString('hex'))
    this._peers.send('filteradd', { data: data }, false)
  }
}

Filter.prototype._falsePositiveRate = function () {
  return fpRate(this._filter.vData.length * 8, this._filter.nHashFuncs, Math.max(this._count, 100))
}

Filter.prototype._getPayload = function () {
  const output = this._filter.toObject()
  output.data = output.vData
  delete output.vData
  return output
}

Filter.prototype._maybeResize = function (cb) {
  if (!this._filter) return cb(null)
  const fpRate = this._falsePositiveRate()
  const threshold = this._resizeThreshold * this._targetFPRate
  if (fpRate - this._targetFPRate >= threshold) {
    debug('resizing: fp=' + fpRate + ', target=' + this._targetFPRate)
    return this._resize(cb)
  }
  cb(null)
}

Filter.prototype._addElements = function (elements, send) {
  let _iteratorNormalCompletion2 = true
  let _didIteratorError2 = false
  let _iteratorError2

  try {
    for (var _iterator2 = elements[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
      const element = _step2.value
      this._addElement(element, send)
    }
  } catch (err) {
    _didIteratorError2 = true
    _iteratorError2 = err
  } finally {
    try {
      if (!_iteratorNormalCompletion2 && _iterator2.return) {
        _iterator2.return()
      }
    } finally {
      if (_didIteratorError2) {
        throw _iteratorError2
      }
    }
  }
}

Filter.prototype._resize = function (cb) {
  const _this5 = this

  this._filter = createFilter(Math.max(this._count, 100), this._targetFPRate, Math.floor(Math.random() * 0xffffffff))
  this._count = 0
  this._addElements(this._elements, false)

  const filterables = this._filterables
  this._filterables = []
  async.each(filterables, this._addFilterableElements.bind(this), function (err) {
    if (err) return cb(err)
    _this5._peers.send('filterload', _this5._getPayload(), false)
    cb(null)
  })
}

module.exports = Filter
