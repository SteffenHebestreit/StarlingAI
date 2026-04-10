import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";

const log = childLogger("tool:navigation");

const NAVIGATION_USER_AGENT = "StarlingAI/0.5.0 (navigation tools)";
const GEOCODE_TIMEOUT_MS = 15_000;
const ROUTE_TIMEOUT_MS = 20_000;

type TravelMode = "car" | "walking";

interface GeocodeAddress {
  houseNumber?: string;
  road?: string;
  postcode?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
  countryCode?: string;
}

interface GeocodeCandidate {
  displayName: string;
  lat: number;
  lon: number;
  importance?: number;
  class?: string;
  type?: string;
  address?: GeocodeAddress;
}

interface ParsedGeocodeQuery {
  street?: string;
  houseNumber?: string;
  postcode?: string;
}

registerTool({
  name: "geocode_location",
  description: "Resolve a place name or street address to geographic coordinates using OpenStreetMap Nominatim. Returns multiple candidates when the query is ambiguous.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Place name, address, or landmark to resolve" },
      limit: { type: "number", description: "Maximum number of candidates to return (1-5)", default: 3 },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    const limit = Math.min(5, Math.max(1, Number(args["limit"] ?? 3)));

    if (query.length < 3) {
      return { success: false, output: "", error: "Query must be at least 3 characters long." };
    }

    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("addressdetails", "1");

      const response = await fetchWithTimeout(url.toString(), GEOCODE_TIMEOUT_MS, {
        headers: {
          "User-Agent": NAVIGATION_USER_AGENT,
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        return { success: false, output: "", error: `Geocoding failed with HTTP ${response.status}.` };
      }

      const body = await response.json() as Array<Record<string, unknown>>;
      const rawCandidates = body
        .map((entry): GeocodeCandidate | null => {
          const lat = Number(entry["lat"]);
          const lon = Number(entry["lon"]);
          const displayName = String(entry["display_name"] ?? "").trim();
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !displayName) return null;
          const address = readGeocodeAddress(entry["address"]);
          return {
            displayName,
            lat,
            lon,
            importance: typeof entry["importance"] === "number" ? entry["importance"] : undefined,
            class: typeof entry["class"] === "string" ? entry["class"] : undefined,
            type: typeof entry["type"] === "string" ? entry["type"] : undefined,
            address,
          };
        })
        .filter((entry): entry is GeocodeCandidate => entry !== null);

      const candidates = dedupeGeocodeCandidates(rawCandidates);
      const parsedQuery = parseGeocodeQuery(query);
      const exactCandidates = candidates.filter((candidate) => candidateMatchesParsedQuery(candidate, parsedQuery));

      if (candidates.length === 0) {
        return {
          success: true,
          output: `No OpenStreetMap matches were found for "${query}". Ask the user for a more specific address or nearby landmark.`,
          metadata: { query, candidates: [], ambiguous: false },
        };
      }

      if (exactCandidates.length === 0 && hasExactAddressHints(parsedQuery)) {
        const formattedClosest = formatCandidates(candidates);
        return {
          success: true,
          output: [
            `No exact OpenStreetMap matches were found for "${query}".`,
            "The closest candidates do not match all requested address parts such as street or postcode.",
            "Closest candidates:",
            "",
            formattedClosest,
          ].join("\n"),
          metadata: {
            query,
            candidates,
            ambiguous: false,
            exactMatch: false,
          },
        };
      }

      const selectedCandidates = exactCandidates.length > 0 ? exactCandidates : candidates;

      const formatted = formatCandidates(selectedCandidates);

      const ambiguous = selectedCandidates.length > 1;
      const prefix = ambiguous
        ? `Multiple matches were found for "${query}". Use the best candidate or ask the user to clarify:`
        : `Resolved "${query}" to:`;

      return {
        success: true,
        output: `${prefix}\n\n${formatted}`,
        metadata: {
          query,
          candidates: selectedCandidates,
          ambiguous,
          exactMatch: exactCandidates.length > 0,
        },
      };
    } catch (err) {
      log.error({ err, query }, "geocode_location failed");
      return { success: false, output: "", error: `Geocoding failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "route_distance_time",
  description: "Calculate route distance and estimated travel time between two coordinates using OSRM for car or walking mode.",
  parameters: {
    type: "object",
    properties: {
      fromLat: { type: "number", description: "Origin latitude" },
      fromLon: { type: "number", description: "Origin longitude" },
      toLat: { type: "number", description: "Destination latitude" },
      toLon: { type: "number", description: "Destination longitude" },
      mode: { type: "string", enum: ["car", "walking"], description: "Travel mode" },
    },
    required: ["fromLat", "fromLon", "toLat", "toLon", "mode"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const fromLat = Number(args["fromLat"]);
    const fromLon = Number(args["fromLon"]);
    const toLat = Number(args["toLat"]);
    const toLon = Number(args["toLon"]);
    const mode = String(args["mode"] ?? "") as TravelMode;

    if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) {
      return { success: false, output: "", error: "All coordinates must be finite numbers." };
    }
    if (!isValidLatitude(fromLat) || !isValidLatitude(toLat) || !isValidLongitude(fromLon) || !isValidLongitude(toLon)) {
      return { success: false, output: "", error: "Coordinates are out of range." };
    }
    if (mode !== "car" && mode !== "walking") {
      return { success: false, output: "", error: "Mode must be either 'car' or 'walking'." };
    }

    const profile = mode === "car" ? "driving" : "walking";
    const coordinatePair = `${fromLon},${fromLat};${toLon},${toLat}`;
    const url = `https://router.project-osrm.org/route/v1/${profile}/${coordinatePair}?overview=false&steps=false`;

    try {
      const response = await fetchWithTimeout(url, ROUTE_TIMEOUT_MS, {
        headers: {
          "User-Agent": NAVIGATION_USER_AGENT,
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        return { success: false, output: "", error: `Routing failed with HTTP ${response.status}.` };
      }

      const body = await response.json() as {
        code?: string;
        routes?: Array<{ distance?: number; duration?: number }>;
        message?: string;
      };

      if (body.code !== "Ok" || !body.routes?.length) {
        const message = body.message ? ` ${body.message}` : "";
        return { success: false, output: "", error: `Routing failed.${message}`.trim() };
      }

      const route = body.routes[0]!;
      const distanceMeters = Number(route.distance ?? NaN);
      const durationSeconds = Number(route.duration ?? NaN);
      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        return { success: false, output: "", error: "Routing service returned incomplete route data." };
      }

      return {
        success: true,
        output: [
          `Mode: ${mode}`,
          `Distance: ${formatDistance(distanceMeters)}`,
          `Estimated travel time: ${formatDuration(durationSeconds)}`,
          `Origin coordinates: ${fromLat.toFixed(6)}, ${fromLon.toFixed(6)}`,
          `Destination coordinates: ${toLat.toFixed(6)}, ${toLon.toFixed(6)}`,
        ].join("\n"),
        metadata: {
          mode,
          distanceMeters,
          durationSeconds,
          profile,
        },
      };
    } catch (err) {
      log.error({ err, fromLat, fromLon, toLat, toLon, mode }, "route_distance_time failed");
      return { success: false, output: "", error: `Routing failed: ${String(err)}` };
    }
  },
});

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isValidLatitude(value: number): boolean {
  return value >= -90 && value <= 90;
}

function isValidLongitude(value: number): boolean {
  return value >= -180 && value <= 180;
}

function readGeocodeAddress(value: unknown): GeocodeAddress | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Record<string, unknown>;
  const address: GeocodeAddress = {
    houseNumber: readString(source, "house_number"),
    road: readString(source, "road"),
    postcode: readString(source, "postcode"),
    city: readString(source, "city"),
    town: readString(source, "town"),
    village: readString(source, "village"),
    municipality: readString(source, "municipality"),
    county: readString(source, "county"),
    state: readString(source, "state"),
    country: readString(source, "country"),
    countryCode: readString(source, "country_code"),
  };

  return Object.values(address).some(Boolean) ? address : undefined;
}

