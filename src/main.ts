// @deno-types="npm:@types/leaflet@^1.9.14"
import leaflet from "leaflet";

// Style sheets
import "leaflet/dist/leaflet.css";
import "./style.css";

// Fix missing marker images
import "./leafletWorkaround.ts";

// Deterministic random number generator
import luck from "./luck.ts";

/**
 * --------------------------------------------------------------------------------
 * 1) FLYWEIGHT + GLOBAL COORDINATES
 *
 * Maintain a cache of {i, j} cells so that repeated requests for the same
 * latitude–longitude pair return the same cell object (Flyweight pattern).
 *
 * (multiplying lat/lng by 1e4, then flooring to integer).
 * --------------------------------------------------------------------------------
 */

const cellFlyweightCache = new Map<string, { i: number; j: number }>();

/** Converts (lat, lng) to a globally unique cell, using a flyweight cache. */
function getOrCreateCell(lat: number, lng: number): { i: number; j: number } {
  const i = Math.floor(lat * 1e4);
  const j = Math.floor(lng * 1e4);
  const key = `${i},${j}`;
  if (!cellFlyweightCache.has(key)) {
    cellFlyweightCache.set(key, { i, j });
  }
  return cellFlyweightCache.get(key)!;
}

/**
 * Each cell is 0.0001 degrees in size.
 */
function cellToLatLngBounds(i: number, j: number): leaflet.LatLngBounds {
  return leaflet.latLngBounds([
    [i / 1e4, j / 1e4],
    [(i + 1) / 1e4, (j + 1) / 1e4],
  ]);
}

/**
 * --------------------------------------------------------------------------------
 * 2) MEMENTO FOR CACHE STATE
 *
 * --------------------------------------------------------------------------------
 */
interface CacheMemento {
  i: number;
  j: number;
  pointValue: number; // Current "value" of the cache
  nextCoinSerial: number; // How many coins have been harvested so far
  rectangle?: leaflet.Rectangle; // Leaflet rectangle if currently added to the map
}

const cacheMementos = new Map<string, CacheMemento>();

function getCacheKey(i: number, j: number): string {
  return `${i},${j}`;
}

/** Retrieve or create a memento for a given cell. */
function getOrCreateCacheMemento(i: number, j: number): CacheMemento {
  const key = getCacheKey(i, j);
  if (!cacheMementos.has(key)) {
    // Brand-new cache: pick a random initial pointValue
    const pointValue = Math.floor(
      luck([i, j, "initialValue"].toString()) * 100,
    );
    cacheMementos.set(key, {
      i,
      j,
      pointValue,
      nextCoinSerial: 0,
      rectangle: undefined,
    });
  }
  return cacheMementos.get(key)!;
}

/**
 * --------------------------------------------------------------------------------
 *
 * Gameplay material starting here.
 * 3. Gameplay setting
 * --------------------------------------------------------------------------------
 */

// Location of our classroom (as identified on Google Maps)
const OAKES_CLASSROOM = leaflet.latLng(36.98949379578401, -122.06277128548504);

// Convert that lat/lng to our global cell coordinates
//const oakesCell = getOrCreateCell(OAKES_CLASSROOM.lat, OAKES_CLASSROOM.lng);

// Tunable gameplay parameters
const GAMEPLAY_ZOOM_LEVEL = 19;
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;
const MOVEMENT_DELTA = 0.01; // Degrees to move per arrow click

// Create the map (element with id "map" is defined in index.html)
const map = leaflet.map(document.getElementById("map")!, {
  center: OAKES_CLASSROOM,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
  scrollWheelZoom: false,
});

// Populate the map with a background tile layer
leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

// Track the player's current position in lat/lng
let playerLat = OAKES_CLASSROOM.lat;
let playerLng = OAKES_CLASSROOM.lng;

// Add a marker to represent the player
const playerMarker = leaflet.marker(OAKES_CLASSROOM);
playerMarker.bindTooltip("That's you!");
playerMarker.addTo(map);

// Display the player's points
let playerPoints = 0;
const statusPanel = document.querySelector<HTMLDivElement>("#statusPanel")!; // element `statusPanel` is defined in index.html
statusPanel.innerHTML = "No points yet...";

/**
 * spawnOrRestoreCache
 *
 * If the cell’s cache already exists in memento and is visible,
 * do nothing. Otherwise, create a new rectangle and associate it with
 * that cell’s memento.
 */
