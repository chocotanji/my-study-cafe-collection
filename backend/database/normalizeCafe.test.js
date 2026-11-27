import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCafe, parseOperatingHours } from './normalizeCafe.js'

test('maps spreadsheet-style cafe fields to the fields the website reads', () => {
    const cafe = normalizeCafe({
        _id: 'abc',
        'Café name': '5Plus Coffee',
        Rating: 4.7,
        'Price Range': '$1-10',
        'Type of Store': 'Coffee shop',
        Address: '3623 Hwy 7 Unit# 114, Markham, ON L3R 8X6',
        'Plus Codes': 'VM37+93 Markham, Ontario',
        'Operating hours': 'Mon–Fri 8:30–18:00; Sat–Sun 9:00-18:00',
        'Phone No': { '': '14376005708' },
        'Web Link': 'N/A'
    })

    assert.equal(cafe.cafeName, '5Plus Coffee')
    assert.equal(cafe.address, '3623 Hwy 7 Unit# 114, Markham, ON L3R 8X6')
    assert.equal(cafe.rating, 4.7)
    assert.equal(cafe.priceRange, '$1-10')
    assert.equal(cafe.typeOfStore, 'Coffee shop')
    assert.equal(cafe.plusCodes, 'VM37+93 Markham, Ontario')
    assert.equal(cafe.phoneNo, '14376005708')
    assert.equal(cafe.webLink, undefined)
    assert.equal(cafe.hoursByDay.monday, '08:30-18:00')
    assert.equal(cafe.hoursByDay.sunday, '09:00-18:00')
})

test('treats "null" placeholders as missing values', () => {
    const cafe = normalizeCafe({ _id: 'abc', 'Café name': 'Cafe', 'Phone No': { '': 'null' } })
    assert.equal(cafe.phoneNo, undefined)
})

test('keeps records that already use the website field names', () => {
    const hoursByDay = { monday: '09:00-17:00' }
    const cafe = normalizeCafe({ _id: 'abc', cafeName: 'Cafe', address: '1 Main St', hoursByDay })
    assert.equal(cafe.cafeName, 'Cafe')
    assert.equal(cafe.address, '1 Main St')
    assert.deepEqual(cafe.hoursByDay, hoursByDay)
})

test('parses day lists, wrapping ranges, and closed days', () => {
    assert.deepEqual(parseOperatingHours('Sun–Wed Closed; Thu–Sat 15:00-17:00'), {
        sunday: 'Closed',
        monday: 'Closed',
        tuesday: 'Closed',
        wednesday: 'Closed',
        thursday: '15:00-17:00',
        friday: '15:00-17:00',
        saturday: '15:00-17:00'
    })
    assert.equal(parseOperatingHours('Mon, Wed-Fri 7:30–20:00; Tue 7:30-21:00').tuesday, '07:30-21:00')
    assert.equal(parseOperatingHours('Sun–Thur 7:00–21:00').thursday, '07:00-21:00')
})

test('returns null for hours it cannot read so the raw text is shown', () => {
    assert.equal(parseOperatingHours("Mon–Fri 8:00–18:00; Sat–SBalzac's Market Streetun 9:30-18:00"), null)
})
