const cafeList = document.querySelector('#cafe-list')
const listStatus = document.querySelector('#list-status')
const mapStatus = document.querySelector('#map-status')
const searchForm = document.querySelector('#search-form')
const searchInput = document.querySelector('#search-terms')
const searchContainer = document.querySelector('.search-container')
const searchSuggestions = document.querySelector('#search-suggestions')
const listTools = document.querySelector('#list-tools')
const filterButtons = [...document.querySelectorAll('#list-tools [data-filter]')]
const mapFilterButtons = [...document.querySelectorAll('.map-legend [data-map-filter]')]
const loadMoreButton = document.querySelector('#load-more')
const backToTopButton = document.querySelector('#back-to-top')
const PAGE_SIZE = 9
let currentFilter = 'all'
// 'all' shows every cafe, 'saved' only the visitor's list, 'favorite' only hearts.
let mapPinFilter = 'all'
const preferences = new Map()
// Cafes in the visitor's list, keyed by ID for map pins and location lookups.
const savedCafes = new Map()
const savedMarkers = new Map()
// Temporary pins for cafes that are not in the list (search results).
const resultMarkers = new Map()
const pendingLocations = new Set()
const failedLocations = new Set()
let savedCafesLoaded = false
const geocodingCache = new Map()
const torontoCenter = [43.6532, -79.3832]
// Default map view: zoomed in on downtown Toronto so the pins spread out.
const downtownCenter = [43.6555, -79.3870]
const DOWNTOWN_ZOOM = 14
let cafeMap
const markerIcons = {}
let selectedCafeMarker
let geocodingQueue = Promise.resolve()
let lastGeocodingAt = 0
let searchTimeout
let cafeLoadRequestId = 0
let currentCafes = []
// Every cafe in the dataset, so the map can pin all of them from the start.
let allCafes = []
let currentQuery = ''
let visibleCafeCount = PAGE_SIZE
let currentSelectedCafeId = ''
const openEditors = new Set()
const cardMessages = new Map()
const openDetails = new Set()

// Masonry layout: each card spans as many small grid rows as its height needs,
// so a tall (expanded) card no longer leaves gaps beside it in its row.
const MASONRY_ROW_HEIGHT = 4
const cardResizeObserver = 'ResizeObserver' in window
    ? new ResizeObserver(entries => {
        for (const entry of entries) sizeCardForMasonry(entry.target)
    })
    : null
if (cardResizeObserver) cafeList.classList.add('is-masonry')

