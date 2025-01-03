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
 * Given global cell coordinates (i, j), figure out its bounding box in lat/lng.
 */
function cellToLatLngBounds(i: number, j: number): leaflet.LatLngBounds {
  return leaflet.latLngBounds([
    [i / 1e4, j / 1e4],
    [(i + 1) / 1e4, (j + 1) / 1e4],
  ]);
}

/**
 * --------------------------------------------------------------------------------
 *
 * Assign each coin a unique ID based on the cell {i, j} from which it was
 * spawned.
 * --------------------------------------------------------------------------------
 */
const coinSerialMap = new Map<string, number>();

/** Returns the next available serial number for a coin in the given cell. */
function getNextCoinSerial(i: number, j: number): number {
  const key = `${i},${j}`;
  const nextSerial = coinSerialMap.get(key) ?? 0;
  coinSerialMap.set(key, nextSerial + 1);
  return nextSerial;
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
const oakesCell = getOrCreateCell(OAKES_CLASSROOM.lat, OAKES_CLASSROOM.lng);

// Tunable gameplay parameters
const GAMEPLAY_ZOOM_LEVEL = 19;
const NEIGHBORHOOD_SIZE = 8;
const CACHE_SPAWN_PROBABILITY = 0.1;

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

// Add a marker to represent the player
const playerMarker = leaflet.marker(OAKES_CLASSROOM);
playerMarker.bindTooltip("That's you!");
playerMarker.addTo(map);

// Display the player's points
let playerPoints = 0;
const statusPanel = document.querySelector<HTMLDivElement>("#statusPanel")!; // element `statusPanel` is defined in index.html
statusPanel.innerHTML = "No points yet...";

/**
 * Spawns a “cache” (rectangle) at global cell coordinates (i, j).
 */
function spawnCache(i: number, j: number) {
  // The lat/lng bounds of this cell
  const bounds = cellToLatLngBounds(i, j);

  // Add a rectangle for the cache
  const rect = leaflet.rectangle(bounds);
  rect.addTo(map);

  // Handle interactions with the cache
  rect.bindPopup(() => {
    // Random point value for this cache
    let pointValue = Math.floor(luck([i, j, "initialValue"].toString()) * 100);

    // Create the popup content
    const popupDiv = document.createElement("div");
    popupDiv.innerHTML = `
      <div>Cache at cell {i=${i}, j=${j}} has value <span id="value">${pointValue}</span>.</div>
      <button id="poke">poke</button>`;

    // When "poke" is clicked, we decrement the cache value by 1 and
    // give 1 point to the player. We also generate a unique coin ID.
    popupDiv
      .querySelector<HTMLButtonElement>("#poke")!
      .addEventListener("click", () => {
        pointValue--;
        popupDiv.querySelector<HTMLSpanElement>("#value")!.innerHTML =
          pointValue.toString();
        playerPoints++;
        statusPanel.innerHTML = `${playerPoints} points accumulated`;

        // Generate a new coin ID for the coin being “harvested”
        const serial = getNextCoinSerial(i, j);
        const coinId = { i, j, serial };
        console.log("Player picked up coin:", coinId);
      });

    return popupDiv;
  });
}

/**
 * Loop over the player's “neighborhood” in terms of global cell coordinates.
 */
for (let di = -NEIGHBORHOOD_SIZE; di < NEIGHBORHOOD_SIZE; di++) {
  for (let dj = -NEIGHBORHOOD_SIZE; dj < NEIGHBORHOOD_SIZE; dj++) {
    const cellI = oakesCell.i + di;
    const cellJ = oakesCell.j + dj;

    // If luck is under a threshold, spawn a cache
    if (luck([cellI, cellJ].toString()) < CACHE_SPAWN_PROBABILITY) {
      spawnCache(cellI, cellJ);
    }
  }
}