function parseGeocodeQuery(query: string): ParsedGeocodeQuery {
  const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
  const firstPart = parts[0] ?? query;
  const postcode = query.match(/\b\d{5}\b/)?.[0];
  const houseNumber = firstPart.match(/\b\d+[a-zA-Z]?\b/)?.[0];
  const street = normalizeAddressText(firstPart.replace(/\b\d+[a-zA-Z]?\b/g, " "));

  return {
    street: street || undefined,
    houseNumber,
    postcode,
  };
}

function candidateMatchesParsedQuery(candidate: GeocodeCandidate, query: ParsedGeocodeQuery): boolean {
  if (!hasExactAddressHints(query)) return true;

  const candidatePostcode = candidate.address?.postcode?.trim();
  if (query.postcode && candidatePostcode && candidatePostcode !== query.postcode) {
    return false;
  }

  const candidateHouseNumber = candidate.address?.houseNumber?.trim().toLowerCase();
  if (query.houseNumber && candidateHouseNumber && candidateHouseNumber !== query.houseNumber.toLowerCase()) {
    return false;
  }

  if (query.street) {
    const candidateRoad = normalizeAddressText(candidate.address?.road ?? candidate.displayName);
    if (!candidateRoad || (!candidateRoad.includes(query.street) && !query.street.includes(candidateRoad))) {
      return false;
    }
  }

  return true;
}

function hasExactAddressHints(query: ParsedGeocodeQuery): boolean {
  return Boolean(query.street || query.houseNumber || query.postcode);
}

function formatCandidates(candidates: GeocodeCandidate[]): string {
  return candidates.map((candidate, index) => {
    const details = [candidate.class, candidate.type].filter(Boolean).join(" / ");
    const detailSuffix = details ? ` (${details})` : "";
    const postcodeSuffix = candidate.address?.postcode ? `, postcode=${candidate.address.postcode}` : "";
    return `${index + 1}. ${candidate.displayName}${detailSuffix}\n   lat=${candidate.lat.toFixed(6)}, lon=${candidate.lon.toFixed(6)}${postcodeSuffix}`;
  }).join("\n\n");
}

function dedupeGeocodeCandidates(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  const seen = new Set<string>();
  const deduped: GeocodeCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.displayName}|${candidate.lat.toFixed(6)}|${candidate.lon.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function normalizeAddressText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatDistance(distanceMeters: number): string {
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }
  return `${(distanceMeters / 1000).toFixed(distanceMeters >= 10_000 ? 0 : 1)} km`;
}

function formatDuration(durationSeconds: number): string {
  if (durationSeconds < 60) {
    return `${Math.round(durationSeconds)} s`;
  }

  const totalMinutes = Math.round(durationSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} h`;
  }
  return `${hours} h ${minutes} min`;
}

export { formatDistance, formatDuration };