function sizeCardForMasonry(card) {
    if (!card.isConnected) return
    const styles = window.getComputedStyle(cafeList)
    const gap = parseFloat(styles.columnGap) || 0
    const height = card.getBoundingClientRect().height
    card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + gap) / MASONRY_ROW_HEIGHT))}`
}

// Kept in sync with backend/validation/preferences.js.
const RATING_FIELDS = [
    { field: 'wifiQuality', label: 'Wi-Fi quality' },
    { field: 'powerOutlets', label: 'Power outlets' },
    { field: 'studyFriendly', label: 'Study friendly' },
    { field: 'spacious', label: 'Spacious' },
    { field: 'cleanliness', label: 'Cleanliness' },
    { field: 'noiseLevel', label: 'Noise level', lowerIsBetter: true },
    { field: 'foodAndDrinkQuality', label: 'Food & drink' }
]

function emptyPreference(cafeId) {
    return {
        cafeId,
        inCollection: true,
        ...Object.fromEntries(RATING_FIELDS.map(({ field }) => [field, null])),
        favorite: false,
        recommend: null,
        personalNotes: ''
    }
}

const SESSION_STORAGE_KEY = 'studyCafeSession'
const SESSION_HEADER = 'X-Study-Session'
const sessionTokenPattern = /^[a-f0-9]{64}$/
let sessionToken = readStoredSessionToken()
let sessionRequest

function readStoredSessionToken() {
    try {
        const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)
        return stored && sessionTokenPattern.test(stored) ? stored : null
    } catch {
        // Storage can be blocked, for example in some embedded previews.
        return null
    }
}

function storeSessionToken(token) {
    sessionToken = token
    try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, token)
    } catch {
        // Fall back to keeping the token for this page view only.
    }
}

// Every request carries the browser's anonymous token in a header, so the
// list works even where the browser blocks the session cookie.
function ensureSession() {
    if (sessionToken) return Promise.resolve(sessionToken)

    sessionRequest ??= fetch('/api/session', { credentials: 'same-origin' })
        .then(async response => {
            const payload = await readJson(response)
            if (!response.ok || !sessionTokenPattern.test(payload.token ?? '')) {
                throw new Error(payload.error ?? 'Your session could not be started. Please reload the page.')
            }
            storeSessionToken(payload.token)
            return payload.token
        })
        .finally(() => {
            sessionRequest = undefined
        })

    return sessionRequest
}

async function readJson(response) {
    try {
        return await response.json()
    } catch {
        return {}
    }
}

async function requestJson(url, options = {}) {
    const token = await ensureSession()
    const headers = new Headers(options.headers)
    headers.set(SESSION_HEADER, token)

    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' })
    const payload = await readJson(response)

    if (!response.ok) {
        throw new Error(payload.error ?? `The request could not be completed (error ${response.status}).`)
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

    return decodePlusCode(cafe.plusCodes ?? cafe.plusCode)
}

const PLUS_CODE_ALPHABET = '23456789CFGHJMPQRVWX'
const PLUS_CODE_PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125]

// Turns a plus code such as "MJ3F+JX Toronto, Ontario" into coordinates.
// Short codes are completed using the Toronto area as the reference point,
// which works for any cafe within roughly 50 km of downtown.
function decodePlusCode(value) {
    if (typeof value !== 'string') return null
    const match = value.trim().toUpperCase().match(/^([23456789CFGHJMPQRVWX]{2,8})\+([23456789CFGHJMPQRVWX]*)/)
    if (!match) return null

    const [, beforeSeparator, afterSeparator] = match
    if (beforeSeparator.length % 2 !== 0 || afterSeparator.length === 1) return null

    const missing = 8 - beforeSeparator.length
    const prefix = missing > 0 ? plusCodePrefix(torontoCenter[0], torontoCenter[1], missing) : ''
    let area = decodeFullPlusCode(prefix + beforeSeparator + afterSeparator)
    if (!area) return null

    if (missing > 0) {
        // Move to the neighbouring cell when that is closer to the reference.
        const resolution = PLUS_CODE_PAIR_RESOLUTIONS[missing / 2 - 1]
        const half = resolution / 2
        let { lat, lng } = area
        if (torontoCenter[0] + half < lat && lat - resolution >= -90) lat -= resolution
        else if (torontoCenter[0] - half > lat && lat + resolution <= 90) lat += resolution
        if (torontoCenter[1] + half < lng) lng -= resolution
        else if (torontoCenter[1] - half > lng) lng += resolution
        area = { lat, lng }
    }

    return validCoordinates(area.lat, area.lng)
}

function plusCodePrefix(latitude, longitude, length) {
    let lat = latitude + 90
    let lng = longitude + 180
    let prefix = ''
    for (let pair = 0; pair < length / 2; pair += 1) {
        const resolution = PLUS_CODE_PAIR_RESOLUTIONS[pair]
        const latDigit = Math.floor(lat / resolution)
        const lngDigit = Math.floor(lng / resolution)
        prefix += PLUS_CODE_ALPHABET[latDigit] + PLUS_CODE_ALPHABET[lngDigit]
        lat -= latDigit * resolution
        lng -= lngDigit * resolution
    }
    return prefix
}

// Returns the centre of the area covered by a full (8+ character) plus code.
function decodeFullPlusCode(code) {
    let lat = -90
    let lng = -180
    let latSize = 0
    let lngSize = 0

    for (let index = 0; index < code.length; index += 1) {
        const digit = PLUS_CODE_ALPHABET.indexOf(code[index])
        if (digit < 0) return null

        if (index < 10) {
            const resolution = PLUS_CODE_PAIR_RESOLUTIONS[Math.floor(index / 2)]
            if (index % 2 === 0) {
                lat += digit * resolution
                latSize = resolution
            } else {
                lng += digit * resolution
                lngSize = resolution
            }
        } else {
            // Grid refinement: each extra character splits the cell into 5 rows × 4 columns.
            latSize /= 5
            lngSize /= 4
            lat += Math.floor(digit / 4) * latSize
            lng += (digit % 4) * lngSize
        }
    }

    return { lat: lat + latSize / 2, lng: lng + lngSize / 2 }
}

function initializeMap() {
    if (!window.L) {
        mapStatus.textContent = 'The map could not be loaded. Check your connection and reload the page.'
        return
    }

    cafeMap = window.L.map('cafe-map', { scrollWheelZoom: false }).setView(downtownCenter, DOWNTOWN_ZOOM)
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(cafeMap)
    for (const [variant, className, html] of [
        ['saved', 'cafe-map-marker is-saved', '<img class="map-marker-svg" src="/assets/map-pin-map.svg" alt="">'],
        ['favorite', 'cafe-map-marker is-favorite', '<img class="map-marker-svg" src="/assets/heart-filled-map.svg" alt="">'],
        ['result', 'cafe-map-marker is-result', '<img class="map-marker-svg" src="/assets/all-cafes-pin-map.svg" alt="">']
    ]) {
        markerIcons[variant] = window.L.divIcon({
            className,
            html,
            iconSize: [26, 36],
            iconAnchor: [13, 36],
            popupAnchor: [0, -32]
        })
    }
    mapStatus.textContent = 'Loading café pins…'
}

function markerIconFor(cafeId) {
    if (!isInPersonalCollection(cafeId)) return markerIcons.result
    if (mapPinFilter === 'saved') return markerIcons.saved
    if (mapPinFilter === 'favorite') return markerIcons.favorite
    return preferences.get(cafeId)?.favorite === true ? markerIcons.favorite : markerIcons.saved
}

function markerPopup(cafe) {
    const cafeId = String(cafe._id)
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

    if (isInPersonalCollection(cafeId)) {
        const tag = document.createElement('p')
        tag.className = 'map-popup-tag'
        tag.textContent = preferences.get(cafeId)?.favorite ? '♥ Favourite · In your list' : 'In your list'
        content.append(tag)
    }

    const detailsButton = document.createElement('button')
    detailsButton.className = 'map-popup-button'
    detailsButton.type = 'button'
    detailsButton.textContent = 'View cafe details'
    detailsButton.addEventListener('click', () => openCafeCard(cafeId))
    content.append(detailsButton)
    return content
}

// Scrolls to a cafe's card, switching back to the full list if a search or
// filter is currently hiding a saved cafe.
async function openCafeCard(cafeId) {
    let card = document.getElementById(`cafe-${cafeId}`)
    if (!card) {
        // The card can be missing because a search or list filter is hiding it,
        // or because it is on a page of results that has not been loaded yet.
        if (currentQuery || currentSelectedCafeId || currentFilter !== 'all') {
            clearTimeout(searchTimeout)
            searchInput.value = ''
            setFilter('all')
            currentSelectedCafeId = ''
            await loadCafes()
        }
        card = document.getElementById(`cafe-${cafeId}`)
        while (!card && visibleCafeCount < currentCafes.length) {
            visibleCafeCount += PAGE_SIZE
            renderCafes()
            card = document.getElementById(`cafe-${cafeId}`)
        }
    }
    if (!card) return
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.focus({ preventScroll: true })
}

function highlightCafeMarker(marker) {
    if (selectedCafeMarker && selectedCafeMarker !== marker) {
        selectedCafeMarker.getElement()?.classList.remove('is-selected')
    }
    selectedCafeMarker = marker
    marker.getElement()?.classList.add('is-selected')
}

function createCafeMarker(cafe, coordinates) {
    const cafeId = String(cafe._id)
    // Keep the visitor's own pins on top of the other cafes' pins.
    const marker = window.L.marker([coordinates.lat, coordinates.lng], {
        icon: markerIconFor(cafeId),
        zIndexOffset: isInPersonalCollection(cafeId) ? 1000 : 0
    })
        .addTo(cafeMap)
        .bindPopup(() => markerPopup(cafe))
    marker.on('click', () => highlightCafeMarker(marker))
    return marker
}

function shouldShowSavedMarker(cafeId) {
    return mapPinFilter !== 'favorite' || preferences.get(cafeId)?.favorite === true
}

function setMarkerVisibility(marker, visible) {
    if (!cafeMap) return
    if (visible) {
        if (!cafeMap.hasLayer(marker)) marker.addTo(cafeMap)
        return
    }

    if (cafeMap.hasLayer(marker)) {
        if (selectedCafeMarker === marker) selectedCafeMarker = null
        marker.remove()
    }
}

function removeMarker(markers, cafeId) {
    const marker = markers.get(cafeId)
    if (!marker) return
    if (selectedCafeMarker === marker) selectedCafeMarker = null
    marker.remove()
    markers.delete(cafeId)
}

function storedLocation(cafe) {
    const mapLocation = preferences.get(String(cafe._id))?.mapLocation
    return getCafeCoordinates(cafe)
        ?? (mapLocation ? validCoordinates(mapLocation.lat, mapLocation.lng) : null)
}

function canShowCafeOnMap(cafe) {
    const cafeId = String(cafe._id)
    return Boolean(storedLocation(cafe))
        || (Boolean(getCafeAddress(cafe).trim()) && !failedLocations.has(cafeId))
}

function disableCafeMapButton(cafeId) {
    const card = document.getElementById(`cafe-${cafeId}`)
    const button = card?.querySelector('.card-map-button')
    if (button instanceof HTMLButtonElement) button.disabled = true
}

function addSavedMarker(cafe, coordinates) {
    const cafeId = String(cafe._id)
    removeMarker(resultMarkers, cafeId)
    if (savedMarkers.has(cafeId)) return savedMarkers.get(cafeId)
    const marker = createCafeMarker(cafe, coordinates)
    savedMarkers.set(cafeId, marker)
    setMarkerVisibility(marker, shouldShowSavedMarker(cafeId))
    return marker
}

// Keeps saved marker layers in sync with collection data and the map legend.
function syncSavedMarkers() {
    if (!cafeMap) return

    for (const cafeId of [...savedMarkers.keys()]) {
        if (!savedCafes.has(cafeId) || !isInPersonalCollection(cafeId)) {
            removeMarker(savedMarkers, cafeId)
        }
    }

    const needLookup = []
    for (const [cafeId, cafe] of savedCafes) {
        if (!isInPersonalCollection(cafeId)) continue

        const marker = savedMarkers.get(cafeId)
        if (marker) {
            const icon = markerIconFor(cafeId)
            if (marker.options.icon !== icon) {
                marker.setIcon(icon)
                if (selectedCafeMarker === marker) marker.getElement()?.classList.add('is-selected')
            }
            setMarkerVisibility(marker, shouldShowSavedMarker(cafeId))
            continue
        }

        const coordinates = storedLocation(cafe)
        if (coordinates) {
            addSavedMarker(cafe, coordinates)
        } else if (!failedLocations.has(cafeId) && !pendingLocations.has(cafeId) && getCafeAddress(cafe).trim()) {
            needLookup.push(cafe)
        }
    }

    if (needLookup.length > 0) placeSavedPins(needLookup)
}

// Looks up saved cafes' addresses one at a time (the lookup service allows
// one request per second) and remembers each position on the cafe profile.
async function placeSavedPins(cafes) {
    for (const cafe of cafes) pendingLocations.add(String(cafe._id))
    describeMap()

    let placed = 0
    for (const cafe of cafes) {
        const cafeId = String(cafe._id)
        try {
            const coordinates = await geocodeAddress(getCafeAddress(cafe))
            if (!isInPersonalCollection(cafeId) || !savedCafes.has(cafeId)) continue

            addSavedMarker(cafe, coordinates)
            placed += 1
            const preference = preferences.get(cafeId)
            if (preference) preference.mapLocation = coordinates
            requestJson(`/api/collection/${encodeURIComponent(cafeId)}/location`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(coordinates)
            }).catch(error => console.warn(`Could not remember the map position for ${getCafeName(cafe)}:`, error))
        } catch {
            failedLocations.add(cafeId)
            disableCafeMapButton(cafeId)
        } finally {
            pendingLocations.delete(cafeId)
            describeMap()
        }
    }

    if (placed > 0 && mapPinFilter !== 'all' && !cafeMap.getContainer().querySelector('.leaflet-popup')) {
        fitMapToPins()
    }
}

// Pins every cafe that is not in the list, so any of them can be clicked.
function syncResultMarkers(visibleCafes) {
    if (!cafeMap) return
    const cafesById = new Map()
    for (const cafe of [...allCafes, ...visibleCafes]) cafesById.set(String(cafe._id), cafe)
    const pinnedCafes = [...cafesById.values()]
    const visibleIds = new Set(cafesById.keys())

    for (const cafeId of [...resultMarkers.keys()]) {
        if (!visibleIds.has(cafeId) || isInPersonalCollection(cafeId)) {
            removeMarker(resultMarkers, cafeId)
        } else {
            setMarkerVisibility(resultMarkers.get(cafeId), mapPinFilter === 'all')
        }
    }

    for (const cafe of pinnedCafes) {
        const cafeId = String(cafe._id)
        if (isInPersonalCollection(cafeId) || resultMarkers.has(cafeId)) continue
        const coordinates = getCafeCoordinates(cafe)
        if (coordinates) {
            const marker = createCafeMarker(cafe, coordinates)
            resultMarkers.set(cafeId, marker)
            setMarkerVisibility(marker, mapPinFilter === 'all')
        }
    }
}

function showDowntown() {
    cafeMap?.setView(downtownCenter, DOWNTOWN_ZOOM)
}

function fitMapToPins() {
    if (!cafeMap) return
    const bounds = [...savedMarkers.values(), ...resultMarkers.values()]
        .filter(marker => cafeMap.hasLayer(marker))
        .map(marker => marker.getLatLng())
    if (bounds.length > 0) {
        cafeMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 })
    } else {
        showDowntown()
    }
}

function describeMap() {
    if (!cafeMap) return
    const total = [...savedCafes.keys()].filter(isInPersonalCollection).length
    const allPinned = savedMarkers.size + resultMarkers.size
    const overview = `${allPinned} ${allPinned === 1 ? 'café is' : 'cafés are'} pinned on the map. Click any pin for details.`
    if (total === 0) {
        mapStatus.textContent = overview
        return
    }

    const pinned = savedMarkers.size
    const pending = pendingLocations.size
    const failed = [...failedLocations].filter(cafeId => savedCafes.has(cafeId) && !savedMarkers.has(cafeId)).length
    const parts = [overview, `${pinned} of your ${total} saved ${total === 1 ? 'café is' : 'cafés are'} shown with your list pin.`]
    if (pending > 0) parts.push(`Placing ${pending} more…`)
    if (failed > 0) parts.push(`${failed} couldn’t be located from ${failed === 1 ? 'its' : 'their'} address.`)
    mapStatus.textContent = parts.join(' ')
}

// Searching or loading more cafes leaves the visitor's map view alone; the
// map starts on downtown and only moves when the visitor asks it to.
function updateMap(visibleCafes) {
    syncSavedMarkers()
    syncResultMarkers(visibleCafes)
    describeMap()
}

// The address lookup service fails on building descriptions, unit numbers and
// postal codes, so keep only the street address and city.
function cleanAddressForLookup(address) {
    const parts = address.split(',').map(part => part.trim()).filter(Boolean)
    const streetIndex = parts.findIndex(part => /^\d/.test(part))
    const kept = (streetIndex > 0 ? parts.slice(streetIndex) : parts)
        .map(part => part
            .replace(/\s*(?:#|\b(?:unit|suite|ste|apt)\b\.?#?)\s*[\w-]+/gi, '')
            .replace(/\b(ON|Ontario)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i, '$1')
            .trim())
        .filter(Boolean)
    const cleaned = kept.join(', ')
    return /\b(ON|Ontario)\b/i.test(cleaned) ? `${cleaned}, Canada` : `${cleaned}, Toronto, Ontario, Canada`
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

        const searchQuery = cleanAddressForLookup(query)
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
    const saved = isInPersonalCollection(cafeId)
    // Switch back to "All Cafés" if the current pin filter would hide this cafe.
    if ((mapPinFilter === 'saved' && !saved) || (mapPinFilter === 'favorite' && preferences.get(cafeId)?.favorite !== true)) {
        setMapPinFilter('all', { moveMap: false })
    }
    let marker = saved ? savedMarkers.get(cafeId) : resultMarkers.get(cafeId)
    if (!marker) {
        let coordinates = saved ? storedLocation(cafe) : getCafeCoordinates(cafe)
        if (!coordinates) {
            const address = getCafeAddress(cafe)
            if (!address.trim()) {
                throw new Error('This cafe has no coordinates or address in the dataset.')
            }
            mapStatus.textContent = `Looking up the address for ${getCafeName(cafe)}…`
            try {
                coordinates = await geocodeAddress(address)
            } catch (error) {
                failedLocations.add(cafeId)
                disableCafeMapButton(cafeId)
                describeMap()
                throw error
            }
        }

        if (saved) {
            savedCafes.set(cafeId, cafe)
            failedLocations.delete(cafeId)
            marker = addSavedMarker(cafe, coordinates)
            if (!preferences.get(cafeId)?.mapLocation && !getCafeCoordinates(cafe)) {
                preferences.get(cafeId).mapLocation = coordinates
                requestJson(`/api/collection/${encodeURIComponent(cafeId)}/location`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(coordinates)
                }).catch(() => {})
            }
        } else {
            marker = createCafeMarker(cafe, coordinates)
            resultMarkers.set(cafeId, marker)
        }
    }

    cafeMap.setView(marker.getLatLng(), 15)
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

function isInPersonalCollection(cafeId) {
    const preference = preferences.get(cafeId)
    return Boolean(preference && preference.inCollection !== false)
}

function hasRatings(preference) {
    return RATING_FIELDS.some(({ field }) => preference?.[field] != null)
}

// Average of all rated fields out of 5. Quieter cafes score higher for noise.
function studyScore(preference) {
    const values = RATING_FIELDS
        .map(({ field, lowerIsBetter }) => {
            const value = preference?.[field]
            if (value == null) return null
            return lowerIsBetter ? 6 - value : value
        })
        .filter(value => value != null)

    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function makeElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text != null) element.textContent = text
    return element
}

function makeStatus(className = 'collection-action-status') {
    const status = makeElement('p', className)
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    return status
}

function makeRatingSlider({ field, label, lowerIsBetter }, selectedValue, cafeId) {
    const fieldId = `cafe-${cafeId}-rating-${field}`
    const fieldContainer = makeElement('div', 'rating-field')
    fieldContainer.dataset.ratingField = field

    const fieldLabel = makeElement('label', null, label)
    fieldLabel.htmlFor = fieldId

    const displayValue = selectedValue == null
        ? 3
        : lowerIsBetter ? 6 - selectedValue : selectedValue
    const valueOutput = document.createElement('output')
    valueOutput.className = 'rating-value'
    valueOutput.htmlFor = fieldId
    valueOutput.textContent = `${displayValue}/5`

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.id = fieldId
    slider.name = field
    slider.min = '1'
    slider.max = '5'
    slider.step = '1'
    slider.value = String(displayValue)
    slider.setAttribute('aria-valuetext', `${displayValue} out of 5`)

    const unratedLabel = makeElement('label', 'rating-unrated')
    const unrated = document.createElement('input')
    unrated.type = 'checkbox'
    unrated.name = `${field}-unrated`
    unrated.checked = false
    unrated.setAttribute('aria-label', `Mark ${label} as not rated`)
    unratedLabel.append(unrated, document.createTextNode('Not rated'))

    unrated.addEventListener('change', () => {
        slider.disabled = unrated.checked
        valueOutput.textContent = unrated.checked ? 'Not rated' : `${slider.value}/5`
        slider.setAttribute('aria-valuetext', unrated.checked ? 'Not rated' : `${slider.value} out of 5`)
    })
    slider.addEventListener('input', () => {
        valueOutput.textContent = `${slider.value}/5`
        slider.setAttribute('aria-valuetext', `${slider.value} out of 5`)
    })

    fieldContainer.append(fieldLabel, valueOutput, slider, unratedLabel)
    return fieldContainer
}

function makeBadges(preference) {
    const badges = makeElement('div', 'card-badges')
    if (preference.recommend === true) {
        badges.append(makeElement('span', 'badge badge-recommend', 'Recommended'))
    } else if (preference.recommend === false) {
        badges.append(makeElement('span', 'badge badge-not-recommend', 'Not Recommended'))
    }

    const score = studyScore(preference)
    if (score != null) {
        const scoreBadge = makeElement('span', 'badge badge-score', `${score.toFixed(1)} / 5`)
        scoreBadge.title = 'Study score: the average of your ratings, with quieter cafes scoring higher'
        scoreBadge.setAttribute('aria-label', `Study score ${score.toFixed(1)} out of 5`)
        badges.append(scoreBadge)
    }
    return badges
}

function makePreferenceSummary(preference) {
    const summary = makeElement('div', 'preference-summary')

    if (hasRatings(preference)) {
        const list = makeElement('dl', 'rating-summary')
        for (const { field, label, lowerIsBetter } of RATING_FIELDS) {
            const value = preference[field]
            if (value == null) continue
            const displayValue = lowerIsBetter ? 6 - value : value
            const row = makeElement('div', 'rating-row')
            const term = makeElement('dt', null, label)
            const detail = makeElement('dd')
            const dots = makeElement('span', 'rating-dots', '●'.repeat(displayValue) + '○'.repeat(5 - displayValue))
            dots.setAttribute('aria-hidden', 'true')
            const text = makeElement('span', 'rating-text', `${displayValue}/5`)
            const srText = makeElement('span', 'sr-only', `${displayValue} out of 5, `)
            detail.append(dots, srText, text)
            row.append(term, detail)
            list.append(row)
        }
        summary.append(list)
    }

    if (preference.personalNotes) {
        const notes = makeElement('blockquote', 'personal-notes', preference.personalNotes)
        summary.append(notes)
    }

    if (!hasRatings(preference) && !preference.personalNotes) {
        summary.append(makeElement('p', 'empty-profile', 'No ratings or notes yet. Select “Edit” to review this cafe.'))
    }

    return summary
}

function makePreferenceForm(cafe, preference, status) {
    const cafeId = String(cafe._id)
    const form = makeElement('form', 'cafe-form preference-form')
    const nameId = `cafe-${cafeId}-title`
    form.setAttribute('aria-labelledby', nameId)

    const ratings = makeElement('div', 'form-row rating-grid')
    for (const ratingField of RATING_FIELDS) {
        ratings.append(makeRatingSlider(ratingField, preference[ratingField.field], cafeId))
    }
    const ratingScaleHint = makeElement('p', 'rating-scale-hint', '1 = Worst, 5 = Best')

    const recommendGroup = makeElement('fieldset', 'recommend-group')
    recommendGroup.append(makeElement('legend', null, 'Would you recommend it?'))
    const currentRecommend = preference.recommend === true ? 'yes' : preference.recommend === false ? 'no' : ''
    for (const [value, label] of [['yes', 'Recommend'], ['no', 'Don’t recommend'], ['', 'Undecided']]) {
        const optionLabel = makeElement('label', 'check-label')
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'recommend'
        radio.value = value
        radio.checked = value === currentRecommend
        optionLabel.append(radio, document.createTextNode(` ${label}`))
        recommendGroup.append(optionLabel)
    }


    const notesLabel = makeElement('label')
    notesLabel.append(document.createTextNode('Notes'))
    const notes = document.createElement('textarea')
    notes.name = 'personalNotes'
    notes.maxLength = 1000
    notes.rows = 3
    notes.placeholder = 'Best seats, opening hours, what to order…'
    notes.value = preference.personalNotes ?? ''
    notesLabel.append(notes)

    const actions = makeElement('div', 'form-actions')
    const saveButton = makeElement('button', 'primary-button', 'Save')
    saveButton.type = 'submit'
    const cancelButton = makeElement('button', 'secondary-button', 'Cancel')
    cancelButton.type = 'button'
    cancelButton.addEventListener('click', () => {
        openEditors.delete(cafeId)
        replaceCard(cafe, { focus: '.edit-button' })
    })
    actions.append(cancelButton, saveButton)

    form.append(ratingScaleHint, ratings, recommendGroup, notesLabel, actions)

    form.addEventListener('submit', async event => {
        event.preventDefault()
        const formData = new FormData(form)
        const recommendValue = formData.get('recommend')
        const ratingValues = Object.fromEntries(RATING_FIELDS.map(({ field, lowerIsBetter }) => {
            if (formData.has(`${field}-unrated`)) return [field, null]
            const displayValue = Number(formData.get(field))
            return [field, lowerIsBetter ? 6 - displayValue : displayValue]
        }))
        const body = {
            ...ratingValues,
            favorite: Boolean(preferences.get(cafeId)?.favorite),
            recommend: recommendValue === 'yes' ? true : recommendValue === 'no' ? false : null,
            personalNotes: formData.get('personalNotes') ?? ''
        }

        saveButton.disabled = true
        cancelButton.disabled = true
        status.textContent = 'Saving…'

        try {
            const saved = await requestJson(`/api/preferences/${encodeURIComponent(cafeId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            preferences.set(cafeId, { ...(preferences.get(cafeId) ?? {}), ...saved })
            syncSavedMarkers()
            openEditors.delete(cafeId)
            cardMessages.set(cafeId, 'Preferences saved.')
            replaceCard(cafe, { focus: '.edit-button' })
        } catch (error) {
            status.textContent = error.message
            saveButton.disabled = false
            cancelButton.disabled = false
        }
    })

    return form
}

