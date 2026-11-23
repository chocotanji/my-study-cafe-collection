const cafeList = document.querySelector('#cafe-list')
const listStatus = document.querySelector('#list-status')
const mapStatus = document.querySelector('#map-status')
const searchForm = document.querySelector('#search-form')
const searchInput = document.querySelector('#search-terms')
const searchContainer = document.querySelector('.search-container')
const searchSuggestions = document.querySelector('#search-suggestions')
const preferences = new Map()
const cafeMarkers = new Map()
const geocodingCache = new Map()
const torontoCenter = [43.6532, -79.3832]
let cafeMap
let cafeMarkerIcon
let selectedCafeMarker
let geocodingQueue = Promise.resolve()
let lastGeocodingAt = 0
let searchTimeout
let cafeLoadRequestId = 0

async function requestJson(url, options) {
    const response = await fetch(url, options)
    const payload = await response.json()

    if (!response.ok) {
        throw new Error(payload.error ?? 'The request could not be completed.')
    }

    return payload
}

function getCafeName(cafe) {
    return cafe.name ?? cafe.title ?? cafe.cafeName ?? 'Cafe'
}

function getCafeAddress(cafe) {
    if (typeof cafe.address === 'string') return cafe.address
    if (typeof cafe.location === 'string') return cafe.location
    if (cafe.location && typeof cafe.location === 'object') {
        const address = cafe.location.address ?? cafe.location.formattedAddress
        return typeof address === 'string' ? address : ''
    }
    return ''
}

function validCoordinates(latitude, longitude) {
    if (
        latitude == null || longitude == null
        || (typeof latitude === 'string' && !latitude.trim())
        || (typeof longitude === 'string' && !longitude.trim())
    ) {
        return null
    }

    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null
    }
    return { lat, lng }
}

function getCafeCoordinates(cafe) {
    const candidates = [
        [cafe.latitude, cafe.longitude],
        [cafe.lat, cafe.longitude ?? cafe.lng ?? cafe.lon ?? cafe.long],
        cafe.location,
        cafe.coordinates,
        cafe.geo,
        cafe.geolocation,
        cafe.point,
        cafe.geometry
    ]

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length >= 2) {
            const coordinates = validCoordinates(candidate[1], candidate[0])
            if (coordinates) return coordinates
        }

        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            const nestedCoordinates = Array.isArray(candidate.coordinates)
                ? validCoordinates(candidate.coordinates[1], candidate.coordinates[0])
                : null
            const coordinates = nestedCoordinates ?? validCoordinates(
                candidate.latitude ?? candidate.lat,
                candidate.longitude ?? candidate.lng ?? candidate.lon ?? candidate.long
            )
            if (coordinates) return coordinates
        }
    }

    return null
}

function initializeMap() {
    if (!window.L) {
        mapStatus.textContent = 'The map could not be loaded. Check your connection and reload the page.'
        return
    }

    cafeMap = window.L.map('cafe-map', { scrollWheelZoom: false }).setView(torontoCenter, 11)
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(cafeMap)
    cafeMarkerIcon = window.L.divIcon({
        className: 'cafe-map-marker',
        iconSize: [26, 36],
        iconAnchor: [13, 36],
        popupAnchor: [0, -32]
    })
    mapStatus.textContent = 'Cafe locations will appear here.'
}

function markerPopup(cafe) {
    const content = document.createElement('div')
    const name = document.createElement('strong')
    name.textContent = getCafeName(cafe)
    content.append(name)

    const address = getCafeAddress(cafe)
    if (address) {
        const addressElement = document.createElement('p')
        addressElement.className = 'map-popup-address'
        addressElement.textContent = address
        content.append(addressElement)
    }

    const detailsButton = document.createElement('button')
    detailsButton.className = 'map-popup-button'
    detailsButton.type = 'button'
    detailsButton.textContent = 'View cafe details'
    detailsButton.addEventListener('click', () => {
        const card = document.getElementById(`cafe-${String(cafe._id)}`)
        if (!card) return
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card.focus({ preventScroll: true })
    })
    content.append(detailsButton)
    return content
}

function highlightCafeMarker(marker) {
    if (selectedCafeMarker && selectedCafeMarker !== marker) {
        selectedCafeMarker.getElement()?.classList.remove('is-selected')
    }
    selectedCafeMarker = marker
    marker.getElement()?.classList.add('is-selected')
}

function createCafeMarker(cafe, coordinates) {
    const marker = window.L.marker([coordinates.lat, coordinates.lng], { icon: cafeMarkerIcon })
        .addTo(cafeMap)
        .bindPopup(markerPopup(cafe))
    marker.on('click', () => highlightCafeMarker(marker))
    return marker
}

