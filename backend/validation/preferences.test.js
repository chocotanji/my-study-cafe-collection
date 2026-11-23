import assert from 'node:assert/strict'
import test from 'node:test'
import {
    emptyPreference,
    normalizeStoredPreference,
    validateMapLocation,
    validatePreference
} from './preferences.js'

test('validates and normalizes personal cafe preferences', () => {
    assert.deepEqual(validatePreference({
        wifiQuality: 4,
        powerOutlets: 3,
        studyFriendly: 5,
        spacious: 2,
        cleanliness: 4,
        noiseLevel: 1,
        foodAndDrinkQuality: 5,
        favorite: true,
        recommend: true,
        personalNotes: '  Great for morning study  '
    }), {
        valid: true,
        value: {
            wifiQuality: 4,
            powerOutlets: 3,
            studyFriendly: 5,
            spacious: 2,
            cleanliness: 4,
            noiseLevel: 1,
            foodAndDrinkQuality: 5,
            favorite: true,
            recommend: true,
            personalNotes: 'Great for morning study'
        }
    })
})

test('fills missing fields with empty defaults', () => {
    assert.deepEqual(validatePreference({}), { valid: true, value: emptyPreference() })
})

test('rejects invalid ratings, recommendation, favorite, or notes', () => {
    assert.equal(validatePreference({ wifiQuality: 6 }).valid, false)
    assert.equal(validatePreference({ powerOutlets: 0 }).valid, false)
    assert.equal(validatePreference({ noiseLevel: 2.5 }).valid, false)
    assert.equal(validatePreference({ foodAndDrinkQuality: 'good' }).valid, false)
    assert.equal(validatePreference({ recommend: 'yes' }).valid, false)
    assert.equal(validatePreference({ favorite: 1 }).valid, false)
    assert.equal(validatePreference({ personalNotes: 'x'.repeat(1001) }).valid, false)
    assert.equal(validatePreference([]).valid, false)
    assert.equal(validatePreference(null).valid, false)
})

test('allows a cafe to be explicitly not recommended', () => {
    assert.equal(validatePreference({ recommend: false }).value.recommend, false)
})

test('maps legacy food ratings to food and drink quality', () => {
    const preference = normalizeStoredPreference({ cafeId: 'a', foodQuality: 3, wifiQuality: 2 })
    assert.equal(preference.foodAndDrinkQuality, 3)
    assert.equal(preference.wifiQuality, 2)
    assert.equal(preference.recommend, null)
    assert.equal('foodQuality' in preference, false)
})

test('validates saved map locations', () => {
    assert.deepEqual(validateMapLocation({ lat: 43.65, lng: -79.38 }), {
        valid: true,
        value: { lat: 43.65, lng: -79.38 }
    })
    assert.equal(validateMapLocation({ lat: 91, lng: 0 }).valid, false)
    assert.equal(validateMapLocation({ lat: 0, lng: -181 }).valid, false)
    assert.equal(validateMapLocation({ lat: '43', lng: -79 }).valid, false)
    assert.equal(validateMapLocation({ lat: Number.NaN, lng: 0 }).valid, false)
    assert.equal(validateMapLocation(null).valid, false)
})