const WEEKDAYS = [
    ['monday', 'Monday'],
    ['tuesday', 'Tuesday'],
    ['wednesday', 'Wednesday'],
    ['thursday', 'Thursday'],
    ['friday', 'Friday'],
    ['saturday', 'Saturday'],
    ['sunday', 'Sunday']
]

function torontoWeekday() {
    try {
        return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/Toronto' })
            .format(new Date())
            .toLowerCase()
    } catch {
        return ''
    }
}

function formatClockTime(hours, minutes) {
    const hour = Number(hours)
    const suffix = hour >= 12 && hour < 24 ? 'PM' : 'AM'
    const displayHour = hour % 12 === 0 ? 12 : hour % 12
    return `${displayHour}:${minutes} ${suffix}`
}

function formatHours(value) {
    if (typeof value !== 'string' || !value.trim()) return 'Not listed'
    const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/)
    if (!match) return value.trim()
    return `${formatClockTime(match[1], match[2])} – ${formatClockTime(match[3], match[4])}`
}

function formatPhone(value) {
    const digits = String(value).replace(/\D/g, '')
    const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (local.length !== 10) return { display: String(value), href: digits ? `tel:+${digits}` : '' }
    return {
        display: `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`,
        href: `tel:+1${local}`
    }
}

function safeWebLink(value) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
    } catch {
        return null
    }
}