function updateMapMarkers(cafes) {
    if (!cafeMap) return

    for (const marker of cafeMarkers.values()) {
        marker.remove()
    }
    cafeMarkers.clear()
    selectedCafeMarker = null

    const bounds = []
    for (const cafe of cafes) {
        const coordinates = getCafeCoordinates(cafe)
        if (!coordinates) continue

        const marker = createCafeMarker(cafe, coordinates)
        cafeMarkers.set(String(cafe._id), marker)
        bounds.push([coordinates.lat, coordinates.lng])
    }

    if (bounds.length > 0) {
        cafeMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 })
        mapStatus.textContent = `${bounds.length} ${bounds.length === 1 ? 'cafe location is' : 'cafe locations are'} on the map. Select a pin to view cafe details.`
    } else {
        cafeMap.setView(torontoCenter, 11)
        mapStatus.textContent = 'No coordinates in these results yet. Use “Show on map” on a cafe card to locate its address.'
    }
}

async function geocodeAddress(address) {
    const query = address.trim()
    const cached = geocodingCache.get(query)
    if (cached) return cached

    const lookup = geocodingQueue.then(async () => {
        const cachedResult = geocodingCache.get(query)
        if (cachedResult) return cachedResult

        const wait = Math.max(0, 1000 - (Date.now() - lastGeocodingAt))
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait))
        }
        lastGeocodingAt = Date.now()

        const searchQuery = /\btoronto\b/i.test(query)
            ? query
            : `${query}, Toronto, Ontario, Canada`
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(searchQuery)}`,
            { headers: { 'Accept-Language': navigator.language || 'en' } }
        )
        if (!response.ok) {
            throw new Error('The address lookup service is unavailable. Please try again later.')
        }

        const results = await response.json()
        const result = Array.isArray(results) ? results[0] : null
        const coordinates = result ? validCoordinates(result.lat, result.lon) : null
        if (!coordinates) {
            throw new Error('No map location was found for this cafe address.')
        }

        geocodingCache.set(query, coordinates)
        return coordinates
    })

    geocodingQueue = lookup.then(() => undefined, () => undefined)
    return lookup
}

async function showCafeOnMap(cafe) {
    if (!cafeMap) {
        throw new Error('The map is not available. Check your connection and reload the page.')
    }

    const cafeId = String(cafe._id)
    let marker = cafeMarkers.get(cafeId)
    if (!marker) {
        const address = getCafeAddress(cafe)
        if (!address.trim()) {
            throw new Error('This cafe has no coordinates or address in the dataset.')
        }

        mapStatus.textContent = `Looking up the address for ${getCafeName(cafe)}…`
        const coordinates = await geocodeAddress(address)
        marker = createCafeMarker(cafe, coordinates)
        cafeMarkers.set(cafeId, marker)
    }

    const coordinates = marker.getLatLng()
    cafeMap.setView(coordinates, 15)
    highlightCafeMarker(marker)
    marker.openPopup()
    document.querySelector('#map-section').scrollIntoView({ behavior: 'smooth', block: 'start' })
    mapStatus.textContent = `${getCafeName(cafe)} is shown on the map.`
}

function hideSearchSuggestions() {
    searchSuggestions.hidden = true
    searchSuggestions.replaceChildren()
    searchInput.setAttribute('aria-expanded', 'false')
}

function showSearchMessage(message) {
    const option = document.createElement('button')
    option.className = 'search-suggestion-message'
    option.type = 'button'
    option.role = 'option'
    option.disabled = true
    option.textContent = message
    searchSuggestions.replaceChildren(option)
    searchSuggestions.hidden = false
    searchInput.setAttribute('aria-expanded', 'true')
}

function showSearchSuggestions(cafes) {
    searchSuggestions.replaceChildren()
    if (cafes.length === 0) {
        showSearchMessage('No matching cafes found.')
        return
    }

    for (const cafe of cafes.slice(0, 8)) {
        const suggestion = document.createElement('button')
        suggestion.className = 'search-suggestion'
        suggestion.type = 'button'
        suggestion.role = 'option'
        suggestion.setAttribute('aria-selected', 'false')
        suggestion.dataset.cafeId = String(cafe._id)
        suggestion.dataset.cafeName = getCafeName(cafe)

        const name = document.createElement('span')
        name.textContent = getCafeName(cafe)
        suggestion.append(name)

        const address = getCafeAddress(cafe)
        if (address) {
            const addressElement = document.createElement('small')
            addressElement.textContent = address
            suggestion.append(addressElement)
        }

        searchSuggestions.append(suggestion)
    }

    searchSuggestions.hidden = false
    searchInput.setAttribute('aria-expanded', 'true')
}

function makeRatingOptions(selectedValue) {
    const select = document.createElement('select')
    select.required = false

    const unrated = document.createElement('option')
    unrated.value = ''
    unrated.textContent = 'Not rated'
    select.append(unrated)

    for (let value = 1; value <= 5; value += 1) {
        const option = document.createElement('option')
        option.value = String(value)
        option.textContent = `${value} / 5`
        select.append(option)
    }

    select.value = selectedValue == null ? '' : String(selectedValue)
    return select
}

function makeCafeCard(cafe) {
    const cafeId = String(cafe._id)
    const saved = preferences.get(cafeId) ?? {}
    const card = document.createElement('article')
    card.className = 'cafe-card'
    card.id = `cafe-${cafeId}`
    card.tabIndex = -1

    const topLine = document.createElement('div')
    topLine.className = 'card-topline'
    const marker = document.createElement('span')
    marker.className = 'card-marker'
    marker.setAttribute('aria-hidden', 'true')
    marker.textContent = '✳'
    topLine.append(marker)

    const title = document.createElement('h3')
    title.textContent = getCafeName(cafe)
    card.append(topLine, title)

    const address = getCafeAddress(cafe)
    if (address) {
        const addressElement = document.createElement('p')
        addressElement.className = 'cafe-address'
        addressElement.textContent = address
        card.append(addressElement)
    }

    if (address || getCafeCoordinates(cafe)) {
        const mapButton = document.createElement('button')
        mapButton.className = 'map-link'
        mapButton.type = 'button'
        mapButton.textContent = 'Show on map'
        mapButton.addEventListener('click', async () => {
            mapButton.disabled = true
            mapStatus.textContent = `Finding ${getCafeName(cafe)}…`
            try {
                await showCafeOnMap(cafe)
            } catch (error) {
                mapStatus.textContent = error.message
            } finally {
                mapButton.disabled = false
            }
        })
        card.append(mapButton)
    }

    if (typeof cafe.description === 'string' && cafe.description) {
        const description = document.createElement('p')
        description.className = 'cafe-notes'
        description.textContent = cafe.description
        card.append(description)
    }

    const form = document.createElement('form')
    form.className = 'cafe-form preference-form'
    form.dataset.cafeId = cafeId

    const ratings = document.createElement('div')
    ratings.className = 'form-row'
    for (const [field, label] of [['wifiQuality', 'Wi-Fi'], ['foodQuality', 'Food']]) {
        const fieldLabel = document.createElement('label')
        fieldLabel.textContent = `${label} quality`
        const select = makeRatingOptions(saved[field])
        select.name = field
        fieldLabel.append(select)
        ratings.append(fieldLabel)
    }

    const favoriteLabel = document.createElement('label')
    favoriteLabel.className = 'check-label favorite-label'
    const favorite = document.createElement('input')
    favorite.type = 'checkbox'
    favorite.name = 'favorite'
    favorite.checked = Boolean(saved.favorite)
    favoriteLabel.append(favorite, document.createTextNode(' Save to favorites'))

    const notesLabel = document.createElement('label')
    notesLabel.textContent = 'Personal notes'
    const notes = document.createElement('textarea')
    notes.name = 'personalNotes'
    notes.maxLength = 1000
    notes.rows = 2
    notes.placeholder = 'Your own reminder…'
    notes.value = saved.personalNotes ?? ''
    notesLabel.append(notes)

    const footer = document.createElement('div')
    footer.className = 'form-footer'
    const status = document.createElement('p')
    status.className = 'status-message'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const button = document.createElement('button')
    button.className = 'primary-button'
    button.type = 'submit'
    button.textContent = 'Save preferences'
    const clearButton = document.createElement('button')
    clearButton.className = 'secondary-button delete-preferences-button'
    clearButton.type = 'button'
    clearButton.textContent = 'Clear saved preferences'
    clearButton.addEventListener('click', async () => {
        button.disabled = true
        clearButton.disabled = true
        status.textContent = 'Clearing saved preferences…'

        try {
            const result = await requestJson(`/api/preferences/${encodeURIComponent(cafeId)}`, {
                method: 'DELETE'
            })
            preferences.delete(cafeId)
            form.elements.wifiQuality.value = ''
            form.elements.foodQuality.value = ''
            form.elements.favorite.checked = false
            form.elements.personalNotes.value = ''
            status.textContent = result.deleted
                ? 'Saved preferences cleared from this browser.'
                : 'No saved preferences were found for this cafe.'
        } catch (error) {
            status.textContent = error.message
        } finally {
            button.disabled = false
            clearButton.disabled = false
        }
    })
    const actions = document.createElement('div')
    actions.className = 'form-actions'
    actions.append(button, clearButton)
    footer.append(status, actions)

    form.append(ratings, favoriteLabel, notesLabel, footer)
    card.append(form)
    return card
}

async function loadCafes(terms = '', selectedCafeId = '', { showSuggestions = false } = {}) {
    const requestId = ++cafeLoadRequestId
    listStatus.textContent = 'Loading cafes…'
    cafeList.replaceChildren()
    if (!terms.trim() || !showSuggestions) hideSearchSuggestions()
    if (cafeMap) {
        updateMapMarkers([])
        mapStatus.textContent = 'Loading cafe locations…'
    }

    const query = terms.trim()
    const url = query
        ? `/api/cafes/search?terms=${encodeURIComponent(query)}`
        : '/api/cafes'

    try {
        await requestJson('/api/session')
        const [cafes, savedPreferences] = await Promise.all([
            requestJson(url),
            requestJson('/api/preferences')
        ])
        if (requestId !== cafeLoadRequestId) return

        if (showSuggestions && searchInput.value.trim() === terms.trim()) {
            showSearchSuggestions(cafes)
        }

        preferences.clear()
        for (const preference of savedPreferences) {
            preferences.set(preference.cafeId, preference)
        }

        const visibleCafes = selectedCafeId
            ? cafes.filter(cafe => String(cafe._id) === selectedCafeId)
            : cafes

        if (visibleCafes.length === 0) {
            listStatus.textContent = query
                ? 'No cafes match that search. Try another name.'
                : 'No cafes were found in the fixed cafe collection.'
            if (cafeMap) mapStatus.textContent = 'No cafes to show on the map.'
            return
        }

        listStatus.textContent = `${visibleCafes.length} ${visibleCafes.length === 1 ? 'place' : 'places'} to explore`
        cafeList.replaceChildren(...visibleCafes.map(makeCafeCard))
        updateMapMarkers(visibleCafes)
        if (selectedCafeId) {
            document.getElementById(`cafe-${selectedCafeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
    } catch (error) {
        if (requestId !== cafeLoadRequestId) return
        listStatus.textContent = error.message
        if (cafeMap) mapStatus.textContent = `Unable to load cafe locations: ${error.message}`
        if (showSuggestions && searchInput.value.trim() === terms.trim()) {
            showSearchMessage('Search is unavailable. Please try again.')
        }
    }
}

