import test from 'node:test'
import assert from 'node:assert/strict'

test('session search worker supports incremental index updates and reports aggregate timings', async () => {
  const listeners = new Map()
  const responses = []
  const originalSelf = globalThis.self
  globalThis.self = {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    postMessage(message) {
      responses.push(message)
    },
  }

  try {
    await import(`../src/workers/session-search.worker.js?test=${Date.now()}`)
    const dispatch = data => listeners.get('message')({ data })
    const search = (query, requestId) => {
      dispatch({ type: 'search', query, requestId })
      return responses.pop()
    }

    dispatch({
      type: 'index',
      sessions: [
        { id: 'one', title: 'Planning', messages: [{ content: 'Benchmark MLX' }] },
        { id: 'two', title: 'Notes', messages: [{ content: 'router lifecycle' }] },
      ],
    })
    const indexed = responses.pop()
    assert.equal(indexed.type, 'indexed')
    assert.equal(indexed.metrics.sessionCount, 2)
    assert.ok(indexed.metrics.indexedCharacters > 0)
    assert.ok(indexed.metrics.durationMs >= 0)
    assert.deepEqual(search('mlx', 1).ids, ['one'])

    dispatch({
      type: 'upsert',
      sessions: [
        { id: 'one', title: 'Renamed', messages: [{ content: 'updated content' }] },
        { id: 'three', title: 'New session', messages: [] },
      ],
    })
    const updated = responses.pop()
    assert.equal(updated.type, 'updated')
    assert.equal(updated.metrics.sessionCount, 3)
    assert.deepEqual(search('benchmark', 2).ids, [])
    assert.deepEqual(search('updated content', 3).ids, ['one'])

    dispatch({ type: 'remove', ids: ['two'] })
    const removed = responses.pop()
    assert.equal(removed.metrics.sessionCount, 2)
    assert.deepEqual(search('', 4).ids, ['one', 'three'])
  } finally {
    if (originalSelf === undefined) delete globalThis.self
    else globalThis.self = originalSelf
  }
})