function makeDetailRow(label, content) {
    const row = makeElement('div', 'detail-row')
    row.append(makeElement('dt', null, label))
    const detail = makeElement('dd')
    detail.append(content)
    row.append(detail)
    return row
}

function makeCafeDetails(cafe) {
    const cafeId = String(cafe._id)
    const details = makeElement('details', 'cafe-details')
    details.open = openDetails.has(cafeId)
    details.addEventListener('toggle', () => {
        if (details.open) openDetails.add(cafeId)
        else openDetails.delete(cafeId)
        details.closest('.cafe-card')?.classList.toggle('has-open-details', details.open)
    })
    const summary = makeElement('summary', null, 'View More Details')
    summary.setAttribute('aria-label', `View more about ${getCafeName(cafe)}`)
    details.append(summary)
    const body = makeElement('div', 'cafe-details-body')

    const facts = makeElement('dl', 'detail-list')
    if (typeof cafe.typeOfStore === 'string' && cafe.typeOfStore) {
        facts.append(makeDetailRow('Type', document.createTextNode(cafe.typeOfStore)))
    }
    if (typeof cafe.rating === 'number') {
        facts.append(makeDetailRow('Rating', document.createTextNode(`${cafe.rating.toFixed(1)} ★`)))
    }
    if (typeof cafe.priceRange === 'string' && cafe.priceRange) {
        facts.append(makeDetailRow('Price', document.createTextNode(cafe.priceRange)))
    }

    // Contact information
    if (cafe.phoneNo) {
        const phone = formatPhone(cafe.phoneNo)
        const content = phone.href ? makeElement('a', null, phone.display) : document.createTextNode(phone.display)
        if (phone.href) content.href = phone.href
        facts.append(makeDetailRow('Phone', content))
    }
    const website = safeWebLink(cafe.webLink)
    if (website) {
        const link = makeElement('a', null, website.hostname.replace(/^www\./, ''))
        link.href = website.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        facts.append(makeDetailRow('Website', link))
    }
    if (!cafe.phoneNo && !website) {
        facts.append(makeDetailRow('Contact', document.createTextNode('No phone or website listed')))
    }
    const address = getCafeAddress(cafe)
    if (address) {
        facts.append(makeDetailRow('Address', document.createTextNode(address)))
    }
    if (typeof cafe.plusCodes === 'string' && cafe.plusCodes) {
        facts.append(makeDetailRow('Plus code', document.createTextNode(cafe.plusCodes)))
    }
    body.append(facts)

    // Opening hours
    const hoursHeading = makeElement('h4', 'detail-heading', 'Opening hours')
    body.append(hoursHeading)
    const hoursByDay = cafe.hoursByDay && typeof cafe.hoursByDay === 'object' ? cafe.hoursByDay : null
    if (hoursByDay && WEEKDAYS.some(([day]) => hoursByDay[day])) {
        const today = torontoWeekday()
        const hours = makeElement('dl', 'hours-list')
        for (const [day, label] of WEEKDAYS) {
            const row = makeDetailRow(label, document.createTextNode(formatHours(hoursByDay[day])))
            if (day === today) {
                row.classList.add('is-today')
                row.querySelector('dt').append(makeElement('span', 'today-label', ' (today)'))
            }
            hours.append(row)
        }
        body.append(hours)
    } else if (typeof cafe.operatingHoursRaw === 'string' && cafe.operatingHoursRaw) {
        body.append(makeElement('p', 'hours-raw', cafe.operatingHoursRaw))
    } else {
        body.append(makeElement('p', 'hours-raw', 'Opening hours are not listed.'))
    }

    details.append(body)
    return details
}

