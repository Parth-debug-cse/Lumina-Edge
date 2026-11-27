import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionSearchIndex, searchSessionIds } from '../src/utils/session-search.js'

test('session search matches title and message content case-insensitively', () => {
  const index = buildSessionSearchIndex([
    { id: 'one', title: 'Planning', messages: [{ content: 'Benchmark MLX' }] },
    { id: 'two', title: 'Notes', messages: [{ content: 'router lifecycle' }] },
  ])

  assert.deepEqual(searchSessionIds(index, 'mlx'), ['one'])
  assert.deepEqual(searchSessionIds(index, 'ROUTER'), ['two'])
})

test('empty queries return all IDs and malformed message collections are safe', () => {
  const index = buildSessionSearchIndex([
    { id: 'one', title: 'A', messages: null },
    { id: 'two', title: 'B' },
  ])

  assert.deepEqual(searchSessionIds(index, '  '), ['one', 'two'])
  assert.deepEqual(searchSessionIds(index, 'missing'), [])
})