searchForm.addEventListener('submit', event => {
    event.preventDefault()
    clearTimeout(searchTimeout)
    hideSearchSuggestions()
    loadCafes(searchInput.value)
})

searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    cafeLoadRequestId += 1
    const terms = searchInput.value.trim()
    if (!terms) {
        loadCafes()
        return
    }

    hideSearchSuggestions()
    searchTimeout = setTimeout(() => {
        loadCafes(terms, '', { showSuggestions: true })
    }, 250)
})

searchSuggestions.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return
    const suggestion = event.target.closest('button[data-cafe-id]')
    if (!(suggestion instanceof HTMLButtonElement)) return

    clearTimeout(searchTimeout)
    searchInput.value = suggestion.dataset.cafeName
    hideSearchSuggestions()
    loadCafes(searchInput.value, suggestion.dataset.cafeId)
})

document.addEventListener('click', event => {
    if (!searchContainer.contains(event.target)) hideSearchSuggestions()
})

cafeList.addEventListener('submit', async event => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.matches('.preference-form')) return

    event.preventDefault()
    const status = form.querySelector('.status-message')
    const button = form.querySelector('button[type="submit"]')
    const clearButton = form.querySelector('.delete-preferences-button')
    const formData = new FormData(form)
    const wifiValue = formData.get('wifiQuality')
    const foodValue = formData.get('foodQuality')
    const preference = {
        wifiQuality: wifiValue ? Number(wifiValue) : null,
        foodQuality: foodValue ? Number(foodValue) : null,
        favorite: formData.has('favorite'),
        personalNotes: formData.get('personalNotes')
    }

    button.disabled = true
    clearButton.disabled = true
    status.textContent = 'Saving…'

    try {
        const saved = await requestJson(`/api/preferences/${encodeURIComponent(form.dataset.cafeId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preference)
        })
        preferences.set(saved.cafeId, saved)
        status.textContent = 'Preferences saved in this browser.'
    } catch (error) {
        status.textContent = error.message
    } finally {
        button.disabled = false
        clearButton.disabled = false
    }
})

initializeMap()
loadCafes()