function replaceCard(cafe, { focus } = {}) {
    const existing = document.getElementById(`cafe-${String(cafe._id)}`)
    if (!existing) return
    cardResizeObserver?.unobserve(existing)
    const card = makeCafeCard(cafe)
    existing.replaceWith(card)
    if (focus) card.querySelector(focus)?.focus()
}

function updateFavoriteButton(button, cafe, isFavorite) {
    const name = getCafeName(cafe)
    button.classList.toggle('is-favorite', isFavorite)
    button.querySelector('img').src = isFavorite ? '/assets/heart-filled.svg' : '/assets/heart-outline.svg'
    button.setAttribute('aria-pressed', String(isFavorite))
    button.setAttribute('aria-label', isFavorite ? `Remove ${name} from favourites` : `Add ${name} to favourites`)
    button.title = isFavorite ? 'Remove from favourites' : 'Add to favourites'
}

// Heart toggle that saves the favourite straight away, without opening the editor.
function makeFavoriteButton(cafe) {
    const cafeId = String(cafe._id)
    const button = makeElement('button', 'favorite-toggle')
    button.type = 'button'
    const icon = document.createElement('img')
    icon.src = '/assets/heart-outline.svg'
    icon.alt = ''
    button.append(icon)
    updateFavoriteButton(button, cafe, Boolean(preferences.get(cafeId)?.favorite))

    button.addEventListener('click', async () => {
        const previous = { ...emptyPreference(cafeId), ...preferences.get(cafeId) }
        const nextFavorite = !previous.favorite
        const body = {
            ...Object.fromEntries(RATING_FIELDS.map(({ field }) => [field, previous[field] ?? null])),
            favorite: nextFavorite,
            recommend: previous.recommend ?? null,
            personalNotes: previous.personalNotes ?? ''
        }

        button.disabled = true
        updateFavoriteButton(button, cafe, nextFavorite)
        let addedToList = false
        try {
            if (!isInPersonalCollection(cafeId)) {
                await requestJson(`/api/collection/${encodeURIComponent(cafeId)}`, { method: 'POST' })
                preferences.set(cafeId, emptyPreference(cafeId))
                savedCafes.set(cafeId, cafe)
                savedCafesLoaded = true
                addedToList = true
            }

            const saved = await requestJson(`/api/preferences/${encodeURIComponent(cafeId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            preferences.set(cafeId, { ...(preferences.get(cafeId) ?? {}), ...saved })
            syncSavedMarkers()
            const message = nextFavorite
                ? `${getCafeName(cafe)} was added to your favourites.`
                : `${getCafeName(cafe)} was removed from your favourites.`
            if (addedToList) {
                cardMessages.set(cafeId, message)
                replaceCard(cafe)
                return
            }
            if (currentFilter === 'favorite' && !nextFavorite && !openEditors.has(cafeId)) {
                renderCafes(message)
                return
            }
            const status = document.getElementById(`cafe-${cafeId}`)?.querySelector('[role="status"]')
            if (status) status.textContent = message
        } catch (error) {
            const current = { ...emptyPreference(cafeId), ...preferences.get(cafeId) }
            updateFavoriteButton(button, cafe, current.favorite)
            if (addedToList) {
                cardMessages.set(cafeId, error.message)
                replaceCard(cafe)
                return
            }
            const status = document.getElementById(`cafe-${cafeId}`)?.querySelector('[role="status"]')
            if (status) status.textContent = error.message
        } finally {
            button.disabled = false
        }
    })

    return button
}

function makeCafeCard(cafe) {
    const cafeId = String(cafe._id)
    const inList = isInPersonalCollection(cafeId)
    const preference = { ...emptyPreference(cafeId), ...preferences.get(cafeId) }
    const card = makeElement('article', inList ? 'cafe-card is-in-list' : 'cafe-card')
    card.id = `cafe-${cafeId}`
    card.tabIndex = -1
    cardResizeObserver?.observe(card)

    const topLine = makeElement('div', 'card-topline')
    topLine.append(makeFavoriteButton(cafe))
    if (inList) topLine.append(makeBadges(preference))

    const title = makeElement('h3', null, getCafeName(cafe))
    title.id = `cafe-${cafeId}-title`
    card.append(topLine, title)

    const address = getCafeAddress(cafe)
    if (address) {
        card.append(makeElement('p', 'cafe-address', address))
    }

    const cardActions = makeElement('div', 'card-actions')
    const mapButton = makeElement('button', 'map-link card-map-button')
    const arrow = makeElement('img', 'map-button-arrow')
    arrow.src = '/assets/arrow.svg'
    arrow.alt = ''
    mapButton.append(arrow, document.createTextNode('Show on Map'))
    mapButton.type = 'button'
    mapButton.disabled = !canShowCafeOnMap(cafe)
    mapButton.addEventListener('click', async () => {
        mapButton.disabled = true
        mapStatus.textContent = `Finding ${getCafeName(cafe)}…`
        try {
            await showCafeOnMap(cafe)
        } catch (error) {
            mapStatus.textContent = error.message
        } finally {
            mapButton.disabled = !canShowCafeOnMap(cafe)
        }
    })
    cardActions.append(mapButton)

    if (typeof cafe.description === 'string' && cafe.description) {
        card.append(makeElement('p', 'cafe-notes', cafe.description))
    }

    const details = makeCafeDetails(cafe)
    card.append(cardActions, details)
    card.classList.toggle('has-open-details', details.open)

    const status = makeStatus()
    const message = cardMessages.get(cafeId)
    if (message) {
        status.textContent = message
        cardMessages.delete(cafeId)
    }

    if (!inList) {
        const addButton = makeElement('button', 'primary-button add-button', 'Add to List')
        addButton.type = 'button'
        addButton.addEventListener('click', async () => {
            addButton.disabled = true
            status.textContent = 'Adding to your list…'
            try {
                await requestJson(`/api/collection/${encodeURIComponent(cafeId)}`, { method: 'POST' })
                preferences.set(cafeId, emptyPreference(cafeId))
                savedCafes.set(cafeId, cafe)
                failedLocations.delete(cafeId)
                syncSavedMarkers()
                describeMap()
                openEditors.add(cafeId)
                cardMessages.set(cafeId, 'Added to your list. Rate it below, then save.')
                replaceCard(cafe, { focus: 'select' })
            } catch (error) {
                status.textContent = error.message
                addButton.disabled = false
            }
        })
        cardActions.append(addButton)
        card.append(status)
        return card
    }

    const profile = makeElement('section', 'cafe-profile')
    profile.setAttribute('aria-label', `Your review of ${getCafeName(cafe)}`)

    if (openEditors.has(cafeId)) {
        profile.append(makePreferenceForm(cafe, preference, status), status)
        card.append(profile)
        return card
    }

    profile.append(makePreferenceSummary(preference))

    const actions = makeElement('div', 'form-actions profile-actions')
    const editButton = makeElement('button', 'primary-button edit-button', 'Edit')
    editButton.type = 'button'
    editButton.setAttribute('aria-label', `Edit your review of ${getCafeName(cafe)}`)
    editButton.addEventListener('click', () => {
        openEditors.add(cafeId)
        replaceCard(cafe, { focus: 'select' })
    })

    const deleteButton = makeElement('button', 'secondary-button danger-button', 'Delete')
    deleteButton.type = 'button'
    deleteButton.setAttribute('aria-label', `Delete ${getCafeName(cafe)} from your list`)
    deleteButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
            `Delete ${getCafeName(cafe)} from your list?\n\nThis permanently erases its ratings, notes, favourite and recommendation.`
        )
        if (!confirmed) return

        deleteButton.disabled = true
        editButton.disabled = true
        status.textContent = 'Deleting…'
        try {
            await requestJson(`/api/collection/${encodeURIComponent(cafeId)}`, { method: 'DELETE' })
            preferences.delete(cafeId)
            savedCafes.delete(cafeId)
            failedLocations.delete(cafeId)
            openEditors.delete(cafeId)
            renderCafes(`${getCafeName(cafe)} was deleted from your list.`)
        } catch (error) {
            status.textContent = error.message
            deleteButton.disabled = false
            editButton.disabled = false
        }
    })

    actions.append(deleteButton, editButton)
    profile.append(actions, status)
    card.append(profile)
    return card
}

const listFilters = {
    all: () => true,
    saved: cafe => isInPersonalCollection(String(cafe._id)),
    favorite: cafe => {
        const cafeId = String(cafe._id)
        return isInPersonalCollection(cafeId) && preferences.get(cafeId)?.favorite === true
    }
}

function compareByName(a, b) {
    return getCafeName(a).localeCompare(getCafeName(b))
}

function renderCafes(announcement = '') {
    let visibleCafes = currentSelectedCafeId
        ? currentCafes.filter(cafe => String(cafe._id) === currentSelectedCafeId)
        : currentCafes

    const matches = listFilters[currentFilter] ?? listFilters.all
    visibleCafes = visibleCafes.filter(matches)
    if (currentFilter !== 'all') {
        visibleCafes.sort(compareByName)
    }

    const prefix = announcement ? `${announcement} ` : ''
    cardResizeObserver?.disconnect()
    if (visibleCafes.length === 0) {
        cafeList.replaceChildren()
        loadMoreButton.hidden = true
        updateMap([])
        const noResultsMessage = currentQuery
            ? currentFilter === 'saved'
                ? 'No saved cafés match that search.'
                : currentFilter === 'favorite'
                    ? 'No favourite cafés match that search.'
                    : 'No cafés match that search. Try another name.'
            : currentFilter === 'saved'
                ? 'You have no saved cafés yet. Add cafés to your list to see them here.'
                : currentFilter === 'favorite'
                    ? 'No cafés are marked as favourites yet. Use a heart to add one.'
                    : 'No cafés are available right now.'
        listStatus.textContent = prefix + noResultsMessage
        return
    }

    const matchingCount = visibleCafes.length
    const pageCafes = visibleCafes.slice(0, visibleCafeCount)
    loadMoreButton.hidden = pageCafes.length >= matchingCount
    const resultLabel = currentFilter === 'saved'
        ? 'saved cafés'
        : currentFilter === 'favorite' ? 'favourite cafés' : 'cafés found'
    listStatus.textContent = prefix
        + `Showing ${pageCafes.length} of ${matchingCount} ${resultLabel}.${currentQuery && currentFilter === 'all' ? ' Add any of them to your list.' : ''}`
    loadMoreButton.setAttribute('aria-label', 'Load the next 9 cafes')
    cafeList.replaceChildren(...pageCafes.map(makeCafeCard))
    updateMap(pageCafes)
}

async function loadCafes(terms = '', selectedCafeId = '', { showSuggestions = false } = {}) {
    const requestId = ++cafeLoadRequestId
    const query = terms.trim()
    listStatus.textContent = query
        ? 'Searching cafés…'
        : 'Loading cafés…'
    cafeList.replaceChildren()
    loadMoreButton.hidden = true
    if (!query || !showSuggestions) hideSearchSuggestions()
    const url = query
        ? `/api/cafes/search?terms=${encodeURIComponent(query)}`
        : '/api/cafes'

    try {
        const needSavedCafes = !savedCafesLoaded
        const [cafes, savedPreferences, listedCafes] = await Promise.all([
            requestJson(url),
            requestJson('/api/preferences'),
            needSavedCafes ? requestJson('/api/collection') : null
        ])
        if (requestId !== cafeLoadRequestId) return

        if (showSuggestions && searchInput.value.trim() === query) {
            showSearchSuggestions(cafes)
        }

        preferences.clear()
        for (const preference of savedPreferences) {
            preferences.set(preference.cafeId, preference)
        }

        if (listedCafes) {
            savedCafes.clear()
            for (const cafe of listedCafes) savedCafes.set(String(cafe._id), cafe)
            savedCafesLoaded = true
        }

        if (!query) allCafes = cafes
        currentCafes = cafes
        currentQuery = query
        currentSelectedCafeId = selectedCafeId
        visibleCafeCount = PAGE_SIZE
        renderCafes()
        if (selectedCafeId) {
            document.getElementById(`cafe-${selectedCafeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
    } catch (error) {
        if (requestId !== cafeLoadRequestId) return
        listStatus.textContent = error.message
        if (cafeMap && savedMarkers.size === 0) mapStatus.textContent = `Unable to load cafe locations: ${error.message}`
        if (showSuggestions && searchInput.value.trim() === query) {
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

function setFilter(filter) {
    currentFilter = listFilters[filter] ? filter : 'all'
    for (const button of filterButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.filter === currentFilter))
    }
}

function setMapPinFilter(filter, { moveMap = true } = {}) {
    mapPinFilter = ['saved', 'favorite'].includes(filter) ? filter : 'all'
    for (const button of mapFilterButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.mapFilter === mapPinFilter))
    }
    syncSavedMarkers()
    for (const marker of resultMarkers.values()) {
        setMarkerVisibility(marker, mapPinFilter === 'all')
    }
    if (!moveMap) return
    if (mapPinFilter === 'all') showDowntown()
    else fitMapToPins()
}

for (const button of filterButtons) {
    button.addEventListener('click', () => {
        if (button.dataset.filter === currentFilter) return
        setFilter(button.dataset.filter)
        visibleCafeCount = PAGE_SIZE
        currentSelectedCafeId = ''
        renderCafes()
    })
}

for (const button of mapFilterButtons) {
    button.addEventListener('click', () => setMapPinFilter(button.dataset.mapFilter))
}

loadMoreButton.addEventListener('click', () => {
    visibleCafeCount += PAGE_SIZE
    renderCafes()
})

backToTopButton.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
})

initializeMap()
loadCafes()