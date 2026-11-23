import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePreference } from './preferences.js'

test('validates and normalizes personal cafe preferences', () => {
    assert.deepEqual(validatePreference({
        wifiQuality: 4,
        foodQuality: 5,
        favorite: true,
        personalNotes: '  Great for morning study  '
    }), {
        valid: true,
        value: {
            wifiQuality: 4,
            foodQuality: 5,
            favorite: true,
            personalNotes: 'Great for morning study'
        }
    })
})

test('allows unrated qualities and rejects invalid ratings or notes', () => {
    assert.equal(validatePreference({ wifiQuality: null, foodQuality: null }).valid, true)
    assert.equal(validatePreference({ wifiQuality: 6 }).valid, false)
    assert.equal(validatePreference({ foodQuality: 'good' }).valid, false)
    assert.equal(validatePreference({ personalNotes: 'x'.repeat(1001) }).valid, false)
})