function spawnOrRestoreCache(i: number, j: number) {
  const memento = getOrCreateCacheMemento(i, j);

  if (memento.rectangle) return;

  const bounds = cellToLatLngBounds(i, j);
  const rect = leaflet.rectangle(bounds);
  rect.addTo(map);
  memento.rectangle = rect;

  // Bind a popup that uses the memento’s state
  rect.bindPopup(() => {
    const popupDiv = document.createElement("div");

    // Show the current pointValue
    popupDiv.innerHTML = `
      <div>
        Cache at cell {i=${i}, j=${j}} has value 
        <span id="value">${memento.pointValue}</span>.
      </div>
      <button id="poke">poke</button>`;

    // Poke button logic
    popupDiv
      .querySelector<HTMLButtonElement>("#poke")!
      .addEventListener("click", () => {
        memento.pointValue--;
        popupDiv.querySelector<HTMLSpanElement>("#value")!.innerHTML = memento
          .pointValue.toString();

        playerPoints++;
        statusPanel.innerHTML = `${playerPoints} points accumulated`;

        // Generate a new coin ID
        const coinId = { i, j, serial: memento.nextCoinSerial++ };
        console.log("Player picked up coin:", coinId);
      });

    return popupDiv;
  });
}

/**
 * removeCacheIfVisible
 *
 * Remove the rectangle from the map (if it exists)
 */
function removeCacheIfVisible(i: number, j: number) {
  const key = getCacheKey(i, j);
  const memento = cacheMementos.get(key);
  if (memento && memento.rectangle) {
    // Remove from map
    memento.rectangle.remove();
    memento.rectangle = undefined;
  }
}

/**
 * updateVisibleCaches
 */
function updateVisibleCaches() {
  // Convert the player's lat/lng to cell coords
  const playerCell = getOrCreateCell(playerLat, playerLng);

  // 1) Build a set of all cells that SHOULD be visible
  const visibleKeys = new Set<string>();
  for (let di = -NEIGHBORHOOD_SIZE; di <= NEIGHBORHOOD_SIZE; di++) {
    for (let dj = -NEIGHBORHOOD_SIZE; dj <= NEIGHBORHOOD_SIZE; dj++) {
      const cellI = playerCell.i + di;
      const cellJ = playerCell.j + dj;

      // If luck is under threshold, this cell *might* have a cache
      // Instead,check if it was "rolled" lucky or not.
      // If the luck < spawn probability,spawn it (if not already).
      if (luck([cellI, cellJ].toString()) < CACHE_SPAWN_PROBABILITY) {
        // Mark that cell as visible
        visibleKeys.add(getCacheKey(cellI, cellJ));
        spawnOrRestoreCache(cellI, cellJ);
      }
    }
  }

  //Remove from map any rectangle NOT in the visible set
  for (const [key, memento] of cacheMementos) {
    if (memento.rectangle && !visibleKeys.has(key)) {
      removeCacheIfVisible(memento.i, memento.j);
    }
  }
}

/**
 * movePlayer
 *
 * Moves the player by a given delta in lat/lng, repositions the marker,
 * and updates visible caches.
 */
function movePlayer(dLat: number, dLng: number) {
  playerLat += dLat;
  playerLng += dLng;

  // Update the marker
  playerMarker.setLatLng([playerLat, playerLng]);

  // Optionally center the map on the new position
  map.panTo([playerLat, playerLng]);

  // Update visible caches
  updateVisibleCaches();
}

/**
 * --------------------------------------------------------------------------------
 * 4. SET UP BUTTONS FOR PLAYER MOVEMENT
 *
 * --------------------------------------------------------------------------------
 */
document
  .querySelector<HTMLButtonElement>("#north")!
  .addEventListener("click", () => movePlayer(MOVEMENT_DELTA, 0));

document
  .querySelector<HTMLButtonElement>("#south")!
  .addEventListener("click", () => movePlayer(-MOVEMENT_DELTA, 0));

document
  .querySelector<HTMLButtonElement>("#east")!
  .addEventListener("click", () => movePlayer(0, MOVEMENT_DELTA));

document
  .querySelector<HTMLButtonElement>("#west")!
  .addEventListener("click", () => movePlayer(0, -MOVEMENT_DELTA));

// "reset" to return to OAKES_CLASSROOM
document
  .querySelector<HTMLButtonElement>("#reset")!
  .addEventListener("click", () => {
    playerLat = OAKES_CLASSROOM.lat;
    playerLng = OAKES_CLASSROOM.lng;
    playerMarker.setLatLng([playerLat, playerLng]);
    updateVisibleCaches();
  });

document
  .querySelector<HTMLButtonElement>("#sensor")!
  .addEventListener("click", () => {
    alert("Sensor button clicked (not implemented).");
  });

/**
 * Initialize the map once at game start.
 */
updateVisibleCaches();
